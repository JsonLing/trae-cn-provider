// openai-server.js - OpenAI 兼容层（/v1/models, /v1/chat/completions）
import http from 'node:http';
import crypto from 'node:crypto';
import { detectEnv, loadCredentials, saveCredentials } from './env.js';
import { needsRefresh, refreshToken } from './trae-auth.js';
import { chat, listModels, toTraeMessages } from './trae-client.js';

const CATALOG_TTL_MS = 60 * 60 * 1000;
const CATALOG_RETRY_MS = 5 * 60 * 1000;

export class TraeProvider {
  constructor({ env = detectEnv(), credentials = null, logger = console } = {}) {
    this.env = env;
    this.creds = credentials;
    this.logger = logger;
    this.catalog = null;
    this.catalogAt = 0;
    this.catalogError = null;
    this.refreshing = null;
  }

  get ready() {
    return Boolean(this.creds?.refreshToken);
  }

  /** 过期前刷新；并发调用共享同一个刷新过程 */
  async ensureFresh() {
    if (!this.creds) throw new Error('尚未登录：请先运行 login');
    if (!needsRefresh(this.creds)) return this.creds;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const next = await refreshToken(this.creds, this.env.ideVersion);
        next.userId ||= this.creds.userId;
        next.username ||= this.creds.username;
        next.deviceInfo ||= this.creds.deviceInfo;
        next.privateKeyPem ||= this.creds.privateKeyPem;
        next.clientId ||= this.creds.clientId;
        saveCredentials(next);
        this.creds = next;
        this.logger.info?.('[trae] access token 已刷新');
        return next;
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /** 401 / code 1001 → 强制刷新一次再重试 */
  async withAuthRetry(fn) {
    await this.ensureFresh();
    try {
      return await fn(this.creds);
    } catch (err) {
      const unauthorized = err.httpStatus === 401 || err.code === 1001;
      if (!unauthorized) throw err;
      this.logger.warn?.('[trae] 认证失败，刷新令牌后重试一次');
      this.creds = { ...this.creds, expiresAt: 0 };
      await this.ensureFresh();
      return fn(this.creds);
    }
  }

  async models({ force = false } = {}) {
    const fresh = this.catalog && Date.now() - this.catalogAt < CATALOG_TTL_MS;
    if (fresh && !force) return this.catalog;
    if (this.catalogError && Date.now() - this.catalogAt < CATALOG_RETRY_MS && !force) {
      throw this.catalogError;
    }
    try {
      const models = await this.withAuthRetry((creds) => listModels(creds, this.env));
      this.catalog = models;
      this.catalogAt = Date.now();
      this.catalogError = null;
      return models;
    } catch (err) {
      this.catalogError = err;
      this.catalogAt = Date.now();
      throw err;
    }
  }

  resolveModel(requested) {
    if (!this.catalog?.length) throw new Error('模型目录尚未加载');
    const want = String(requested || '').trim().toLowerCase();
    if (!want || want === 'auto' || want === 'default') return this.catalog[0];
    for (const model of this.catalog) {
      if (model.configName.toLowerCase() === want) return model;
    }
    for (const model of this.catalog) {
      if (model.modelName?.toLowerCase() === want || model.id.toLowerCase() === want) return model;
    }
    for (const model of this.catalog) {
      if (model.name?.toLowerCase() === want) return model;
    }
    for (const model of this.catalog) {
      if (model.configName.toLowerCase().includes(want)) return model;
    }
    return null;
  }
}

function buildTraeBody(payload, caps, stream) {
  const body = {
    messages: toTraeMessages(payload.messages),
    function: caps.function || 'chat_v3',
    stream: true,
    config_name: caps.configName,
    model: caps.modelName || caps.configName,
    model_name: caps.modelName || caps.configName,
    config_source: caps.configSource ?? 1,
    is_custom_model: false,
    provider: caps.provider || '',
    // Enterprise gateways bill a seat per chat session and refuse a
    // session-less call with 4008; consumer gateways ignore the extra field.
    session_id: crypto.randomUUID(),
  };

  const effort = payload.reasoning_effort ?? payload.reasoning?.effort;
  if (effort && caps.supportThinking) {
    const allowed = caps.effortOptions.map((o) => o.toLowerCase());
    if (!allowed.length || allowed.includes(String(effort).toLowerCase())) body.reasoning_effort = String(effort);
  }

  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const converted = [];
  for (const tool of tools) {
    const fn = tool?.function ?? (tool?.name ? tool : null);
    if (!fn?.name) continue;
    converted.push({
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description || '',
        // 上游要求 parameters 是 JSON 字符串
        parameters: typeof fn.parameters === 'string' ? fn.parameters : JSON.stringify(fn.parameters ?? {}),
      },
    });
  }
  if (converted.length && payload.tool_choice !== 'none') {
    body.tools = converted;
    body.tool_choice = 'auto';
  }
  return body;
}

function sseChunk(model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, message, type = 'invalid_request_error') {
  sendJson(res, status, { error: { message, type, code: null } });
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * The bare `(req, res)` request handler.
 *
 * Exported separately from {@link createServer} because a DSH plugin mounts it
 * on the host's own web server instead of listening on a port: the plugin used
 * to hand the `http.Server` instance to `webServer.register()`, which is not
 * callable, so every request died as an opaque 400.
 */
export function createRequestHandler(provider, { apiKey = null, allowOrigins = [] } = {}) {
  const browserOrigins = new Set(
    (Array.isArray(allowOrigins) ? allowOrigins : []).map((value) => String(value ?? '').trim()).filter(Boolean),
  );
  return async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // 不再无条件下发 `Access-Control-Allow-Origin: *`。这个端点只能从挂载它的
    // 那台机器访问，但任何网页都能对 loopback 发请求 —— 而它花的是用户自己的
    // Trae 额度。所以带 `Origin` 头的请求一律拒绝，除非来源被显式允许。
    // Hermes / openai-python / curl 这类服务端客户端不发送 Origin，默认不受影响。
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    if (origin) {
      if (!browserOrigins.has(origin)) {
        return sendError(
          res,
          403,
          `拒绝浏览器来源的请求（Origin: ${origin}）。此端点面向本机 agent / SDK，会消耗你自己的 Trae 额度；确需浏览器直连，请把来源加入 allowBrowserOrigins。`,
          'permission_error',
        );
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' });
      return res.end();
    }
    if (path === '/health') return sendJson(res, 200, { ok: true, loggedIn: provider.ready, source: provider.env.source });

    if (apiKey && path.startsWith('/v1/')) {
      const header = req.headers.authorization || '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-api-key'];
      if (presented !== apiKey) return sendError(res, 401, 'API Key 无效', 'authentication_error');
    }

    try {
      if (req.method === 'GET' && path === '/v1/models') {
        const models = await provider.models();
        return sendJson(res, 200, {
          object: 'list',
          data: models.map((m) => ({
            id: m.configName,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'trae-cn',
            display_name: m.name,
            context_window: m.maxMode ? m.maxContextWindow : m.contextWindow,
            supports_reasoning: m.supportThinking,
            supports_vision: m.vision,
          })),
        });
      }

      if (req.method === 'POST' && path === '/v1/chat/completions') {
        if (!provider.ready) return sendError(res, 503, '尚未登录 Trae 账号', 'service_unavailable');
        const payload = await readBody(req);
        await provider.models();
        const caps = provider.resolveModel(payload.model);
        if (!caps) return sendError(res, 404, `未知模型: ${payload.model}`);
        const wantStream = payload.stream !== false;
        const body = buildTraeBody(payload, caps, wantStream);
        const modelId = caps.configName;

        if (!wantStream) {
          let text = '';
          let reasoning = '';
          const toolCalls = [];
          const result = await provider.withAuthRetry((creds) =>
            chat({
              creds,
              env: provider.env,
              body,
              onEvent: (event) => {
                if (event.type === 'text') text += event.text;
                else if (event.type === 'reason') reasoning += event.text;
                else if (event.type === 'tool') toolCalls.push(event);
              },
            }),
          );
          const message = { role: 'assistant', content: text || null };
          if (reasoning) message.reasoning_content = reasoning;
          if (toolCalls.length) {
            message.tool_calls = toolCalls.map((t) => ({
              id: t.id,
              type: 'function',
              function: { name: t.name, arguments: t.arguments },
            }));
          }
          return sendJson(res, 200, {
            id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : result.finishReason }],
            usage: result.usage || undefined,
          });
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(sseChunk(modelId, { role: 'assistant', content: '' }));

        const abort = new AbortController();
        req.on('close', () => abort.abort());
        try {
          const result = await provider.withAuthRetry((creds) =>
            chat({
              creds,
              env: provider.env,
              body,
              signal: abort.signal,
              onEvent: (event) => {
                if (event.type === 'text') res.write(sseChunk(modelId, { content: event.text }));
                else if (event.type === 'reason') res.write(sseChunk(modelId, { reasoning_content: event.text }));
                else if (event.type === 'tool') {
                  res.write(
                    sseChunk(modelId, {
                      tool_calls: [
                        { index: event.index, id: event.id, type: 'function', function: { name: event.name, arguments: event.arguments } },
                      ],
                    }),
                  );
                }
              },
            }),
          );
          const finish = result.finishReason === 'tool_calls' ? 'tool_calls' : result.finishReason || 'stop';
          if (result.usage) {
            res.write(`data: ${JSON.stringify({ id: 'chatcmpl-usage', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId, choices: [], usage: result.usage })}\n\n`);
          }
          res.write(sseChunk(modelId, {}, finish));
          res.write('data: [DONE]\n\n');
          return res.end();
        } catch (err) {
          if (!abort.signal.aborted) {
            res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'upstream_error' } })}\n\n`);
          }
          return res.end();
        }
      }

      return sendError(res, 404, `未知路径: ${path}`, 'not_found');
    } catch (err) {
      provider.logger.error?.('[trae] 请求失败:', err.message);
      return sendError(res, 502, err.message, 'upstream_error');
    }
  };
}

/** A standalone server, used by the CLI (`serve`) and by tests. */
export function createServer(provider, options = {}) {
  return http.createServer(createRequestHandler(provider, options));
}

export function startServer(provider, { port = 8317, host = '127.0.0.1', apiKey = null, allowOrigins = [] } = {}) {
  const server = createServer(provider, { apiKey, allowOrigins });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${port}` }));
  });
}

export { loadCredentials, saveCredentials };
