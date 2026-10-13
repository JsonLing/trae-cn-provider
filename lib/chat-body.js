// chat-body.js - assemble the Trae `llm_utils_chat` request body.
//
// Two wire styles are supported; exactly one of them is verified against the
// live gateway (measured, not inferred — see PROTOCOL.md §B):
//
//   chat_v3 (DEFAULT, verified working)
//     {messages, function, stream, config_name, model, model_name,
//      config_source, is_custom_model, provider, tools, tool_choice}
//     Measured against the real endpoint with the real model catalog:
//     text, reasoning, usage and native function calling all round-trip.
//     `config_name` is required here — without it the gateway answers
//     "We're sorry, the param is invalid."; `model`/`model_name` must be the
//     catalog's `model_detail_list[].model_name` (it carries a `__dev` suffix).
//
//   inline_chat (optional, measured failing)
//     {messages, model, function:'inline_chat', stream:true,
//      request_id, session_id}
//     Kept only for experiment. Measured failures: on a current build it
//     routes and then dies with "model service is unavailable ... 500
//     ModelLoading"; on an older `app_version_code` the gateway answers
//     "no function config found for appId=..., function=inline_chat".
//     Do not make this the default.
//
// `reasoning_effort` is passed through **only** when the resolved model
// declares a `reasoning_effort_config`; it is never defaulted or hard-coded
// here, because upstream rejects combinations it did not advertise and the set
// of legal values is still being probed (a bogus value surfaces as
// "Invalid combination of reasoning_effort and thinking type: <x> + disabled").
import { num, pick } from './support.js';

/** Turn DSH `ToolSchema[]` into Trae tool definitions (`parameters` as a string). */
export function toTraeTools(tools) {
  const converted = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const fn = tool?.function ?? (tool?.name ? tool : null);
    if (!fn?.name) continue;
    converted.push({
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description || '',
        // The upstream requires a JSON *string* here, unlike OpenAI's object.
        parameters: typeof fn.parameters === 'string' ? fn.parameters : JSON.stringify(fn.parameters ?? {}),
      },
    });
  }
  return converted;
}

/**
 * Read the reasoning effort that may be forwarded upstream.
 * @param {object} options - `GenerateOptions`.
 * @param {object} info - resolved model info (`LlmResolvedModelInfo`).
 * @returns {string | undefined} a Trae-native effort id (`low` / `high` / ...).
 */
export function reasoningEffortFor(options, info) {
  const declared = info?.reasoning?.efforts;
  if (!Array.isArray(declared) || declared.length === 0) return undefined;
  const requested = options?.reasoningEffort ?? info?.reasoning?.defaultEffort;
  if (requested === undefined || requested === null || requested === '') return undefined;
  const match = declared.find((effort) => effort.id === requested);
  return match ? match.id : undefined;
}

/**
 * Build one Trae chat request body.
 * @param {object} input
 * @param {object[]} input.messages - Trae wire messages from `toTraeMessages`.
 * @param {readonly any[]} [input.tools] - DSH `ToolSchema[]`.
 * @param {object} input.info - resolved model info.
 * @param {object} input.options - `GenerateOptions`.
 * @param {string} [input.requestStyle] - `chat_v3` (default, verified) or `inline_chat`.
 * @param {boolean} [input.toolChoiceEnabled] - emit `tool_choice` (chat_v3 only).
 * @returns {object} the request body.
 */
export function buildChatBody({
  messages,
  tools,
  info,
  options,
  requestStyle = 'chat_v3',
  toolChoiceEnabled = true,
}) {
  const configName = info?.configName || info?.id || '';
  const modelName = info?.modelName || configName;
  const body = {
    messages,
    model: modelName || configName,
    stream: true,
  };
  // Both styles are happy with a per-request pairing id; only inline_chat is
  // documented to want it, and the gateway ignores unknown fields.
  const requestId = options?.requestId;
  if (requestStyle === 'inline_chat') {
    body.function = info?.function || 'inline_chat';
    if (requestId) {
      body.request_id = requestId;
      body.session_id = options?.sessionId ?? requestId;
    }
  } else {
    body.function = info?.function || 'chat_v3';
    body.config_name = configName;
    body.model_name = modelName || configName;
    body.config_source = info?.configSource ?? 1;
    body.is_custom_model = false;
    body.provider = info?.provider ?? '';
    if (requestId) body.request_id = requestId;
  }

  const effort = reasoningEffortFor(options, info);
  if (effort) body.reasoning_effort = effort;

  const converted = toTraeTools(tools);
  if (converted.length && options?.toolChoice !== 'none') {
    body.tools = converted;
    if (toolChoiceEnabled) body.tool_choice = 'auto';
  }
  return body;
}

const firstNumber = (source, keys) => {
  const value = num(source, keys, Number.NaN);
  return Number.isFinite(value) ? value : 0;
};

/**
 * Map one Trae `token_usage` payload onto DSH `TokenUsage`.
 *
 * DSH keeps counts disjoint: `inputTokens` is uncached input only, with cached
 * input reported separately as `cacheReadTokens`/`cacheWriteTokens`. Trae
 * reports an OpenAI-style *aggregate* `prompt_tokens`, so the cache-read count
 * is subtracted back out. `totalTokens` is preserved as the provider's own
 * full-call total when it supplies one.
 * @param {any} usage - upstream usage, flat or already nested under `usage`.
 * @returns {{inputTokens: number, outputTokens: number, totalTokens?: number,
 *   cacheReadTokens?: number, cacheWriteTokens?: number, reasoningTokens?: number}}
 */
export function toTokenUsage(usage) {
  const source = usage && typeof usage === 'object' ? (usage.usage ?? usage) : {};
  const prompt = firstNumber(source, ['prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens']);
  const completion = firstNumber(source, [
    'completion_tokens',
    'completionTokens',
    'output_tokens',
    'outputTokens',
  ]);
  const details = source.prompt_tokens_details ?? source.promptTokensDetails ?? {};
  const completionDetails = source.completion_tokens_details ?? source.completionTokensDetails ?? {};
  const cacheRead = firstNumber(source, ['cache_read_input_tokens', 'cache_read_tokens', 'cached_tokens']) ||
    firstNumber(details, ['cached_tokens', 'cache_read_input_tokens']);
  const cacheWrite = firstNumber(source, [
    'cache_creation_input_tokens',
    'cache_write_input_tokens',
    'cache_creation_tokens',
  ]);
  const reasoning = firstNumber(source, ['reasoning_tokens', 'reasoningTokens']) ||
    firstNumber(completionDetails, ['reasoning_tokens']);

  const result = {
    // Aggregate prompt count minus the cache hits, clamped so a provider that
    // reports `prompt_tokens` as uncached already cannot go negative.
    inputTokens: Math.max(0, prompt - cacheRead),
    outputTokens: completion,
  };
  const total = firstNumber(source, ['total_tokens', 'totalTokens']);
  if (total > 0) result.totalTokens = total;
  if (cacheRead > 0) result.cacheReadTokens = cacheRead;
  if (cacheWrite > 0) result.cacheWriteTokens = cacheWrite;
  if (reasoning > 0) result.reasoningTokens = reasoning;
  return result;
}

export { pick };
