// openai-server.js - OpenAI 兼容层（/v1/models, /v1/chat/completions）
import http from 'node:http';
import crypto from 'node:crypto';
import { detectEnv, loadCredentials, saveCredentials } from './env.js';
import { needsRefresh, refreshToken } from './trae-auth.js';
import { chat, listModels, toTraeMessages } from './trae-client.js';
import { STATUS } from './store.js';
import { buildCatalog, catalogEtag } from './codex-catalog.js';
import {
  ResponsesEmitter,
  chatPayloadFromResponses,
  errorCodeOf,
  errorStatusOf,
  errorTypeOf,
  promptTextOf,
} from './responses.js';

const CATALOG_TTL_MS = 60 * 60 * 1000;
const CATALOG_RETRY_MS = 5 * 60 * 1000;

export class TraeProvider {
  /**
   * @param {object} [options]
   * @param {string|null} [options.defaultModel] - what an omitted/`auto` model
   *   resolves to. Without it the catalog's first entry wins, which is the
   *   upstream's ordering, not the operator's intent — and that entry is
   *   `Doubao-Seed-Evolving`, not the DeepSeek model a caller would expect.
   * @param {object<string,string>} [options.aliases] - caller-facing model id ->
   *   a Trae catalog name. Lets a client that hardcodes another provider's slug
   *   (Codex's `deepseek-flash`) reach the equivalent Trae model instead of 404.
   */
  constructor({ env = detectEnv(), credentials = null, logger = console, defaultModel = null, aliases = null } = {}) {
    this.env = env;
    this.creds = credentials;
    this.logger = logger;
    this.catalog = null;
    this.catalogAt = 0;
    this.catalogError = null;
    this.refreshing = null;
    this.defaultModel = defaultModel ? String(defaultModel) : null;
    this.aliases = new Map(
      Object.entries(aliases ?? {}).map(([from, to]) => [String(from).toLowerCase(), String(to)]),
    );
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

  /**
   * Look up a catalog entry by any of its names.
   *
   * @param {string} [requested] - a `config_name`, `model_name`, display name,
  /**
   * Look up a catalog entry by any of its names.
   *
   * @param {string} [requested] - a `config_name`, `model_name`, display name,
   *   or a substring of any of them. Omitted / `auto` / `default` resolve to
   *   the configured default model, then to the catalog's first entry.
   * @returns {object|null}
   */
  resolveModel(requested) {
    if (!this.catalog?.length) throw new Error('模型目录尚未加载');
    const want = String(requested || '').trim().toLowerCase();
    if (!want || want === 'auto' || want === 'default') {
      if (this.defaultModel) {
        const configured = matchModel(this.catalog, this.defaultModel.toLowerCase());
        if (configured) return configured;
        // The configured name may simply not exist in this account's catalog
        // (a model withdrawn upstream, or a typo). Fall back rather than fail
        // every request with a 404 — but say so once, loudly.
        this.logger.warn?.(
          `[trae] defaultModel「${this.defaultModel}」不在当前模型目录里，回退到 ${this.catalog[0].configName}`,
        );
      }
      return this.catalog[0];
    }
    // An alias is tried before the fuzzy matcher: `deepseek-flash` would
    // otherwise substring-match a Trae model with a similar name and silently
    // route to the wrong one.
    const alias = this.aliases?.get(want);
    if (alias) {
      const resolved = matchModel(this.catalog, alias.toLowerCase());
      if (resolved) return resolved;
      this.logger.warn?.(`[trae] 别名「${requested}」指向的${alias}不在模型目录里，回退到原样匹配`);
    }
    return matchModel(this.catalog, want);
  }
}

/**
 * Find one catalog entry by the four names a caller might use, in order of
 * specificity: exact `config_name`, then `model_name`/`id`, then display name,
 * then a substring. Extracted so the default-model path and the explicit-model
 * path cannot drift apart.
 * @param {object[]} catalog
 * @param {string} want - already lowercased.
 * @returns {object|null}
 */
function matchModel(catalog, want) {
  for (const model of catalog) {
    if (model.configName?.toLowerCase() === want) return model;
  }
  for (const model of catalog) {
    if (model.modelName?.toLowerCase() === want || model.id?.toLowerCase() === want) return model;
  }
  for (const model of catalog) {
    if (model.name?.toLowerCase() === want) return model;
  }
  for (const model of catalog) {
    if (model.configName?.toLowerCase().includes(want) || model.name?.toLowerCase().includes(want)) return model;
  }
  return null;
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

/**
 * One Responses-API SSE frame.
 *
 * The `event:` field mirrors `type` because the official OpenAI SDKs dispatch
 * on it, while Codex reads `type` out of the JSON. Sending both keeps the two
 * families of client happy for the cost of one duplicated field.
 */
function sseEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Error body for a rejected request.
 *
 * `code` matters: Codex reads `error.code` out of the JSON body of a non-2xx
 * response and maps a known code to a terminal error instead of a retryable
 * one. Leaving it `null` — as this helper used to — makes a 404 look retryable
 * and burns five backoff attempts before the user sees anything.
 */
function sendError(res, status, message, type = 'invalid_request_error', code = null) {
  sendJson(res, status, { error: { message, type, code } });
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
 *
 * Two authentication modes, chosen by whether a `store` is supplied:
 *
 *   * `store` set   - the gateway mode. A presented key is resolved against the
 *                     `keys` table, its daily cap is enforced, and every chat
 *                     request writes a `usage` row. This is what makes "who
 *                     used how much" answerable.
 *   * `store` unset - the original single-`apiKey` mode, kept for the loopback
 *                     CLI and for the plugin's own mount, where there is no
 *                     database and only one caller exists.
 */
export function createRequestHandler(
  provider,
  { apiKey = null, allowOrigins = [], store = null, now = () => Date.now() } = {},
) {
  const browserOrigins = new Set(
    (Array.isArray(allowOrigins) ? allowOrigins : []).map((value) => String(value ?? '').trim()).filter(Boolean),
  );

  /** Pull the presented credential out of either accepted header. */
  const presentedKey = (req) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    const alternate = req.headers['x-api-key'];
    return typeof alternate === 'string' ? alternate.trim() : '';
  };

  return async function handleRequest(req, res) {
    const startedAt = now();
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

    // ---- authentication -------------------------------------------------
    //
    // A refusal is itself recorded. Without that row, a leaked key being
    // probed from somewhere else leaves no trace, and a colleague whose key was
    // disabled only ever sees "401" with no matching entry in the report.
    let caller = null;
    if (path.startsWith('/v1/')) {
      const presented = presentedKey(req);

      if (store) {
        const auth = store.authenticate(presented);
        if (!auth.ok) {
          const disabled = auth.reason === 'disabled';
          store.record({
            keyId: auth.key?.id ?? '',
            keyLabel: auth.key?.label ?? 'unknown',
            status: disabled ? STATUS.deniedDisabled : STATUS.deniedUnauthorized,
            error: disabled ? 'key disabled' : 'unknown key',
            ms: now() - startedAt,
          });
          return disabled
            ? sendError(res, 403, `该 API Key 已被停用（${auth.key.label}），请联系管理员`, 'permission_error')
            : sendError(res, 401, 'API Key 无效', 'authentication_error');
        }
        caller = auth.key;
      } else if (apiKey && presented !== apiKey) {
        return sendError(res, 401, 'API Key 无效', 'authentication_error');
      }
    }

    /**
     * Build the one-shot recorder for this request. Exactly one row per chat
     * attempt, whatever the outcome.
     *
     * The `once` flag matters: the streaming path can reach both its own
     * `catch` and the outer `catch` when the upstream fails, and a double row
     * would double-count a single request in the report.
     */
    let recorded = false;
    const recordUsage = (patch) => {
      if (!store || recorded) return;
      recorded = true;
      const usage = patch.usage ?? {};
      const promptTokens = Number(usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens ?? 0) || 0;
      const completionTokens = Number(usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens ?? 0) || 0;
      const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? promptTokens + completionTokens) || 0;
      store.record({
        keyId: caller?.id ?? '',
        keyLabel: caller?.label ?? 'unknown',
        model: patch.model ?? null,
        promptTokens,
        completionTokens,
        totalTokens,
        status: patch.status ?? STATUS.ok,
        error: patch.error ?? null,
        ms: now() - startedAt,
        sessionId: patch.sessionId ?? null,
      });
    };

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

      // The model-picker catalog Codex reads via `model_catalog_url`. Distinct
      // from `/v1/models` above: that one is the OpenAI list shape, this one is
      // Codex's `ModelInfo` shape, which has no `object`/`data` envelope.
      if (req.method === 'GET' && (path === '/v1/models/catalog' || path === '/models/catalog')) {
        const catalog = buildCatalog(
          await provider.models(),
          provider.defaultModel,
          // `aliases` is a Map on the provider; the builder takes a plain object.
          provider.aliases?.size ? Object.fromEntries(provider.aliases) : null,
        );
        const etag = catalogEtag(catalog);
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag });
          return res.end();
        }
        res.setHeader('ETag', etag);
        return sendJson(res, 200, catalog);
      }

      if (req.method === 'POST' && path === '/v1/chat/completions') {
        if (!provider.ready) {
          recordUsage({ status: STATUS.upstreamError, error: 'provider not logged in' });
          return sendError(res, 503, '尚未登录 Trae 账号', 'service_unavailable');
        }

        // The cap is checked before the body is parsed: an over-budget caller
        // must not be able to make the gateway allocate 32 MB of buffers.
        if (caller && store) {
          const quota = store.checkQuota(caller);
          if (!quota.allowed) {
            recordUsage({ status: STATUS.deniedQuota, error: `daily cap ${quota.limit} reached` });
            return sendError(
              res,
              429,
              `今日额度已用尽（${quota.used}/${quota.limit} tokens），明日 00:00 重置`,
              'rate_limit_error',
            );
          }
        }

        const payload = await readBody(req);
        await provider.models();
        const caps = provider.resolveModel(payload.model);
        if (!caps) {
          recordUsage({ model: payload.model ?? null, status: STATUS.upstreamError, error: 'unknown model' });
          return sendError(res, 404, `未知模型: ${payload.model}`);
        }
        // OpenAI's default is NON-streaming: `stream` is optional and absent
        // means "give me one JSON body". This used to be `!== false`, which
        // made every SDK call that omitted the flag receive an SSE stream — the
        // official Python/Node clients then failed to parse it (`choices`
        // undefined). Only an explicit `stream: true` may select streaming.
        const wantStream = payload.stream === true;
        const body = buildTraeBody(payload, caps, wantStream);
        const modelId = caps.configName;
        // The upstream session id is generated inside `buildTraeBody`; echoing
        // it into the usage row is what lets a request be matched against the
        // enterprise console's per-session billing.
        const sessionId = body.session_id ?? null;

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
          recordUsage({ model: modelId, status: STATUS.ok, usage: result.usage, sessionId });
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
        // `res.on('close')` — not `req` — is what distinguishes a client hang-up
        // from a normal completion. An aborted call still burned upstream tokens
        // before the disconnect, so it is recorded as its own status rather than
        // silently vanishing from the report.
        res.on('close', () => {
          if (!res.writableEnded) abort.abort();
        });
        try {
          const result = await provider.withAuthRetry((creds) =>
            chat({
              creds,
              env: provider.env,
              body,
              signal: abort.signal,
              onEvent: (event) => {
                if (res.writableEnded || res.destroyed) return;
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
          recordUsage({ model: modelId, status: STATUS.ok, usage: result.usage, sessionId });
          const finish = result.finishReason === 'tool_calls' ? 'tool_calls' : result.finishReason || 'stop';
          if (result.usage) {
            res.write(`data: ${JSON.stringify({ id: 'chatcmpl-usage', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId, choices: [], usage: result.usage })}\n\n`);
          }
          res.write(sseChunk(modelId, {}, finish));
          res.write('data: [DONE]\n\n');
          return res.end();
        } catch (err) {
          const aborted = abort.signal.aborted;
          recordUsage({
            model: modelId,
            status: aborted ? STATUS.aborted : STATUS.upstreamError,
            error: aborted ? 'client closed the connection' : err.message,
            sessionId,
          });
          if (!aborted) {
            res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'upstream_error' } })}\n\n`);
          }
          return res.end();
        }
      }

      if (req.method === 'POST' && path === '/v1/responses') {
        return handleResponses(req, res, { provider, recordUsage, caller, store, now });
      }

      return sendError(res, 404, `未知路径: ${path}`, 'not_found');
    } catch (err) {
      recordUsage({ status: STATUS.upstreamError, error: err.message });
      provider.logger.error?.('[trae] 请求失败:', err.message);
      return sendError(res, 502, err.message, 'upstream_error');
    }
  };
}

/**
 * `POST /v1/responses` — the OpenAI Responses API that Codex CLI requires.
 *
 * Codex sends `stream: true` and parses SSE; a non-streaming caller gets the
 * same item list as a single JSON body. Both paths share {@link ResponsesEmitter}
 * so the two cannot drift apart.
 *
 * Ordering matters here: the quota check and the model lookup both happen
 * **before** any SSE byte is written, so a rejected caller gets a real HTTP
 * error (429 / 404 / 503) that Codex reports as a terminal failure instead of
 * a 200 stream that immediately dies.
 */
async function handleResponses(req, res, { provider, recordUsage, caller, store, now }) {
  if (!provider.ready) {
    recordUsage({ status: STATUS.upstreamError, error: 'provider not logged in' });
    return sendError(res, 503, '尚未登录 Trae 账号', 'service_unavailable');
  }

  if (caller && store) {
    const quota = store.checkQuota(caller);
    if (!quota.allowed) {
      recordUsage({ status: STATUS.deniedQuota, error: `daily cap ${quota.limit} reached` });
      return sendError(
        res,
        429,
        `今日额度已用尽（${quota.used}/${quota.limit} tokens），明日 00:00 重置`,
        'insufficient_quota',
        'insufficient_quota',
      );
    }
  }

  const payload = await readBody(req);
  await provider.models();
  const caps = provider.resolveModel(payload.model);
  if (!caps) {
    recordUsage({ model: payload.model ?? null, status: STATUS.upstreamError, error: 'unknown model' });
    return sendError(res, 404, `未知模型: ${payload.model}`, 'invalid_request_error', 'model_not_found');
  }

  const chatPayload = chatPayloadFromResponses(payload);
  const promptText = promptTextOf(payload.input);
  const wantStream = payload.stream !== false;
  // The upstream always streams; `wantStream` only controls what we write back.
  const body = buildTraeBody(chatPayload, caps, true);
  const modelId = caps.configName;
  const sessionId = body.session_id ?? null;
  // The same reverse-name table the tool declarations were built with, so a
  // call comes back under the name the caller actually declared.
  const emitter = new ResponsesEmitter({ model: caps.configName, stream: wantStream, toolNames: chatPayload.toolNames });

  // SSE headers are only sent once the first frame exists. This is what keeps
  // an upstream that fails *before* emitting anything (HTTP 500, 401, a bad
  // catalog) answerable as a real status code: Codex maps a non-2xx body to a
  // terminal error, whereas a 200 stream that immediately says `response.failed`
  // looks like a disconnect and gets retried.
  const openStream = () => {
    if (res.headersSent) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  };

  // `opened` flips on the first frame actually written, so the catch blocks
  // below know whether a status code is still available to them.
  let opened = false;
  const emit = (events) => {
    if (!events.length) return;
    openStream();
    opened = true;
    for (const event of events) res.write(sseEvent(event));
  };

  try {
    if (!wantStream) {
      let usage = null;
      const result = await provider.withAuthRetry((creds) =>
        chat({
          creds,
          env: provider.env,
          body,
          onEvent: (event) => {
            if (event.type === 'text') emitter.textDelta(event.text);
            else if (event.type === 'reason') emitter.reasonDelta(event.text);
            else if (event.type === 'tool') emitter.toolCall(event);
            else if (event.type === 'usage') usage = event.usage;
          },
        }),
      );
      usage = usage ?? result.usage ?? null;
      emitter.complete({ usage, finishReason: result.finishReason, promptText });
      recordUsage({ model: modelId, status: STATUS.ok, usage, sessionId });
      return sendJson(res, 200, emitter.toJSON({ usage, promptText }));
    }

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    let usage = null;
    try {
      const result = await provider.withAuthRetry((creds) =>
        chat({
          creds,
          env: provider.env,
          body,
          signal: abort.signal,
          onEvent: (event) => {
            if (res.writableEnded || res.destroyed) return;
            if (event.type === 'text') emit(emitter.textDelta(event.text));
            else if (event.type === 'reason') emit(emitter.reasonDelta(event.text));
            else if (event.type === 'tool') emit(emitter.toolCall(event));
            else if (event.type === 'usage') usage = event.usage;
          },
        }),
      );
      usage = usage ?? result.usage ?? null;
      recordUsage({ model: modelId, status: STATUS.ok, usage, sessionId });
      emit(emitter.complete({ usage, finishReason: result.finishReason, promptText }));
      return res.end();
    } catch (err) {
      const aborted = abort.signal.aborted;
      recordUsage({
        model: modelId,
        status: aborted ? STATUS.aborted : STATUS.upstreamError,
        error: aborted ? 'client closed the connection' : err.message,
        sessionId,
      });
      if (aborted || res.writableEnded) return undefined;
      if (opened) {
        // The stream is already committed; the failure has to travel in-band.
        emit(emitter.failed({ code: errorCodeOf(err), message: err.message }));
        return res.end();
      }
      // Nothing was written yet: answer with a real status code instead. The
      // status matters as much as the code — Codex only treats a *429* with
      // `insufficient_quota` as a terminal quota error, and a 502 as retryable.
      return sendError(res, errorStatusOf(err), err.message, errorTypeOf(err), errorCodeOf(err));
    }
  } catch (err) {
    // Reached only when the failure happens before the stream opened (model
    // catalog, body parse, first upstream call). Report it as a real HTTP error.
    recordUsage({ model: modelId, status: STATUS.upstreamError, error: err.message, sessionId });
    if (opened && !res.writableEnded) {
      emit(emitter.failed({ code: errorCodeOf(err), message: err.message }));
      res.end();
      return undefined;
    }
    return sendError(res, errorStatusOf(err), err.message, errorTypeOf(err), errorCodeOf(err));
  }
}

/** A standalone server, used by the CLI (`serve`) and by tests. */
export function createServer(provider, options = {}) {
  const handler = createRequestHandler(provider, options);
  const admin = typeof options.adminHandler === 'function' ? options.adminHandler : null;
  if (!admin) return http.createServer(handler);
  // One port, two surfaces. The admin handler gets first refusal; when it
  // returns false the OpenAI surface handles the request. Keeping them in one
  // process is the whole point of the MVP: one command to start, one URL to
  // remember, no reverse proxy to configure.
  return http.createServer((req, res) => {
    admin(req, res)
      .then((owned) => {
        if (!owned) handler(req, res);
      })
      .catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { message: `admin handler failed: ${err.message}` } }));
        } else {
          res.end();
        }
      });
  });
}

export function startServer(
  provider,
  { port = 8317, host = '127.0.0.1', apiKey = null, allowOrigins = [], store = null, adminHandler = null } = {},
) {
  const server = createServer(provider, { apiKey, allowOrigins, store, adminHandler });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // `port: 0` lets the OS pick, which the smoke tests rely on so two suites
    // can run at once without racing for 8317.
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}` }));
  });
}

export { loadCredentials, saveCredentials };
