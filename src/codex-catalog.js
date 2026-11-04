// codex-catalog.js - the model picker catalog Codex reads from a provider.
//
// Why: Codex's desktop model picker is driven by `ModelInfo` entries, and
// `model_catalog_json` REPLACES the entire bundled catalog (the bundled one
// ships gpt-6-astra, gpt-5.5, ... — none of which exist in our gateway). A
// provider can instead advertise its own catalog URL:
//
//     [model_providers.trae]
//     model_catalog_url = "http://127.0.0.1:8317/v1/models/catalog"
//
// Codex then GETs that URL (measured: `GET /models/catalog?client_version=...`
// carrying the provider's `Authorization` header) and uses the response
// INSTEAD of the bundled catalog. Because a provider's catalog is resolved
// per provider, the picker shows Trae models while `model_provider = "trae"`
// and DeepSeek's provider keeps its own list — the two do not collide.
//
// **Every field must be present, even when its value is `null`.** Codex
// deserializes `ModelInfo` strictly; a missing key makes the whole entry fail
// to parse and the model is dropped silently (measured: an entry missing
// `base_instructions` produced an empty picker, and adding any one of the
// missing keys made it appear). This is why the builder emits a complete
// object rather than "only what differs from the defaults".
//
// The response shape is `{models: ModelInfo[]}` — a single-key object, unlike
// `/v1/models`, which uses the OpenAI `{object, data}` envelope.
import crypto from 'node:crypto';

/** Reasoning-effort presets Codex understands, for models that think. */
const EFFORT_PRESETS = {
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
};

/**
 * `instructions_template` is applied as LITERAL system text — Codex does not
 * merge it with its built-in prompt (see `base_instructions` in
 * `codex-protocol/src/openai_models.rs`: the template *replaces* it).
 *
 * A one-line placeholder therefore strips the agent of its identity, and a
 * model asked "which model are you?" will answer from whatever names it can
 * see in the conversation instead of naming itself. Measured: with a stub
 * template, `glm-5.3-flash` described itself as DeepSeek because the previous
 * turn had mentioned it.
 *
 * The fix is not to invent a prompt but to reuse Codex's own: this text is
 * handed over by the caller (read from the bundled catalog, see
 * `codexInstructions()` in `src/cli.js`). Only the model-identity clause is
 * rewritten, because claiming to be "based on GPT-6" would be a lie for a
 * Trae-hosted model.
 */
export const FALLBACK_INSTRUCTIONS =
  'You are a coding agent working in the user\u2019s workspace. Be precise, safe and helpful.';

/**
 * Adapt Codex's own instructions to a Trae-hosted model.
 *
 * Only the identity clause changes — everything else (tool-use rules, editing
 * constraints, communication style) is what makes Codex behave like Codex.
 * @param {string|null|undefined} text
 * @param {string} displayName
 * @returns {string}
 */
export function adaptInstructions(text, displayName) {
  const source = typeof text === 'string' && text.trim() ? text : FALLBACK_INSTRUCTIONS;
  // `You are Codex, an agent based on GPT-6.` and similar variants.
  return source.replace(
    /You are Codex, an agent based on [^.]+\./,
    `You are Codex, a coding agent running on the ${displayName} model.`,
  );
}

/**
 * Trae's `effortOptions` -> Codex's `supported_reasoning_levels`.
 *
 * Codex only knows low/medium/high/xhigh/max/ultra; an unknown id would make
 * the picker show an option the model cannot honour, so anything outside the
 * known set is dropped rather than passed through.
 * @param {object} model
 */
function reasoningLevelsOf(model) {
  const declared = Array.isArray(model.effortOptions)
    ? model.effortOptions.map((effort) => String(effort).toLowerCase())
    : [];
  const known = declared.filter((effort) => EFFORT_PRESETS[effort]);
  const list = known.length ? known : ['low', 'high'];
  return list.map((effort) => ({ effort, description: EFFORT_PRESETS[effort] }));
}

/**
 * One Trae catalog entry -> one Codex `ModelInfo`.
 *
 * `slug` is both what the picker shows and what Codex sends back as `model`,
 * so it must be the `configName` our `/v1/responses` route can resolve — using
 * the friendly display name would 404 for models whose name differs from the
 * wire name.
 * @param {object} model - a `listModels()` entry.
 * @param {number} priority - lower sorts first; Codex marks the first
 *   picker-visible entry as the default for new chats.
 */
export function toModelInfo(model, priority, instructions = null) {
  const levels = reasoningLevelsOf(model);
  // `maxMode` entries advertise a larger window than the plain variant.
  const contextWindow = (model.maxMode ? model.maxContextWindow : model.contextWindow) || 0;
  const displayName = model.name || model.configName;

  return {
    slug: model.configName,
    display_name: displayName,
    description: model.maxMode ? `${displayName}（Max 上下文）` : displayName,
    default_reasoning_level: model.supportThinking ? levels[levels.length - 1]?.effort ?? 'high' : null,
    supported_reasoning_levels: levels,
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    // Trae has no speed or service tiers; advertising them would put options
    // in the UI that the upstream cannot honour.
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    // Must not be null — see adaptInstructions(). Without it the entry fails
    // validation (both fields null) OR the model loses its identity (a stub
    // template replaces Codex's whole prompt rather than adding to it).
    model_messages: { instructions_template: adaptInstructions(instructions, displayName) },
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: true,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    default_verbosity: null,
    // Trae accepts the OpenAI-style function tools our Responses route sends,
    // so Codex can use its normal `apply_patch` tool.
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_image_detail_original: Boolean(model.vision),
    context_window: contextWindow || null,
    max_context_window: contextWindow || null,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: model.vision ? ['text', 'image'] : ['text'],
    supports_search_tool: false,
    supports_experimental_context: false,
    use_responses_lite: false,
    supports_reasoning_effort_updates: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    // Codex's multi-agent tooling is unrelated to the upstream model, and every
    // extra tool is another chance to trip Trae's tool-name charset check.
    multi_agent_version: null,
    auto_review_model_override: null,
    model_specialty: null,
    tool_mode: null,
    multi_agent_reasoning_effort: null,
    auto_compact_token_limit: null,
    default_service_tier: null,
    base_instructions: null,
  };
}

/**
 * The whole catalog, ordered the way the picker should read.
 *
 * The configured default model goes first: Codex treats the first
 * picker-visible entry as the default, so leaving the upstream's own order
 * would make every new chat start on `Doubao-Seed-Evolving`.
 * @param {object[]} models - `listModels()` output.
 * @param {string|null} [defaultModel]
 * @returns {{models: object[]}}
 */
export function buildCatalog(models, defaultModel = null, aliases = null, instructions = null) {
  const list = Array.isArray(models) ? models : [];
  // Alias entries lead the list so a caller hardcoding another provider's slug
  // (`deepseek-flash`) can still find it. They point at the real Trae model, so
  // selecting one works instead of 404ing.
  const combined = [...list];
  for (const [from, to] of Object.entries(aliases ?? {})) {
    const target = list.find((m) => String(m.configName).toLowerCase() === String(to).toLowerCase());
    if (!target) continue;
    if (combined.some((m) => String(m.configName).toLowerCase() === from.toLowerCase())) continue;
    combined.unshift({ ...target, configName: from, name: `${target.name}（别名 ${from}）` });
  }

  // The configured default goes first: Codex marks the first picker-visible
  // entry as the default for new chats.
  const want = String(defaultModel ?? '').trim().toLowerCase();
  let ordered = combined;
  if (want) {
    const index = combined.findIndex(
      (model) =>
        String(model.configName).toLowerCase() === want || String(model.name).toLowerCase() === want,
    );
    if (index > 0) ordered = [combined[index], ...combined.slice(0, index), ...combined.slice(index + 1)];
  }
  return { models: ordered.map((model, i) => toModelInfo(model, i + 1, instructions)) };
}

/**
 * A stable ETag for a catalog, so Codex can revalidate with `If-None-Match`
 * instead of re-reading the body on every picker open.
 * @param {{models: object[]}} catalog
 * @returns {string}
 */
export function catalogEtag(catalog) {
  const digest = crypto.createHash('sha1').update(JSON.stringify(catalog)).digest('hex');
  return `"${digest.slice(0, 16)}"`;
}
