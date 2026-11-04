#!/usr/bin/env node
// test/smoke-codex-catalog.js - the Codex model-picker catalog.
//
//   node test/smoke-codex-catalog.js
//
// This suite exists because the catalog is the one part of the Codex bridge
// that fails *silently*: a malformed entry is dropped by Codex without a word,
// and the desktop picker just shows "Custom". Every rule asserted below was
// found the hard way, against the real client:
//
//   * `ModelInfo` needs a complete key set; a missing key drops the entry.
//   * `model_messages` and `base_instructions` must not BOTH be null.
//   * `slug` must be the `configName` the Responses route can resolve.
//   * aliases exist because the desktop picker ships slugs (`deepseek-flash`)
//     that do not exist upstream; without them those picks 404.
import { assert, assertEqual, mockFetch, sse, sseResponse, test, installShims, load } from './support.js';

installShims();

const { TraeProvider, createServer } = await load('src/openai-server.js');
const { adaptInstructions, buildCatalog, catalogEtag, FALLBACK_INSTRUCTIONS, toModelInfo } = await load('src/codex-catalog.js');

const realFetch = globalThis.fetch;

const MODELS = [
  {
    configName: 'DeepSeek-V4.1-Flash-1017',
    name: 'DeepSeek V4.1 Flash 1017',
    modelName: 'DeepSeek-V4.1-Flash-1017__dev',
    supportThinking: true,
    effortOptions: ['low', 'high'],
    contextWindow: 200000,
    maxMode: false,
    maxContextWindow: 0,
    vision: false,
  },
  {
    configName: 'Doubao-Seed-Evolving',
    name: 'Doubao Seed Evolving',
    supportThinking: true,
    effortOptions: [],
    contextWindow: 0,
    maxMode: false,
    maxContextWindow: 0,
    vision: true,
  },
];

/** Every key Codex's `ModelInfo` deserializer knows about. */
const REQUIRED_KEYS = [
  'slug',
  'display_name',
  'description',
  'default_reasoning_level',
  'supported_reasoning_levels',
  'shell_type',
  'visibility',
  'supported_in_api',
  'priority',
  'additional_speed_tiers',
  'service_tiers',
  'availability_nux',
  'upgrade',
  'model_messages',
  'include_skills_usage_instructions',
  'include_plugin_usage_instructions',
  'include_apps_usage_instructions',
  'supports_reasoning_summary_parameter',
  'default_reasoning_summary',
  'support_verbosity',
  'default_verbosity',
  'apply_patch_tool_type',
  'web_search_tool_type',
  'truncation_policy',
  'supports_image_detail_original',
  'context_window',
  'max_context_window',
  'comp_hash',
  'effective_context_window_percent',
  'experimental_supported_tools',
  'input_modalities',
  'supports_search_tool',
  'supports_experimental_context',
  'use_responses_lite',
  'supports_reasoning_effort_updates',
  'node_repl_auto_review_required',
  'node_repl_disabled',
  'multi_agent_version',
  'auto_review_model_override',
  'model_specialty',
  'tool_mode',
  'multi_agent_reasoning_effort',
  'auto_compact_token_limit',
  'default_service_tier',
  'base_instructions',
];

async function makeProvider(aliases = null) {
  const provider = new TraeProvider({
    env: { ideVersion: '3.4.1', appVersionCode: 20260901, ideVersionCode: '20260901', source: 'test' },
    credentials: { token: 't0', refreshToken: 'r0', userId: '1', expiresAt: 0, host: 'http://trae-test.invalid' },
    logger: {},
    aliases,
  });
  provider.catalog = MODELS.map((m) => ({ ...m }));
  provider.catalogAt = Date.now();
  return provider;
}

async function startServer(provider) {
  const server = createServer(provider, {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

console.log('smoke-codex-catalog:');

// ------------------------------------------------------------- entry shape
await test('every entry carries the complete ModelInfo key set', async () => {
  // A missing key does not degrade — Codex drops the WHOLE entry, and the
  // picker silently shows nothing. This is why the builder emits all keys
  // explicitly rather than only the non-default ones.
  const info = toModelInfo(MODELS[0], 1);
  const missing = REQUIRED_KEYS.filter((key) => !(key in info));
  assertEqual(missing, [], 'no expected field is absent');
  assertEqual(Object.keys(info).length, REQUIRED_KEYS.length, 'and nothing unexpected is added');
});

await test('at least one of model_messages / base_instructions is a real value', async () => {
  // Measured: with BOTH null the entry fails validation and never appears in
  // the picker; supplying either one makes it appear. This is the single
  // subtlest requirement in the whole catalog.
  const info = toModelInfo(MODELS[0], 1);
  const hasMessages = info.model_messages && typeof info.model_messages === 'object';
  const hasBase = typeof info.base_instructions === 'string' && info.base_instructions.length > 0;
  assert(hasMessages || hasBase, 'one of the two is populated');
});

await test('instructions keep Codex\u2019s own text and only rewrite the identity clause', async () => {
  // `instructions_template` REPLACES the system prompt rather than extending
  // it (codex-protocol/src/openai_models.rs). A one-line placeholder therefore
  // leaves the model with no identity, and it answers "which model are you?"
  // from names it saw in the conversation — measured: glm-5.3-flash called
  // itself DeepSeek right after a turn that mentioned DeepSeek. So the real
  // Codex text must survive, with just the `based on GPT-x` claim corrected.
  const codexText =
    'You are Codex, an agent based on GPT-6. You and the user share one workspace, and your job is to collaborate with them.';
  const adapted = adaptInstructions(codexText, 'GLM-5.3-Flash');
  assert(adapted.includes('GLM-5.3-Flash'), 'the model names itself');
  assert(!/GPT-6/.test(adapted), 'and does not claim to be GPT-6');
  assert(adapted.includes('You and the user share one workspace'), 'the rest of the prompt is preserved');
  assertEqual(adapted.length > codexText.length, true, 'the prompt grows rather than collapses to a stub');

  // Without a real source the fallback is still a coherent agent prompt — not
  // an empty string, which would also fail validation.
  assertEqual(adaptInstructions(null, 'X'), FALLBACK_INSTRUCTIONS, 'no source falls back, never empty');
  assert(adaptInstructions(undefined, 'X').length > 20, 'the fallback is a usable prompt');
});

await test('every catalog entry carries a substantial system prompt', async () => {
  // A stub here is not cosmetic: it silently rewrites the agent's behaviour.
  const catalog = buildCatalog(MODELS, null, null, 'You are Codex, an agent based on GPT-6. ' + 'x'.repeat(500));
  for (const info of catalog.models) {
    const text = info.model_messages?.instructions_template ?? '';
    assert(text.length > 100, `${info.slug} carries a real prompt (got ${text.length} chars)`);
    assert(text.includes(info.display_name), `${info.slug} names itself in the prompt`);
  }
});

await test('the slug is the upstream wire name, not the friendly display name', async () => {
  // `slug` is what the picker shows AND what Codex sends back as `model`.
  // Using the display name would make the resulting request 404.
  const info = toModelInfo(MODELS[0], 1);
  assertEqual(info.slug, MODELS[0].configName, 'slug is configName');
  assertEqual(info.display_name, MODELS[0].name, 'display_name is the friendly name');
});

await test('picker-visible, API-supported entries are the only ones emitted', async () => {
  for (const info of buildCatalog(MODELS, null).models) {
    assertEqual(info.visibility, 'list', `${info.slug} is picker-visible`);
    assertEqual(info.supported_in_api, true, `${info.slug} is API-supported`);
  }
});

// --------------------------------------------------------------- ordering
await test('the configured default model sorts first', async () => {
  // Codex marks the first picker-visible entry as the default for new chats,
  // so an unprioritised list makes every session start on Doubao.
  const catalog = buildCatalog(MODELS, 'DeepSeek-V4.1-Flash-1017');
  assertEqual(catalog.models[0].slug, 'DeepSeek-V4.1-Flash-1017', 'the default leads');
  assertEqual(catalog.models.map((m) => m.priority), [1, 2], 'priorities are assigned in order');
});

await test('an unknown default leaves the upstream order untouched', async () => {
  const catalog = buildCatalog(MODELS, 'retired-model');
  assertEqual(catalog.models.map((m) => m.slug), MODELS.map((m) => m.configName), 'order preserved');
});

// ---------------------------------------------------------------- aliases
await test('an alias is exposed as a pickable entry pointing at the real model', async () => {
  const catalog = buildCatalog(MODELS, null, { 'deepseek-flash': 'DeepSeek-V4.1-Flash-1017' });
  const alias = catalog.models.find((m) => m.slug === 'deepseek-flash');
  assert(alias, 'the alias appears in the catalog');
  assertEqual(alias.context_window, 200000, 'it carries the target model\u2019s capabilities');
  assertEqual(alias.visibility, 'list', 'and is picker-visible');
});

await test('an alias whose target is absent is skipped, not emitted broken', async () => {
  // A stale alias must not produce an entry that would 404 when selected.
  const catalog = buildCatalog(MODELS, null, { 'ghost-model': 'No-Such-Model' });
  assertEqual(catalog.models.map((m) => m.slug), MODELS.map((m) => m.configName), 'nothing extra appears');
});

await test('a provider resolves an alias to the target catalog entry', async () => {
  const provider = await makeProvider({ 'deepseek-flash': 'DeepSeek-V4.1-Flash-1017' });
  const resolved = provider.resolveModel('deepseek-flash');
  assertEqual(resolved.configName, 'DeepSeek-V4.1-Flash-1017', 'the alias resolves to the real entry');
  // An alias must win over the fuzzy matcher: `deepseek-flash` would otherwise
  // substring-match `DeepSeek-V4.1-Flash` and route to the wrong model.
  assertEqual(provider.resolveModel('DeepSeek-V4.1-Flash-1017').configName, 'DeepSeek-V4.1-Flash-1017', 'a real name still resolves');
  assertEqual(provider.resolveModel('nonsense'), null, 'an unknown name is not invented');
});

// ------------------------------------------------------------- HTTP surface
await test('GET /v1/models/catalog serves the ModelInfo envelope with an ETag', async () => {
  const provider = await makeProvider();
  const server = await startServer(provider);
  try {
    const res = await realFetch(`${server.base}/v1/models/catalog?client_version=0.166.0`);
    assertEqual(res.status, 200, 'answers 200');
    const etag = res.headers.get('etag');
    assert(etag, 'carries an ETag so Codex can revalidate');
    const body = await res.json();
    // Unlike /v1/models this is NOT `{object, data}`: it is a single-key object.
    assertEqual(Object.keys(body), ['models'], 'exactly one top-level key');
    assertEqual(body.models.length, MODELS.length, 'every model is present');

    const revalidated = await realFetch(`${server.base}/v1/models/catalog`, {
      headers: { 'If-None-Match': etag },
    });
    assertEqual(revalidated.status, 304, 'a matching ETag short-circuits to 304');
  } finally {
    await server.close();
  }
});

await test('the catalog route is mounted under the plugin prefix too', async () => {
  // The DSH plugin strips `/trae-cn` before calling the handler, so the inner
  // path is `/v1/...`; both forms are accepted for a direct hit.
  const provider = await makeProvider();
  const server = await startServer(provider);
  try {
    const res = await realFetch(`${server.base}/models/catalog`);
    assertEqual(res.status, 200, 'the unprefixed path works as well');
    const body = await res.json();
    assertEqual(body.models.length, MODELS.length, 'and returns the same catalog');
  } finally {
    await server.close();
  }
});

await test('an aliased model actually completes through /v1/responses', async () => {
  // The alias is only worth having if the request it enables succeeds.
  const provider = await makeProvider({ 'deepseek-flash': 'DeepSeek-V4.1-Flash-1017' });
  const server = await startServer(provider);
  const mock = mockFetch(() =>
    sseResponse(
      sse('output', { content: 'ok' }) +
        sse('token_usage', { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }) +
        sse('done', { finish_reason: 'stop' }),
    ),
  );
  try {
    const res = await realFetch(`${server.base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', stream: false, input: 'hi' }),
    });
    assertEqual(res.status, 200, 'the alias is accepted');
    const body = await res.json();
    const text = body.output.find((item) => item.type === 'message').content[0].text;
    assertEqual(text, 'ok', 'and returns the model text');
    assertEqual(body.model, 'DeepSeek-V4.1-Flash-1017', 'the response names the real model, not the alias');
  } finally {
    mock.restore();
    await server.close();
  }
});

await test('ETag is stable across identical catalogs and changes with content', async () => {
  const a = buildCatalog(MODELS, null);
  const b = buildCatalog(MODELS, null);
  assertEqual(catalogEtag(a), catalogEtag(b), 'the same input yields the same ETag');
  const c = buildCatalog(MODELS, 'Doubao-Seed-Evolving');
  assert(catalogEtag(a) !== catalogEtag(c), 'different ordering yields a different ETag');
});
