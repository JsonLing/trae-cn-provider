#!/usr/bin/env node
// test/smoke-adapter.js - unit-level smoke test of the DSH adapter contract.
//
// Everything the network would do is scripted: the model catalog comes from a
// canned `get_detail_param` payload and the chat channel from a canned SSE
// byte stream, so the assertions below are about *this plugin's* translation,
// not about upstream availability. Only global `fetch` is stubbed; the real
// `src/trae-client.js` SSE parser runs.
//
//   node test/smoke-adapter.js
import { assert, assertEqual, assistantToolCall, installShims, load, mockFetch, recordingLogger, sse, sseResponse, test, toolResultMessage, userMessage } from './support.js';

installShims();

const { TraeAdapter } = await load('lib/adapter.js');
const { toTraeMessages, withSystemMessage } = await load('lib/messages.js');
const { toTokenUsage, reasoningEffortFor, buildChatBody } = await load('lib/chat-body.js');
const { llm } = await load('lib/llm.js');

const ENV = { ideVersion: '3.4.1', appVersionCode: 20260401, ideVersionCode: '20260401', source: 'test' };
const CREDS = {
  source: 'oauth',
  clientId: 'client-under-test',
  token: 'fake-access-token-not-a-real-secret',
  refreshToken: 'fake-refresh-token',
  userId: '429404416',
  username: 'tester',
  expiresAt: 0,
  host: 'https://api.trae.cn',
  deviceInfo: { DeviceID: 'device-1', MachineID: 'machine-1' },
};

/** The canonical catalog payload: one config with reasoning, one without. */
const CATALOG = {
  code: 0,
  data: {
    config_info_list: [
      {
        config_name: 'Doubao-Seed-Code',
        config_source: 1,
        display_config: { display_name: 'Doubao Seed Code', multimodal: false },
        context_window_tokens: { dev: 256000 },
        // The parent confirmed `reasoning_effort_config` lives at the
        // config_info level, not inside model_detail_list.
        reasoning_effort_config: { options: ['low', 'high', 'extra_high'], default_level: 'high' },
        model_detail_list: [{ model_name: 'Doubao-Seed-Code__dev', max_tokens: 32000 }],
      },
      {
        config_name: 'glm-5.2',
        config_source: 1,
        display_config: { display_name: 'GLM 5.2', multimodal: true },
        context_window_tokens: { dev: 200000 },
        // No reasoning_effort_config: efforts must stay undefined (never []).
        model_detail_list: [{ model_name: 'glm-5.2__dev' }],
      },
    ],
  },
};

/** One full SSE exchange exercising every chunk type this adapter emits. */
const STREAM = [
  sse('output', { reasoning: 'Let me think. ' }),
  sse('output', { reasoning_content: 'Still thinking.' }),
  sse('output', { content: 'Hello' }),
  sse('output', { content: ', world' }),
  sse('output', { response: '!' }),
  sse('token_usage', {
    prompt_tokens: 1000,
    completion_tokens: 40,
    total_tokens: 1040,
    cache_read_input_tokens: 900,
    reasoning_tokens: 12,
  }),
  sse('done', {
    finish_reason: 'tool_calls',
    tool_calls: [
      {
        index: 0,
        id: 'call_upstream_1',
        function_call: { name: 'read_file', arguments: '{"path":"a.txt"}' },
      },
    ],
  }),
  'data: [DONE]\n\n',
].join('');

/** A stub credential store: the adapter only needs `read()` and `source`. */
function stubStore(creds = CREDS) {
  return { source: creds?.source ?? 'oauth', read: async () => creds };
}

/** Build one adapter with the scripted environment. */
function makeAdapter({ creds = CREDS, logger = recordingLogger(), requestStyle = 'inline_chat' } = {}) {
  return {
    logger,
    adapter: new TraeAdapter({
      ctx: { get: () => undefined },
      env: ENV,
      credentials: stubStore(creds),
      logger,
      requestStyle,
      catalogTtlMs: 60_000,
    }),
  };
}

console.log('smoke-adapter:');

await test('chat_v3 carries the harness session id so a tenant gateway can bill a seat', async () => {
  const mock = mockFetch((url) => {
    if (url.includes('get_detail_param')) return CATALOG;
    if (url.includes('llm_utils_chat')) return sseResponse(STREAM);
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const { adapter } = makeAdapter({ requestStyle: 'chat_v3' });
    for await (const _chunk of adapter.stream({
      provider: 'trae-cn',
      model: 'glm-5.2',
      sessionId: 'sess-from-harness',
      messages: [userMessage('hi')],
    })) {
      // drain
    }
    const call = mock.calls.find((entry) => entry.url.includes('llm_utils_chat'));
    const body = JSON.parse(call.init.body);
    assertEqual(body.function, 'chat_v3', 'function');
    assertEqual(body.session_id, 'sess-from-harness', 'session_id');
    assertEqual(body.conversation_id, 'sess-from-harness', 'conversation_id');
  } finally {
    mock.restore();
  }
});

await test('listModels maps the catalog to LlmModelInfo and never returns []', async () => {
  const mock = mockFetch((url) => {
    if (url.includes('get_detail_param')) return CATALOG;
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const { adapter } = makeAdapter();
    const models = await adapter.listModels('trae-cn');
    assertEqual(
      models.map((model) => [model.provider, model.id, model.name, model.inputModalities]),
      [
        ['trae-cn', 'Doubao-Seed-Code', 'Doubao Seed Code', ['text']],
        ['trae-cn', 'glm-5.2', 'GLM 5.2', ['text', 'image']],
      ],
      'catalog mapping',
    );
    // Every catalog request must carry the mandatory attribution header.
    for (const call of mock.calls) {
      assert(call.init.headers['user-agent'], `attribution header present on ${call.url}`);
    }
  } finally {
    mock.restore();
  }
});

await test('resolveModel carries contextWindow and Trae-native effort ids', async () => {
  const mock = mockFetch((url) => (url.includes('get_detail_param') ? CATALOG : {}));
  try {
    const { adapter } = makeAdapter();
    const withReasoning = await adapter.resolveModel('trae-cn', 'Doubao-Seed-Code');
    assertEqual(
      withReasoning.reasoning.efforts.map((effort) => effort.id),
      ['low', 'high', 'extra_high'],
      'effort ids are Trae-native values',
    );
    assertEqual(withReasoning.reasoning.defaultEffort, 'high', 'default effort');
    assertEqual(withReasoning.context.contextWindow, 256000, 'context window');

    const withoutReasoning = await adapter.resolveModel('trae-cn', 'glm-5.2');
    assertEqual(withoutReasoning.reasoning, undefined, 'no reasoning block when undeclared');
    assertEqual(withoutReasoning.inputModalities, ['text', 'image'], 'vision modality');
  } finally {
    mock.restore();
  }
});

await test('missing credentials raise LlmError MISSING_CREDENTIAL, not a crash', async () => {
  const { adapter, logger } = makeAdapter({ creds: null });
  let caught;
  try {
    await adapter.listModels('trae-cn');
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof llm.LlmError, 'is an LlmError');
  assertEqual(caught.code, 'MISSING_CREDENTIAL', 'code');
  assert(/trae-login/.test(caught.message), 'message names the login command');
  assert(/trae-login/.test(logger.text()), 'log line names the login command');
  assert(!/fake-access-token|fake-refresh-token/.test(caught.message + logger.text()), 'no token in message or log');
});

await test('a dead refresh token becomes an actionable REFRESH_FAILED, not "网络异常"', async () => {
  const mock = mockFetch((url) => {
    if (url.includes('get_detail_param')) return CATALOG;
    throw new Error(`unexpected ${url}`);
  });
  try {
    // Measured: the gateway answers a dead refresh token with its own business
    // code `30022 网络异常`, which reads like a transient network fault even
    // though the only recovery is a new login.
    const store = {
      source: 'oauth',
      read: async () => ({
        ...CREDS,
        expiresAt: Math.floor(Date.now() / 1000) - 60,
        refreshToken: 'stale-refresh-token',
      }),
      refresh: async () => {
        throw new Error('上游拒绝: 30022 网络异常');
      },
      write: async () => ({ record: false, file: false }),
    };
    const adapter = new TraeAdapter({ env: ENV, credentials: store, requestStyle: 'chat_v3', logger: recordingLogger() });

    let caught;
    try {
      await adapter.listModels('trae-cn');
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof llm.LlmError, 'is an LlmError');
    assertEqual(caught.code, 'REFRESH_FAILED', 'code');
    assert(/refresh token 已失效/.test(caught.message), 'message names the real cause');
    assert(/重新登录/.test(caught.message), 'message says how to recover');
    assert(/30022/.test(caught.message), 'the raw upstream reason is still visible');
    assert(!/stale-refresh-token/.test(caught.message), 'the refresh token itself is not echoed');
  } finally {
    mock.restore();
  }
});

/**
 * A store that behaves like the real one: `read` returns whatever `write` last
 * stored. Modelling that matters — an earlier version of this helper ignored
 * writes, which let a broken force-refresh path (writing `expiresAt: 0` while
 * `needsRefresh()` treats a falsy expiry as "do not refresh") pass the 401 test.
 */
function expiringStore({ delayMs = 0, expiresInSec = -60, failRefresh = null } = {}) {
  const state = {
    refreshes: 0,
    current: { ...CREDS, expiresAt: Math.floor(Date.now() / 1000) + expiresInSec },
  };
  state.store = {
    source: 'oauth',
    read: async () => state.current,
    refresh: async (creds) => {
      state.refreshes += 1;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (failRefresh) throw new Error(failRefresh);
      state.current = {
        ...creds,
        token: `rotated-${state.refreshes}`,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
      return state.current;
    },
    write: async (value) => {
      state.current = value;
      return { record: false, file: true };
    },
  };
  return state;
}

await test('concurrent callers share exactly one token refresh', async () => {
  // `ensureFresh()` has an `await` before it checks `this.refreshing`, so the
  // check-and-set has to stay synchronous after that await — otherwise two
  // in-flight requests would each rotate the token and one would be lost.
  const state = expiringStore({ delayMs: 25 });
  const adapter = new TraeAdapter({ env: ENV, credentials: state.store, requestStyle: 'chat_v3', logger: recordingLogger() });

  const [a, b] = await Promise.all([adapter.ensureFresh(), adapter.ensureFresh()]);
  assertEqual(state.refreshes, 1, 'one refresh served both callers');
  assert(a === b, 'both callers received the same credential object');
  assertEqual(a.token, 'rotated-1', 'the rotated token is the one in use');
});

await test('a rejected credential is retried once, then gives up', async () => {
  // The retry exists to absorb a token that expired between the check and the
  // call. It must not loop: an infinite refresh/retry cycle would hammer the
  // gateway and burn the refresh token.
  const state = expiringStore();
  const adapter = new TraeAdapter({ env: ENV, credentials: state.store, requestStyle: 'chat_v3', logger: recordingLogger() });

  let attempts = 0;
  const unauthorized = Object.assign(new Error('401 from upstream'), { httpStatus: 401 });
  let caught;
  try {
    await adapter.withAuthRetry(async () => {
      attempts += 1;
      throw unauthorized;
    });
  } catch (err) {
    caught = err;
  }
  assertEqual(attempts, 2, 'initial attempt plus exactly one retry');
  assertEqual(state.refreshes, 2, 'each attempt ran after its own refresh');
  assertEqual(caught, unauthorized, 'the original rejection surfaced instead of a wrapper');
});

await test('a failed refresh degrades while the access token is still valid', async () => {
  // `needsRefresh()` fires 30 minutes early, so a transient refresh failure must
  // not break a request the live token could still have served.
  const state = expiringStore({ expiresInSec: 600, failRefresh: '上游拒绝: 30022 网络异常' });
  const logger = recordingLogger();
  const adapter = new TraeAdapter({ env: ENV, credentials: state.store, requestStyle: 'chat_v3', logger });

  const creds = await adapter.ensureFresh();
  assertEqual(creds.token, CREDS.token, 'the still-valid credential is reused');
  assertEqual(state.refreshes, 1, 'a refresh was attempted first');
  assert(/尚未过期/.test(logger.text()), 'a warning explains the degradation');
  assert(!/fake-access-token/.test(logger.text()), 'no token in the log');
});

await test('a failed refresh on an expired token is fatal and actionable', async () => {
  const state = expiringStore({ expiresInSec: -60, failRefresh: '上游拒绝: 30022 网络异常' });
  const adapter = new TraeAdapter({ env: ENV, credentials: state.store, requestStyle: 'chat_v3', logger: recordingLogger() });

  let caught;
  try {
    await adapter.ensureFresh();
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof llm.LlmError, 'is an LlmError');
  assertEqual(caught.code, 'REFRESH_FAILED', 'code');
  assert(/refresh token 已失效/.test(caught.message), 'names the real cause');
  assert(/重新登录/.test(caught.message), 'says how to recover');
});

await test('stream emits block-start/delta/block-end, usage and finish in order', async () => {
  const bodyRef = {};
  const mock = mockFetch((url, init) => {
    if (url.includes('get_detail_param')) return CATALOG;
    if (url.includes('llm_utils_chat')) {
      bodyRef.body = JSON.parse(init.body);
      bodyRef.headers = init.headers;
      return sseResponse(STREAM);
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const { adapter } = makeAdapter();
    const chunks = [];
    for await (const chunk of adapter.stream({
      provider: 'trae-cn',
      model: 'glm-5.2',
      messages: [userMessage('please read a.txt')],
      system: 'You are a coding agent.',
      tools: [
        {
          name: 'read_file',
          description: 'read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ],
    })) {
      chunks.push(chunk);
    }

    const shape = chunks.map((chunk) => (chunk.type === 'finish' ? `finish:${chunk.reason.kind}` : chunk.type));
    assertEqual(
      shape,
      [
        'block-start',
        'reasoning-delta',
        'reasoning-delta',
        'block-end',
        'block-start',
        'text-delta',
        'text-delta',
        'text-delta',
        'block-end',
        'block-start',
        'tool-call-delta',
        'block-end',
        'usage',
        'finish:tool-calls',
      ],
      'chunk sequence',
    );

    // Reasoning precedes text because the upstream emitted it first.
    assertEqual(chunks[0].blockType, 'reasoning', 'first block is reasoning');
    assertEqual(chunks[1].text, 'Let me think. ', 'first reasoning delta');
    assertEqual(chunks[3].block, { type: 'reasoning', text: 'Let me think. Still thinking.' }, 'reasoning block-end');

    assertEqual(chunks[4].blockType, 'text', 'text block follows');
    assertEqual(chunks[8].block, { type: 'text', text: 'Hello, world!' }, 'text block-end');

    const toolDelta = chunks[10];
    assertEqual(toolDelta.name, 'read_file', 'tool name');
    assertEqual(toolDelta.argumentsDelta, '{"path":"a.txt"}', 'tool arguments delta is the raw JSON string');
    assertEqual(
      chunks[11].block,
      { type: 'tool-call', id: 'call_upstream_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      'tool-call block-end',
    );

    // Trae reports an aggregate prompt count; the harness wants uncached input.
    assertEqual(chunks[12].usage, {
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 1040,
      cacheReadTokens: 900,
      reasoningTokens: 12,
    }, 'TokenUsage mapping');

    // The wire body under requestStyle 'inline_chat': paired ids, JSON-string
    // tool parameters. `function` is NOT forced to 'inline_chat' — the resolved
    // model's own function wins, and the catalog declares `chat_v3`.
    const body = bodyRef.body;
    assertEqual(body.function, 'chat_v3', 'function follows the catalog declaration');
    assertEqual(body.model, 'glm-5.2__dev', 'model');
    assertEqual(body.stream, true, 'stream');
    assert(body.request_id && body.request_id === body.session_id, 'request_id paired with session_id');
    assertEqual(body.reasoning_effort, undefined, 'no reasoning_effort for a model that declares none');
    assertEqual(body.messages[0], { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] }, 'system slot');
    assertEqual(body.messages[1].content, [{ type: 'text', text: 'please read a.txt' }], 'user content parts');
    assertEqual(typeof body.tools[0].function.parameters, 'string', 'tool parameters are a JSON *string*');
    assertEqual(body.tool_choice, 'auto', 'tool_choice');

    // Mandatory attribution on the generation request.
    assert(bodyRef.headers['user-agent'], 'attribution header on the chat request');
    assert(bodyRef.headers['x-app-version-code'], 'app version code header');
    assert(/^\d+$/.test(String(bodyRef.headers['x-app-version-code'])), 'version code is a pure integer');
    assert(!/fake-access-token/.test(JSON.stringify(chunks)), 'no token in emitted chunks');
  } finally {
    mock.restore();
  }
});

await test('reasoning_effort is forwarded only when the model declares it', async () => {
  const bodies = [];
  const mock = mockFetch((url, init) => {
    if (url.includes('get_detail_param')) return CATALOG;
    if (url.includes('llm_utils_chat')) {
      bodies.push(JSON.parse(init.body));
      return sseResponse(`${sse('output', { content: 'ok' })}${sse('done', { finish_reason: 'stop' })}data: [DONE]\n\n`);
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const { adapter } = makeAdapter();
    const consume = async (model, reasoningEffort) => {
      for await (const _chunk of adapter.stream({
        provider: 'trae-cn',
        model,
        messages: [userMessage('hi')],
        ...(reasoningEffort ? { reasoningEffort } : {}),
      })) {
        /* drain */
      }
    };
    await consume('Doubao-Seed-Code', 'extra_high');
    await consume('Doubao-Seed-Code');
    await consume('glm-5.2', undefined);

    assertEqual(bodies[0].reasoning_effort, 'extra_high', 'declared + requested effort is passed through');
    assertEqual(bodies[1].reasoning_effort, 'high', 'declared default effort is passed through when omitted');
    assertEqual(bodies[2].reasoning_effort, undefined, 'undeclared model never gets an effort');
  } finally {
    mock.restore();
  }
});

await test('upstream failures become a terminal error finish with a stable code', async () => {
  const mock = mockFetch((url) => {
    if (url.includes('get_detail_param')) return CATALOG;
    if (url.includes('llm_utils_chat')) return { status: 429, body: 'slow down' };
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const { adapter, logger } = makeAdapter();
    const chunks = [];
    for await (const chunk of adapter.stream({
      provider: 'trae-cn',
      model: 'glm-5.2',
      messages: [userMessage('hi')],
    })) {
      chunks.push(chunk);
    }
    const finish = chunks.at(-1);
    assertEqual(finish.type, 'finish', 'terminal chunk is finish');
    assertEqual(finish.reason.kind, 'error', 'kind');
    assertEqual(finish.reason.failure.code, 'RATE_LIMIT', 'code');
    assert(/HTTP 429/.test(finish.reason.failure.message), 'upstream status in message');
    assert(!/fake-refresh-token/.test(logger.text()), 'no token in the log');
  } finally {
    mock.restore();
  }
});

await test('a 4008 on the wire becomes a QUOTA finish carrying the balance', async () => {
  const mock = mockFetch((url) => {
    if (url.includes('get_detail_param')) return CATALOG;
    if (url.includes('llm_utils_chat')) {
      return sseResponse(
        `${sse('notify_usage', { billing_mode: 'credits', cn_credits_remain_info: { ide_credits: 0, work_credits: 0 } })}` +
          `${sse('error', { code: 4008, message: 'Your requests have exceeded the quota.' })}` +
          `${sse('done', { finish_reason: 'stop' })}\n\n`,
      );
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const { adapter } = makeAdapter();
    const chunks = [];
    for await (const chunk of adapter.stream({
      provider: 'trae-cn',
      model: 'glm-5.2',
      messages: [userMessage('hi')],
    })) {
      chunks.push(chunk);
    }
    const failure = chunks.at(-1)?.reason?.failure;
    assertEqual(failure.code, 'QUOTA', 'code');
    assert(/ide_credits=0/.test(failure.message), 'balance is in the message');
  } finally {
    mock.restore();
  }
});

await test('an aborted signal yields finish:aborted', async () => {
  const controller = new AbortController();
  const mock = mockFetch((url, init) => {
    if (url.includes('get_detail_param')) return CATALOG;
    if (url.includes('llm_utils_chat')) {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      controller.abort();
      throw err;
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const { adapter } = makeAdapter();
    const chunks = [];
    for await (const chunk of adapter.stream({
      provider: 'trae-cn',
      model: 'glm-5.2',
      messages: [userMessage('hi')],
      signal: controller.signal,
    })) {
      chunks.push(chunk);
    }
    assertEqual(chunks.at(-1).reason.kind, 'aborted', 'aborted finish');
  } finally {
    mock.restore();
  }
});

await test('prepareCall binds metadata to a stream function', async () => {
  const mock = mockFetch((url) => (url.includes('get_detail_param') ? CATALOG : {}));
  try {
    const { adapter } = makeAdapter();
    const prepared = await adapter.prepareCall('trae-cn', 'glm-5.2');
    assertEqual(prepared.model.id, 'glm-5.2', 'prepared model id');
    assertEqual(typeof prepared.stream, 'function', 'prepared stream function');
  } finally {
    mock.restore();
  }
});

await test('message conversion covers harness blocks and legacy OpenAI shapes', async () => {
  const harness = await withSystemMessage(
    await toTraeMessages([
      assistantToolCall({ id: 'call_1', name: 'read_file', args: '{"path":"a.txt"}' }),
      toolResultMessage({ callId: 'call_1', text: 'file body' }),
      userMessage('and again'),
    ]),
    'sys',
  );
  assertEqual(harness, [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    {
      role: 'assistant',
      content: [],
      tool_calls: [{ id: 'call_1', type: 'function', function_call: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'file body' }] },
    { role: 'user', content: [{ type: 'text', text: 'and again' }] },
  ], 'harness message conversion');

  const legacy = await toTraeMessages([
    { role: 'system', content: 'legacy system' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'ping', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_2', content: 'pong' },
  ]);
  assertEqual(legacy[0], { role: 'system', content: [{ type: 'text', text: 'legacy system' }] }, 'legacy system');
  assertEqual(legacy[1], { role: 'user', content: [{ type: 'text', text: 'hi' }] }, 'legacy user');
  assertEqual(legacy[2].tool_calls[0].function_call.name, 'ping', 'legacy assistant tool call');
  assertEqual(legacy[3], { role: 'tool', tool_call_id: 'call_2', content: [{ type: 'text', text: 'pong' }] }, 'legacy tool');

  // The upstream stalls on OpenCode's native tool tags, so they are rewritten.
  const sanitized = await toTraeMessages([userMessage('<opencode_tool_call>{"a":1}</opencode_tool_call>')]);
  assertEqual(
    sanitized[0].content[0].text,
    '<tool_invoke>{"a":1}</tool_invoke>',
    'tool tags are neutralized',
  );
});

await test('image blocks inline as data URLs when an attachment store exists', async () => {
  const { PNG_BASE64 } = await import('./support.js');
  const messages = [
    {
      id: 'msg-user-2',
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        {
          type: 'image',
          attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 68, width: 1, height: 1 },
        },
      ],
      source: { kind: 'user' },
    },
  ];
  const withStore = await toTraeMessages(messages, {
    imageResolver: () => async () => ({ data: PNG_BASE64, mediaType: 'image/png' }),
  });
  assertEqual(withStore[0].content[1], {
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${PNG_BASE64}` },
  }, 'image inlined');

  const withoutStore = await toTraeMessages(messages, {});
  assertEqual(withoutStore[0].content[1].type, 'text', 'degrades to text placeholder');
  assert(/omitted/.test(withoutStore[0].content[1].text), 'placeholder explains the omission');
});

await test('token usage mapping tolerates nested and alternate field names', () => {
  assertEqual(
    toTokenUsage({ usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } }),
    { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4 },
    'nested details form',
  );
  assertEqual(
    toTokenUsage({ input_tokens: 7, output_tokens: 3, reasoning_tokens: 1, total_tokens: 10 }),
    { inputTokens: 7, outputTokens: 3, totalTokens: 10, reasoningTokens: 1 },
    'anthropic-style names',
  );
  assertEqual(toTokenUsage({}), { inputTokens: 0, outputTokens: 0 }, 'empty payload');
});

await test('buildChatBody supports the chat_v3 documented shape', () => {
  const body = buildChatBody({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    info: {
      id: 'glm-5.2',
      configName: 'glm-5.2',
      modelName: 'glm-5.2__dev',
      function: 'chat_v3',
      configSource: 1,
      provider: 'volc',
      reasoning: { efforts: [{ id: 'high', name: 'high' }], defaultEffort: 'high' },
    },
    options: { provider: 'trae-cn', model: 'glm-5.2', messages: [] },
    requestStyle: 'chat_v3',
  });
  assertEqual(body.config_name, 'glm-5.2', 'config_name');
  assertEqual(body.model_name, 'glm-5.2__dev', 'model_name');
  assertEqual(body.model, 'glm-5.2__dev', 'model');
  assertEqual(body.config_source, 1, 'config_source');
  assertEqual(body.is_custom_model, false, 'is_custom_model');
  assertEqual(body.provider, 'volc', 'provider');
  assertEqual(body.reasoning_effort, 'high', 'effort from the declared default');
  assertEqual(reasoningEffortFor({}, { reasoning: { efforts: [] } }), undefined, 'empty efforts means no effort');
});

console.log(process.exitCode ? '\nsmoke-adapter: FAILED' : '\nsmoke-adapter: PASSED');
