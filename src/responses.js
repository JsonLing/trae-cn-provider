// responses.js - the OpenAI **Responses API** surface (`POST /v1/responses`).
//
// Why this exists: Codex CLI dropped `wire_api = "chat"` in Feb 2026 and now
// refuses to start with anything but `wire_api = "responses"`. Setting it to
// "chat" fails at config load:
//
//     `wire_api = "chat"` is no longer supported.
//     How to fix: set `wire_api = "responses"` in your provider config.
//
// The upstream is Trae's `llm_utils_chat`, which is a Chat-Completions-shaped
// stream. This module is the *protocol* half of the bridge: it turns a
// Responses request body into the chat-shaped payload `buildTraeBody` already
// understands, and turns the normalized upstream events (`text` / `reason` /
// `tool`) into the Responses SSE event sequence Codex's parser expects.
//
// What Codex actually reads (measured against codex-cli 0.166.0-alpha.5.1 and
// cross-checked in codex-rs/codex-api/src/sse/responses.rs):
//
//   response.created                    -> response.id
//   response.output_item.added/done     -> parsed as `ResponseItem`
//   response.output_text.delta          -> assistant text on screen
//   response.reasoning_summary_text.delta  (needs summary_index)
//   response.reasoning_text.delta          (needs content_index)
//   response.reasoning_summary_part.added  (needs summary_index)
//   response.output_item.done (reasoning) -> the "thinking" block in history
//   response.completed                  -> id + usage (all four counts required)
//   response.failed                     -> error.code drives retry vs abort
//
// Everything else (`response.content_part.*`, `response.function_call_arguments.*`,
// `response.in_progress`) is explicitly ignored by that parser, so we do not
// emit it except where it is cheap and helps other clients.
import crypto from 'node:crypto';

const randomId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;

/**
 * Rough token estimate, used **only** when the upstream reports no `token_usage`
 * frame. Codex's `response.completed` requires integer token counts; sending
 * zeros makes every turn read "0 tokens used", and omitting `usage` makes the
 * event unparseable. A crude estimate is better than either.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const chars = String(text ?? '').length;
  return chars === 0 ? 0 : Math.ceil(chars / 3.5);
}

/** Flatten one Responses content array into chat content parts. */
function toChatContent(content) {
  const parts = [];
  const pushText = (text) => {
    if (typeof text === 'string' && text) parts.push({ type: 'text', text });
  };
  if (typeof content === 'string') pushText(content);
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      switch (part.type) {
        // `input_text` is user-side, `output_text` is assistant-side; Trae only
        // knows one text part, so both collapse into `{type:'text'}`.
        case 'input_text':
        case 'output_text':
        case 'text':
          pushText(part.text);
          break;
        case 'input_image': {
          // `file_id` would need a download endpoint we do not have; only an
          // inline URL can be forwarded.
          const url = part.image_url;
          if (typeof url === 'string' && url) parts.push({ type: 'image_url', image_url: { url } });
          break;
        }
        default:
          // `input_audio`, `refusal`, and anything newer: silently dropped.
          break;
      }
    }
  }
  return parts;
}

/** Function results may arrive as a string or as structured content items. */
function toToolOutputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  }
  if (output && typeof output === 'object') return output.text ?? JSON.stringify(output);
  return '';
}

/**
 * Responses `input` -> chat `messages`.
 *
 * Grouping matters: consecutive `function_call` items must land in **one**
 * assistant message's `tool_calls` array, or the upstream sees a tool result
 * with no matching call and rejects the turn.
 * @param {any[]|string} input - a bare string is legal and means one user turn.
 * @param {ToolNameTable} [toolNames] - shared with {@link toChatTools} so a
 *   replayed call is sent under the same name the model is told it has.
 * @returns {object[]}
 */
export function toChatMessages(input = [], toolNames = new ToolNameTable()) {
  // The spec allows `input` to be a plain string instead of an item array.
  const items = typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : input;
  const messages = [];
  /** @type {object|null} the assistant message currently collecting tool calls */
  let pendingTools = null;
  const closePending = () => {
    pendingTools = null;
  };
  const pushToolCall = (call) => {
    if (!pendingTools) {
      // An assistant turn that stated something and *then* called a tool is
      // one message upstream, not two: chat_v3 validates the tool result
      // against the assistant message immediately before it. Reuse the text
      // message the caller already sent when it is the last one.
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant' && !last.tool_calls) {
        last.tool_calls = [];
        pendingTools = last;
      } else {
        pendingTools = { role: 'assistant', content: null, tool_calls: [] };
        messages.push(pendingTools);
      }
    }
    pendingTools.tool_calls.push(call);
  };

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    switch (item.type) {
      case 'message': {
        closePending();
        const role = item.role === 'developer' ? 'developer' : item.role;
        const content = toChatContent(item.content);
        // An assistant turn with no text but with tool calls is emitted by the
        // tool-call branch below; an empty message is noise, so skip it.
        if (!content.length && role === 'assistant') continue;
        messages.push({ role, content });
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        // Same table as the tool declarations: a history replay must use the
        // exact name the model is being told about, or the pairing with its
        // `function_call_output` breaks.
        const nameWithNamespace = toolNames.add(item.name || 'unknown', item.namespace);
        pushToolCall({
          id: item.call_id || randomId('call'),
          type: 'function',
          function: {
            name: nameWithNamespace,
            // The upstream wants a JSON string; custom tools carry raw text.
            arguments:
              typeof item.arguments === 'string'
                ? item.arguments
                : typeof item.input === 'string'
                  ? item.input
                  : JSON.stringify(item.arguments ?? item.input ?? {}),
          },
        });
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        closePending();
        const text = toToolOutputText(item.output);
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || 'unknown',
          ...(item.name ? { name: item.name } : {}),
          content: [{ type: 'text', text }],
        });
        break;
      }
      case 'reasoning': {
        // Previous-turn reasoning is not part of the upstream's wire format
        // (chat_v3 re-derives it from the assistant text), so it is dropped.
        break;
      }
      default:
        // `web_search_call`, `local_shell_call`, `compaction`, ... are
        // provider-internal items the upstream has no representation for.
        break;
    }
  }
  return messages;
}

/**
 * Separator used to flatten a `namespace` tool into a single function name.
 *
 * NOT a dot: the live upstream rejects any tool name outside
 * `[A-Za-z0-9_-]{1,128}` —
 *
 *     trae 4027: tool call failed: tools.4.function.name: expected 1-128 ASCII
 *     letters, digits, underscores or hyphens
 *
 * — so `multi_agent_v1.spawn` fails the whole request. The underscore form is
 * also what a model is most likely to reproduce on its own.
 */
export const NAMESPACE_SEPARATOR = '_';

/** Coerce one tool name into the upstream's accepted charset. */
export function sanitizeToolName(name) {
  const clean = String(name ?? '')
    .replace(/[^A-Za-z0-9_-]/g, NAMESPACE_SEPARATOR)
    .slice(0, 128);
  return clean || 'tool';
}

/**
 * Two-way name table for one request.
 *
 * Sanitizing is lossy — `tool.with.dot` and `multi_agent_v1.spawn` both have to
 * be rewritten to satisfy the upstream charset — so the caller's original name
 * has to be recoverable from what the model actually emits. Without the
 * reverse map, a call comes back under an upstream name Codex never declared
 * and the tool dispatch fails.
 *
 * Collisions are resolved by suffixing, so two originals can never end up
 * sharing one upstream name.
 */
export class ToolNameTable {
  constructor() {
    /** @type {Map<string, {name: string, namespace?: string}>} upstream -> caller */
    this.reverse = new Map();
    /** @type {Map<string, string>} caller key -> upstream */
    this.forward = new Map();
  }

  /** The key a caller's declaration is remembered by. */
  static key(name, namespace) {
    return namespace ? `${namespace}\u0000${name}` : name;
  }

  /**
   * Register one tool the caller declared and return the name to send upstream.
   * @param {string} name
   * @param {string} [namespace]
   * @returns {string}
   */
  add(name, namespace) {
    const key = ToolNameTable.key(name, namespace);
    const existing = this.forward.get(key);
    if (existing) return existing;
    const base =
      namespace && namespace !== name
        ? sanitizeToolName(`${namespace}${NAMESPACE_SEPARATOR}${name}`)
        : sanitizeToolName(name);
    let candidate = base;
    let suffix = 2;
    // Distinct originals must not collide: `a.b` and `a_b` both sanitize to
    // `a_b`, and silently merging them would route a call to the wrong tool.
    while (this.reverse.has(candidate) && this.reverse.get(candidate).name !== name) {
      candidate = `${base.slice(0, 120)}_${suffix++}`;
    }
    this.forward.set(key, candidate);
    this.reverse.set(candidate, namespace ? { name, namespace } : { name });
    return candidate;
  }

  /**
   * The caller's declaration for a name the model produced.
   * Unknown names pass through unchanged — a model may invent a tool, and the
   * caller is the one that should reject it.
   * @param {string} upstreamName
   * @returns {{name: string, namespace?: string}}
   */
  resolve(upstreamName) {
    return this.reverse.get(String(upstreamName ?? '')) ?? { name: String(upstreamName ?? '') };
  }
}

/**
 * Responses tools -> the flat `{name, description, parameters}` shape
 * `buildTraeBody` accepts.
 *
 * Trae supports function tools only, so `custom` (freeform) and `web_search`
 * are skipped. `namespace` tools are valid in Codex's tool list and are
 * flattened into one function name; {@link ToolNameTable} remembers the way
 * back.
 * @param {any[]} tools
 * @param {ToolNameTable} [table] - reused so the reverse mapping is available later.
 * @returns {object[]}
 */
export function toChatTools(tools = [], table = new ToolNameTable()) {
  const out = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const inner of tool.tools) {
        if (inner?.type !== 'function' || !inner.name) continue;
        out.push({
          type: 'function',
          function: {
            name: table.add(inner.name, tool.name),
            description: inner.description || '',
            parameters: inner.parameters ?? { type: 'object', properties: {} },
          },
        });
      }
      continue;
    }
    if (tool.type !== 'function' || !tool.name) continue;
    out.push({
      type: 'function',
      function: {
        name: table.add(tool.name),
        description: tool.description || '',
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    });
  }
  return out;
}

/** Map Responses `reasoning.effort` onto the Trae effort id the body carries. */
export function reasoningEffortOf(payload) {
  const effort = payload?.reasoning?.effort;
  return typeof effort === 'string' ? effort : undefined;
}

/**
 * One Responses request, translated into the chat-shaped payload the existing
 * route already builds a Trae body from.
 * @param {object} payload - the parsed `/v1/responses` body.
 * @returns {{messages: object[], tools: object[], tool_choice: string, reasoning_effort?: string, model?: string}}
 */
export function chatPayloadFromResponses(payload = {}) {
  const toolNames = new ToolNameTable();
  const chatTools = toChatTools(payload.tools, toolNames);
  let toolChoice = 'auto';
  const choice = payload.tool_choice;
  // The upstream only supports "auto" or "no tools at all"; an object choice
  // (forced function) has no representation, so it degrades to auto.
  if (typeof choice === 'string' && (choice === 'auto' || choice === 'none')) toolChoice = choice;
  const result = {
    messages: toChatMessages(payload.input, toolNames),
    tools: chatTools,
    tool_choice: toolChoice,
    // Not part of the upstream body: the caller needs it to map the model's
    // call back to the name it actually declared.
    toolNames,
  };
  const effort = reasoningEffortOf(payload);
  if (effort) result.reasoning_effort = effort;
  if (typeof payload.model === 'string') result.model = payload.model;
  return result;
}

/**
 * Concatenate every text the caller sent, for the token-estimate fallback.
 * @param {any[]} input
 * @returns {string}
 */
export function promptTextOf(input = []) {
  const chunks = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.output === 'string') chunks.push(item.output);
    const content = item.content;
    if (typeof content === 'string') chunks.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') chunks.push(part);
        else if (part?.text) chunks.push(part.text);
      }
    }
  }
  return chunks.join('\n');
}

/**
 * Accumulate upstream events into Responses output items and emit the SSE
 * sequence when `stream` is set.
 *
 * The emitter is deliberately lazy about `response.created`: the HTTP caller
 * only sends headers on the first event, which is what lets a pre-stream
 * failure still answer with a normal JSON error + status code instead of a
 * 200 SSE stream that immediately says "failed".
 */
export class ResponsesEmitter {
  /**
   * @param {object} options
   * @param {string} options.model - the resolved model id echoed to the caller.
   * @param {boolean} [options.stream] - emit SSE events (default true).
   * @param {ToolNameTable} [options.toolNames] - reverse map for tool names.
   */
  constructor({ model, stream = true, toolNames = new ToolNameTable() }) {
    this.model = model;
    this.stream = stream;
    this.toolNames = toolNames;
    this.id = randomId('resp');
    this.createdAt = Math.floor(Date.now() / 1000);
    this.seq = 0;
    this.started = false;
    this.items = [];
    this.text = '';
    this.reason = '';
    /** @type {{kind: 'message'|'reasoning', id: string, outputIndex: number} | null} */
    this.active = null;
    this.outputIndex = 0;
    this.toolCalls = 0;
  }

  /** @param {object} event @returns {object[]} */
  emit(event) {
    if (!this.stream) return [];
    this.seq += 1;
    return [{ ...event, sequence_number: this.seq }];
  }

  responseBody(status, usage = null) {
    return {
      id: this.id,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output: this.items,
      usage,
      error: null,
      incomplete_details: null,
    };
  }

  /** The `response.created` frame, emitted at most once and always first. */
  head() {
    if (this.started) return [];
    this.started = true;
    return this.emit({ type: 'response.created', response: this.responseBody('in_progress') });
  }

  closeActive() {
    if (!this.active) return [];
    const { kind, id, outputIndex } = this.active;
    this.active = null;
    const events = [];
    if (kind === 'message') {
      const item = {
        id,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: this.text, annotations: [] }],
      };
      this.items.push(item);
      events.push(...this.emit({ type: 'response.output_text.done', item_id: id, output_index: outputIndex, content_index: 0, text: this.text }));
      events.push(...this.emit({ type: 'response.content_part.done', item_id: id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: this.text, annotations: [] } }));
      events.push(...this.emit({ type: 'response.output_item.done', output_index: outputIndex, item }));
    } else {
      const item = {
        id,
        type: 'reasoning',
        summary: this.reason ? [{ type: 'summary_text', text: this.reason }] : [],
      };
      this.items.push(item);
      events.push(...this.emit({ type: 'response.reasoning_summary_text.done', item_id: id, output_index: outputIndex, summary_index: 0, text: this.reason }));
      events.push(...this.emit({ type: 'response.reasoning_summary_part.done', item_id: id, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: this.reason } }));
      events.push(...this.emit({ type: 'response.output_item.done', output_index: outputIndex, item }));
    }
    return events;
  }

  /** Assistant text delta. */
  textDelta(delta) {
    if (!delta) return [];
    const events = [...this.head()];
    if (!this.active || this.active.kind !== 'message') {
      events.push(...this.closeActive());
      this.text = '';
      const id = randomId('msg');
      this.active = { kind: 'message', id, outputIndex: this.outputIndex++ };
      const outputIndex = this.active.outputIndex;
      events.push(...this.emit({ type: 'response.output_item.added', output_index: outputIndex, item: { id, type: 'message', role: 'assistant', status: 'in_progress', content: [] } }));
      events.push(...this.emit({ type: 'response.content_part.added', item_id: id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
    }
    this.text += delta;
    events.push(...this.emit({ type: 'response.output_text.delta', item_id: this.active.id, output_index: this.active.outputIndex, content_index: 0, delta }));
    return events;
  }

  /** Reasoning delta (surfaced as Codex's "thinking" summary). */
  reasonDelta(delta) {
    if (!delta) return [];
    const events = [...this.head()];
    if (!this.active || this.active.kind !== 'reasoning') {
      events.push(...this.closeActive());
      this.reason = '';
      const id = randomId('rs');
      this.active = { kind: 'reasoning', id, outputIndex: this.outputIndex++ };
      const outputIndex = this.active.outputIndex;
      events.push(...this.emit({ type: 'response.output_item.added', output_index: outputIndex, item: { id, type: 'reasoning', summary: [] } }));
      events.push(...this.emit({ type: 'response.reasoning_summary_part.added', item_id: id, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' } }));
    }
    this.reason += delta;
    events.push(...this.emit({ type: 'response.reasoning_summary_text.delta', item_id: this.active.id, output_index: this.active.outputIndex, summary_index: 0, delta }));
    return events;
  }

  /**
   * A completed tool call. Trae only flushes these at the end of a turn, so
   * each one is emitted as an immediately-complete item rather than a
   * long-lived incremental one.
   * @param {{id?: string, name: string, arguments?: string}} call
   */
  toolCall(call) {
    const events = [...this.head()];
    events.push(...this.closeActive());
    // `call.name` is the sanitized name the upstream now uses; the caller
    // declared the original, so translate it back before building the item.
    const { name, namespace } = this.toolNames.resolve(call.name);
    const id = randomId('fc');
    const callId = call.id || randomId('call');
    const args = typeof call.arguments === 'string' && call.arguments ? call.arguments : '{}';
    const outputIndex = this.outputIndex++;
    const item = {
      id,
      type: 'function_call',
      status: 'completed',
      ...(namespace ? { namespace } : {}),
      name,
      arguments: args,
      call_id: callId,
    };
    events.push(...this.emit({ type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress', arguments: '' } }));
    events.push(...this.emit({ type: 'response.function_call_arguments.delta', item_id: id, output_index: outputIndex, delta: args }));
    events.push(...this.emit({ type: 'response.function_call_arguments.done', item_id: id, output_index: outputIndex, arguments: args }));
    events.push(...this.emit({ type: 'response.output_item.done', output_index: outputIndex, item }));
    this.items.push(item);
    this.toolCalls += 1;
    return events;
  }

  /**
   * Close out the turn.
   * @param {object} options
   * @param {object|null} [options.usage] - Trae `token_usage` frame.
   * @param {string} [options.finishReason]
   * @param {string} [options.promptText] - only for the estimate fallback.
   */
  complete({ usage = null, finishReason = 'stop', promptText = '' } = {}) {
    const events = [...this.head(), ...this.closeActive()];
    // With no text and no tools the model effectively said nothing; still emit
    // an (empty) assistant message so the caller's history keeps a turn.
    if (!this.items.length) {
      const id = randomId('msg');
      const item = {
        id,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '', annotations: [] }],
      };
      this.items.push(item);
      events.push(...this.emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }));
      events.push(...this.emit({ type: 'response.output_item.done', output_index: 0, item }));
    }
    const counts = responsesUsage(usage, {
      promptText,
      completionText: this.text,
      reasoningText: this.reason,
    });
    events.push(...this.emit({ type: 'response.completed', response: this.responseBody('completed', counts) }));
    return events;
  }

  /** Terminal failure frame, for errors raised after the stream opened. */
  failed({ code = 'upstream_error', message = 'upstream failed' } = {}) {
    const events = [...this.head()];
    const response = this.responseBody('failed', null);
    response.error = { code, message };
    events.push(...this.emit({ type: 'response.failed', response }));
    return events;
  }

  /** The non-streaming JSON body. */
  toJSON({ usage = null, promptText = '' } = {}) {
    const counts = responsesUsage(usage, {
      promptText,
      completionText: this.text,
      reasoningText: this.reason,
    });
    const response = this.responseBody('completed', counts);
    // Ensure the same "empty turn" rule as the streaming path.
    if (!response.output.length) {
      response.output.push({
        id: randomId('msg'),
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '', annotations: [] }],
      });
    }
    return response;
  }
}

/**
 * Trae usage -> the Responses `usage` object.
 *
 * Codex deserializes all four counts as required integers, so the estimate
 * fallback is not cosmetic: a missing or `null` usage makes `response.completed`
 * unparseable and the whole turn dies as "stream closed before response.completed".
 * @param {object|null} usage
 * @param {{promptText?: string, completionText?: string, reasoningText?: string}} fallback
 */
export function responsesUsage(usage, fallback = {}) {
  const source = usage && typeof usage === 'object' ? (usage.usage ?? usage) : {};
  const prompt = Number(source.prompt_tokens ?? source.input_tokens ?? 0) || 0;
  const completion = Number(source.completion_tokens ?? source.output_tokens ?? 0) || 0;
  const total = Number(source.total_tokens ?? 0) || prompt + completion;
  const cached = Number(
    source.prompt_tokens_details?.cached_tokens ??
      source.cache_read_input_tokens ??
      source.cached_tokens ??
      0,
  ) || 0;
  const reasoning = Number(
    source.completion_tokens_details?.reasoning_tokens ?? source.reasoning_tokens ?? 0,
  ) || 0;

  if (prompt === 0 && completion === 0 && total === 0) {
    const estimatedIn = estimateTokens(fallback.promptText);
    const estimatedOut =
      estimateTokens(fallback.completionText) + estimateTokens(fallback.reasoningText);
    return {
      input_tokens: estimatedIn,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: estimatedOut,
      output_tokens_details: { reasoning_tokens: estimateTokens(fallback.reasoningText) },
      total_tokens: estimatedIn + estimatedOut,
    };
  }

  return {
    input_tokens: prompt,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: completion,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: total || prompt + completion,
  };
}

/**
 * Map a thrown upstream error to a Responses error code Codex understands.
 *
 * The default (`upstream_error`) is *retryable* in Codex, which would burn five
 * retries on an exhausted Trae quota. Quota codes below are terminal instead,
 * so the user sees "quota exceeded" on the first attempt.
 * @param {Error & {code?: number}} err
 * @returns {string}
 */
export function errorCodeOf(err) {
  const message = String(err?.message ?? '');
  const code = err?.code;
  if (code === 4008 || /exceeded the quota|quota/i.test(message)) return 'insufficient_quota';
  if (/context (window|length)|上下文/i.test(message)) return 'context_length_exceeded';
  return 'upstream_error';
}

/**
 * The HTTP status that goes with {@link errorCodeOf} when the failure happens
 * before the stream opened.
 *
 * 429 + `insufficient_quota` is the shape Codex maps to a terminal
 * `QuotaExceeded`; a 502 would land in the generic `UnexpectedStatus` branch
 * and look retryable. A `context_length_exceeded` body is a `400`.
 * @param {Error & {code?: number}} err
 * @returns {number}
 */
export function errorStatusOf(err) {
  switch (errorCodeOf(err)) {
    case 'insufficient_quota':
      return 429;
    case 'context_length_exceeded':
      return 400;
    default:
      return 502;
  }
}

/** The error `type` Codex reads alongside `code` for a 429 quota rejection. */
export function errorTypeOf(err) {
  return errorCodeOf(err) === 'insufficient_quota' ? 'insufficient_quota' : 'upstream_error';
}
