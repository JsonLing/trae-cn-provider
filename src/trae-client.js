// trae-client.js - 上游调用：模型目录 + /api/agent/v3/llm_utils_chat (SSE)
import crypto from 'node:crypto';
import os from 'node:os';

const CHAT_HOST = 'https://trae-api-cn.mchost.guru';
const SG_CHAT_HOST = 'https://a0ai-api-sg.byteintlapi.com';
const IDE_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';

// Auth hosts do NOT serve the AI API: a consumer login stores `host` as the
// token-refresh host, and posting a chat to it returns 405. Tenant (enterprise)
// logins store their own gateway instead, and that gateway *does* serve
// `/api/ide/v1` and `/api/agent/v3` — measured against
// `console.enterprise.trae.cn`, which also returns a tenant-specific catalog
// (`tob_commercial_info.seat_discount_factor`) and requires `session_id` in the
// chat body before it will bill a seat instead of the consumer credit ledger.
const AUTH_ONLY_HOSTS = new Set([
  'https://api.trae.cn',
  'https://www.trae.cn',
  'https://api.trae.ai',
  'https://www.trae.ai',
  'https://api-sg-central.trae.ai',
]);

/**
 * Pick the upstream AI gateway for a credential set.
 * @param {{host?: string}} creds
 * @returns {string} base URL without a trailing slash
 */
export function apiHostFor(creds) {
  const host = String(creds?.host || '').trim().replace(/\/+$/, '');
  if (!host) return CHAT_HOST;
  if (host.includes('trae.ai') && !host.includes('enterprise')) return SG_CHAT_HOST;
  if (AUTH_ONLY_HOSTS.has(host)) return CHAT_HOST;
  return host;
}

export function ideHeaders(creds, env, { sse = false } = {}) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Cloud-IDE-JWT ${creds.token}`,
    'X-Cloudide-Token': creds.token,
    'X-Ide-Token': creds.token,
    'X-Uid': creds.userId || '',
    'x-app-id': env.appId || IDE_APP_ID,
    'x-app-version': 'default',
    'x-app-version-code': String(env.appVersionCode ?? env.ideVersionCode),
    // 本机凭据（local 来源）没有 DeviceInfo，但有 storage.json 的 telemetry.machineId；
    // 用它比 '0' 更贴近上游期望，两者都没有时才退化为 '0'。
    'x-device-id': creds.deviceInfo?.DeviceID || creds.machineId || '0',
    'x-machine-id': creds.deviceInfo?.MachineID || creds.machineId || '0',
    'x-request-id': crypto.randomUUID(),
    'x-ide-version': env.ideVersion,
    'x-ide-version-code': String(env.appVersionCode ?? env.ideVersionCode),
    'x-ide-version-type': 'stable',
    'x-device-cpu': 'Apple Silicon',
    'x-device-brand': 'Apple',
    'x-device-type': 'macos',
    'x-os-version': `macOS ${os.release()}`,
    'x-system-type': 'Darwin',
    Accept: sse ? 'text/event-stream' : 'application/json',
  };
}

// 上游会把 opencode 原生标签当成自己的工具协议，输出中途挂起
const TOOL_TAG_REWRITES = [
  ['</opencode_tool_call>', '</tool_invoke>'],
  ['<opencode_tool_call>', '<tool_invoke>'],
  ['</opencode_tool_result>', '</tool_result>'],
  ['<opencode_tool_result', '<tool_result'],
];

export function sanitizeToolTags(text) {
  let out = String(text ?? '');
  for (const [from, to] of TOOL_TAG_REWRITES) {
    while (out.includes(from)) out = out.replace(from, to);
  }
  return out;
}

/** 把内容块拼成 Trae 的 content parts（图片不得省略） */
function toContentParts(content) {
  const parts = [];
  const pushText = (text) => {
    const clean = sanitizeToolTags(text);
    if (clean) parts.push({ type: 'text', text: clean });
  };
  if (typeof content === 'string') {
    pushText(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') {
        pushText(part);
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      const type = part.type;
      if (type === 'text' || type === 'input_text') {
        pushText(part.text ?? '');
        continue;
      }
      const imageUrl = part.image_url ?? part.image;
      const url = typeof imageUrl === 'string' ? imageUrl : imageUrl?.url ?? part.url;
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  return parts;
}

/** OpenAI 风格消息 → Trae messages */
export function toTraeMessages(messages = []) {
  const out = [];
  for (const msg of messages) {
    const role = msg.role === 'developer' ? 'system' : msg.role;
    if (role === 'tool') {
      const content = toContentParts(msg.content);
      if (!content.length) content.push({ type: 'text', text: '' });
      out.push({
        role: 'tool',
        tool_call_id: msg.tool_call_id || 'unknown',
        ...(msg.name ? { name: msg.name } : {}),
        content,
      });
      continue;
    }
    if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const toolCalls = [];
      for (const call of msg.tool_calls) {
        const fn = call.function ?? call.function_call ?? {};
        if (!fn.name) continue;
        toolCalls.push({
          id: call.id || `call_${crypto.randomUUID()}`,
          type: 'function',
          function_call: { name: fn.name, arguments: fn.arguments || '{}' },
        });
      }
      const content = toContentParts(msg.content);
      out.push({ role: 'assistant', content, tool_calls: toolCalls });
      continue;
    }
    const content = toContentParts(msg.content);
    if (!content.length) continue;
    out.push({ role: role === 'assistant' ? 'assistant' : role, content });
  }
  if (!out.length) out.push({ role: 'user', content: [{ type: 'text', text: '' }] });
  return out;
}

function pick(obj, keys, fallback = '') {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return fallback;
}

function num(obj, keys, fallback = 0) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return fallback;
}

function bool(obj, keys, fallback = false) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'boolean') return value;
  }
  return fallback;
}

// 目录里的 usage 字段直接标明用途：只有 chat_completion 是用户可选模型
const INTERNAL_USAGE = new Set([
  'summary',
  'fast_apply',
  'fast_apply_new',
  'title_generation',
  'input_optimization',
  'compact_prompt',
  'query_rewrite',
  'custom_model',
]);
const INTERNAL_PREFIX = ['custom_', 'search_agent', 'browser_use', 'computer_use', 'file_search', 'explore_'];

export function isInternalModel(configName, usage) {
  const lower = String(configName || '').toLowerCase();
  if (usage && INTERNAL_USAGE.has(String(usage).toLowerCase())) return true;
  if (INTERNAL_PREFIX.some((prefix) => lower.startsWith(prefix))) return true;
  if (lower.endsWith('-auto')) return true;
  return false;
}

function capsFrom(source, target) {
  target.configName ||= pick(source, ['config_name', 'configName', 'name']);
  target.modelName ||= pick(source, ['model_name', 'modelName', 'raw_model_name']);
  target.displayName ||= pick(source, ['display_model_name', 'display_name', 'displayName']);
  target.provider ||= pick(source, ['provider']);
  target.ideFunction ||= pick(source, ['raw_chat_function', 'rawChatFunction']);
  if (source?.usage !== undefined) target.usage ||= pick(source, ['usage']);
  if (source?.config_source !== undefined) target.configSource = num(source, ['config_source'], target.configSource);
  if (source?.max_mode !== undefined) target.maxMode ||= bool(source, ['max_mode']);
  if (source?.multimodal !== undefined) target.vision ||= bool(source, ['multimodal']);
  // 显示名 / 多模态 / max_mode 实际嵌在 display_config 下
  const display = source?.display_config;
  if (display && typeof display === 'object') {
    target.displayName ||= pick(display, ['display_name', 'displayName']);
    if (display.multimodal !== undefined) target.vision ||= bool(display, ['multimodal']);
    if (display.max_mode !== undefined) target.maxMode ||= bool(display, ['max_mode']);
    if (display.is_custom_model !== undefined) target.custom = bool(display, ['is_custom_model']);
  }
  // 上下文窗口：context_window_tokens 是 {dev: 256000, ...} 形式的按渠道表
  const tokens = source?.context_window_tokens;
  if (tokens && typeof tokens === 'object') {
    const values = Object.values(tokens).filter((n) => typeof n === 'number' && n > 0);
    if (values.length) target.contextWindow = Math.max(target.contextWindow, ...values);
  }
  const cw = source?.context_window_size;
  if (cw && typeof cw === 'object') {
    const maxList = Array.isArray(cw.max) ? cw.max.filter((n) => typeof n === 'number') : [];
    if (maxList.length) target.maxContextWindow = Math.max(...maxList);
    if (typeof cw.default === 'number' && cw.default > 0) target.contextWindow = cw.default;
  }
  const effort = source?.reasoning_effort_config;
  if (effort && typeof effort === 'object') {
    if (Array.isArray(effort.options) && effort.options.length) target.effortOptions = effort.options.map(String);
    const def = pick(effort, ['default_level', 'default']);
    if (def) target.effortDefault = def;
    target.supportThinking = true;
  }
  if (Array.isArray(source?.reasoning_effort_options) && source.reasoning_effort_options.length) {
    target.effortOptionsExt = source.reasoning_effort_options.map(String);
    target.supportThinking = true;
  }
  target.promptMaxTokens = num(source, ['prompt_max_tokens'], target.promptMaxTokens);
  return target;
}

async function postJson(url, headers, body, timeoutMs = 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

const catalogBody = (fn) => ({
  function: fn,
  config_names: null,
  need_prompt: false,
  current_config_info: null,
  poly_prompt: true,
  mode_type: null,
  agent_type: null,
});

/** 拉一份 function 目录（chat_v3 / solo_agent），返回 ModelCaps 列表 */
export async function fetchCatalog(creds, env, fn = 'chat_v3', extraHeaders = null) {
  const json = await postJson(
    `${apiHostFor(creds)}/api/ide/v1/get_detail_param`,
    { ...ideHeaders(creds, env), ...(extraHeaders || {}) },
    catalogBody(fn),
  );
  const root = json?.data && typeof json.data === 'object' ? json.data : json;
  const list = root?.config_info_list;
  if (!Array.isArray(list)) throw new Error(`get_detail_param(${fn}) 响应缺少 config_info_list`);

  const models = [];
  for (const item of list) {
    const configName = pick(item, ['config_name']);
    const hidden = bool(item, ['is_invisible_to_user']) || item?.config_switch === false;
    const display = item?.display_config;
    const custom = bool(display, ['is_custom_model']);
    if (hidden || custom || !configName) continue;
    if (isInternalModel(configName, item?.usage)) continue;
    const details = Array.isArray(item?.model_detail_list) ? item.model_detail_list : [];
    for (const detail of details) {
      const caps = capsFrom(item, { configSource: 1, promptMaxTokens: 0, contextWindow: 0, maxContextWindow: 0, maxMode: false, supportThinking: false });
      capsFrom(detail, caps);
      if (!caps.configName || caps.configSource !== 1) continue;
      caps.ideChatCapable = true;
      const detailModelName = pick(detail, ['model_name', 'modelName']);
      const isMaxDetail = bool(detail, ['max_mode']) || detailModelName.endsWith('__max');
      const existing = models.find((m) => m.configName.toLowerCase() === caps.configName.toLowerCase());
      const entry = {
        id: caps.configName,
        name: caps.displayName || detailModelName || caps.configName,
        configName: caps.configName,
        modelName: caps.modelName || detailModelName || caps.configName,
        provider: caps.provider || '',
        configSource: caps.configSource,
        function: caps.ideFunction || fn,
        maxMode: caps.maxMode || isMaxDetail,
        maxModelName: isMaxDetail && detailModelName ? detailModelName : '',
        contextWindow: caps.contextWindow || 0,
        maxContextWindow: caps.maxContextWindow || 0,
        promptMaxTokens: caps.promptMaxTokens || 0,
        supportThinking: caps.supportThinking,
        effortOptions: caps.effortOptions || caps.effortOptionsExt || [],
        effortDefault: caps.effortDefault || '',
        vision: caps.vision,
      };
      if (!existing) {
        models.push(entry);
        continue;
      }
      if (isMaxDetail && detailModelName) {
        existing.maxMode = true;
        existing.maxModelName = detailModelName;
        existing.maxContextWindow = Math.max(existing.maxContextWindow, entry.maxContextWindow);
      } else {
        existing.name ||= entry.name;
        existing.supportThinking ||= entry.supportThinking;
        if (!existing.effortOptions.length) existing.effortOptions = entry.effortOptions;
        existing.effortDefault ||= entry.effortDefault;
        existing.vision ||= entry.vision;
      }
    }
  }
  return models;
}

/** 合并 chat_v3 与 solo_agent 两份目录；extraHeaders 供 DSH 插件附加 attribution */
export async function listModels(creds, env, extraHeaders = null) {
  const [a, b] = await Promise.all([
    fetchCatalog(creds, env, 'chat_v3', extraHeaders).catch((err) => ({ error: err })),
    fetchCatalog(creds, env, 'solo_agent', extraHeaders).catch((err) => ({ error: err })),
  ]);
  const merged = new Map();
  for (const source of [a, b]) {
    if (!Array.isArray(source)) continue;
    for (const model of source) {
      const key = model.configName.toLowerCase();
      if (!merged.has(key)) merged.set(key, model);
    }
  }
  if (!merged.size) {
    const reasons = [a, b].filter((x) => x?.error).map((x) => x.error.message);
    throw new Error(reasons.length ? `模型目录拉取失败: ${reasons.join('; ')}` : '模型目录为空');
  }
  return [...merged.values()];
}

// Quota-flavoured failures: the upstream reports them as an SSE `error` event
// with a business code (4008 = credits exhausted), not as an HTTP status, so
// they used to surface as an opaque "trae 4008: ..." with no actionable data.
const QUOTA_CODES = new Set([4008, 4009, 402]);
const QUOTA_MESSAGE = /quota|balance|credit|额度|积分/i;

/** Render the quota snapshot that `notify_usage` carried, if any. */
function quotaDetail({ remainUsage, creditsRemain, billingMode } = {}) {
  const parts = [];
  if (creditsRemain && typeof creditsRemain === 'object') {
    const pairs = Object.entries(creditsRemain)
      .filter(([, value]) => typeof value === 'number')
      .map(([key, value]) => `${key}=${value}`);
    if (pairs.length) parts.push(pairs.join(' '));
  }
  if (remainUsage && typeof remainUsage === 'object') {
    const pairs = Object.entries(remainUsage)
      .filter(([, value]) => typeof value === 'number')
      .map(([key, value]) => `${key}=${value}`);
    if (pairs.length) parts.push(`remain ${pairs.join(' ')}`);
  }
  if (billingMode) parts.push(`billing=${billingMode}`);
  return parts.join('; ');
}

/**
 * Build the message for a chat failure, appending the quota snapshot when the
 * failure looks like an exhausted balance.
 * @param {{code:number|string, message:string, remainUsage?:object,
 *   creditsRemain?:object, billingMode?:string}} failure
 * @returns {string}
 */
export function describeFailure(failure) {
  const head = `trae ${failure.code}: ${failure.message}`;
  const quotaLike = QUOTA_CODES.has(failure.code) || QUOTA_MESSAGE.test(String(failure.message ?? ''));
  const detail = quotaLike ? quotaDetail(failure) : '';
  if (!detail) return head;
  return `${head}（上游额度：${detail}；用 \`trae-cn usage\` 查看账号余额）`;
}

async function* sseLines(response) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      yield buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer) yield buffer.replace(/\r$/, '');
}

/**
 * 调用聊天通道。
 * body 为已构造好的 Trae 请求体；onEvent 接收归一化事件：
 *   {type:'text'|'reason'|'tool'|'usage'|'queue'|'done'|'error', ...}
 * headers 可选：调用方（DSH 插件）用它把 attributionHeaders() 合并进 IDE 头组；
 * 不传时行为与原来完全一致。
 */
export async function chat({ creds, env, body, signal, headers, onEvent = () => {} }) {
  const res = await fetch(`${apiHostFor(creds)}/api/agent/v3/llm_utils_chat`, {
    method: 'POST',
    headers: headers || ideHeaders(creds, env, { sse: true }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const error = new Error(`聊天通道 HTTP ${res.status}: ${text.slice(0, 300)}`);
    error.httpStatus = res.status;
    throw error;
  }

  const tools = new Map();
  let usage = null;
  let finishReason = '';
  let sawDone = false;
  let failure = null;
  // `notify_usage` is the gateway's *quota* frame (remaining credits), not a
  // token count. Keeping it separate from `usage` both avoids clobbering a real
  // `token_usage` frame and lets a 4008 explain itself.
  let remainUsage = null;
  let creditsRemain = null;
  let billingMode = '';

  // 工具调用的参数分片：partial_arguments 是本帧增量；arguments 在不同模型上
  // 既可能是增量片段，也可能是从头开始的累计快照。
  const accumulateToolCalls = (list) => {
    for (const [i, call] of list.entries()) {
      const index = typeof call.index === 'number' ? call.index : i;
      const fn = call.function_call ?? call.function ?? {};
      const tool = tools.get(index) || { id: '', name: '', args: '' };
      if (call.id) tool.id = call.id;
      if (fn.name) tool.name = fn.name;
      if (fn.partial_arguments) {
        tool.args += fn.partial_arguments;
      } else if (fn.arguments) {
        if (!tool.args) tool.args = fn.arguments;
        else if (fn.arguments.startsWith(tool.args)) tool.args = fn.arguments;
        else if (fn.arguments !== tool.args) tool.args += fn.arguments;
      }
      tools.set(index, tool);
    }
  };

  const flushTools = () => {
    for (const [index, tool] of [...tools.entries()].sort((x, y) => x[0] - y[0])) {
      if (!tool.name) continue;
      onEvent({
        type: 'tool',
        index,
        id: tool.id || `call_${crypto.randomUUID()}`,
        name: tool.name,
        arguments: tool.args || '{}',
      });
    }
  };

  let eventName = '';
  let dataLines = [];
  const dispatch = () => {
    if (!dataLines.length) {
      eventName = '';
      return;
    }
    const payload = dataLines.join('\n');
    const name = (eventName || 'message').toLowerCase();
    eventName = '';
    dataLines = [];

    if (name === 'request_wait_in_queue' || name === 'queue_begin') return onEvent({ type: 'queue', queued: true });
    if (name === 'queue_end') return onEvent({ type: 'queue', queued: false });
    if (payload === '[DONE]') {
      sawDone = true;
      return;
    }

    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    if (name === 'error') {
      failure = { code: data.code ?? 0, message: data.message || '上游返回错误' };
      return;
    }
    if (name === 'notify_usage') {
      // Quota snapshot, not a token count: `usage` here is the per-category
      // remaining balance (and `remain_usage` mirrors it). Feeding it into
      // `usage` made the last `token_usage` frame irrelevant.
      if (data.remain_usage && typeof data.remain_usage === 'object') remainUsage = data.remain_usage;
      if (data.cn_credits_remain_info && typeof data.cn_credits_remain_info === 'object') {
        creditsRemain = data.cn_credits_remain_info;
      }
      if (typeof data.billing_mode === 'string' && data.billing_mode) billingMode = data.billing_mode;
      return;
    }
    if (name === 'token_usage' || name === 'usage') {
      const nested = data.usage && typeof data.usage === 'object' ? data.usage : null;
      usage = nested
        ? nested
        : {
            prompt_tokens: data.prompt_tokens ?? 0,
            completion_tokens: data.completion_tokens ?? 0,
            total_tokens: data.total_tokens ?? data.prompt_tokens + data.completion_tokens ?? 0,
            prompt_tokens_details: { cached_tokens: data.cache_read_input_tokens ?? 0 },
            completion_tokens_details: { reasoning_tokens: data.reasoning_tokens ?? 0 },
          };
      onEvent({ type: 'usage', usage });
      return;
    }
    if (name === 'done') {
      // 协议上工具调用是在 output 帧里增量下发的（已实测），但 done 帧也可能
      // 直接带完整的 tool_calls，两种都累积后再统一下发。
      if (Array.isArray(data.tool_calls)) accumulateToolCalls(data.tool_calls);
      flushTools();
      finishReason = data.finish_reason || 'stop';
      sawDone = true;
      onEvent({ type: 'done', finishReason });
      return;
    }
    if (name === 'output' || name === 'message' || name === 'text') {
      onEvent({ type: 'queue', queued: false });
      if (Array.isArray(data.tool_calls)) accumulateToolCalls(data.tool_calls);
      // content / response 都是增量，重复片段也是正文，不能去重
      for (const key of ['content', 'response']) {
        const text = data[key];
        if (typeof text === 'string' && text) onEvent({ type: 'text', text });
      }
      for (const key of ['reasoning', 'reasoning_content']) {
        const text = data[key];
        if (typeof text === 'string' && text) onEvent({ type: 'reason', text });
      }
    }
  };

  try {
    for await (const line of sseLines(res)) {
      if (line === '') {
        dispatch();
        if (sawDone || failure) break;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
    }
    dispatch();
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    failure = failure || { code: -1, message: `读取上游流失败: ${err.message}` };
  }

  if (failure) {
    const error = new Error(describeFailure({ ...failure, remainUsage, creditsRemain, billingMode }));
    error.code = failure.code;
    if (remainUsage) error.remainUsage = remainUsage;
    if (creditsRemain) error.creditsRemain = creditsRemain;
    if (billingMode) error.billingMode = billingMode;
    throw error;
  }
  if (!sawDone) {
    const error = new Error('上游提前关闭流，未收到结束事件');
    error.code = -1;
    throw error;
  }
  return { finishReason: finishReason || 'stop', usage };
}
