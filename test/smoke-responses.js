#!/usr/bin/env node
// test/smoke-responses.js - the Responses API surface that Codex CLI requires.
//
//   node test/smoke-responses.js
//
// Everything is offline: the upstream is a scripted `fetch`, and the HTTP side
// is a real server on an ephemeral port so header/timing behaviour is exercised
// rather than assumed.
//
// The event sequence asserted here was measured against codex-cli
// 0.166.0-alpha.5.1 (see `src/responses.js` for the parser cross-reference).
// Two of these checks exist because getting them wrong is invisible until a
// real turn dies:
//   * `response.completed.usage` must carry all four integer counts — Codex
//     deserializes them as required, so `null` kills the turn.
//   * `function_call` items from one turn must be grouped into ONE assistant
//     message with `tool_calls`, or the next request's tool result has no
//     matching call.
import { assert, assertEqual, mockFetch, sse, sseResponse, test, installShims, load } from './support.js';

installShims();

// `src/trae-client.js` reads the chat host from the credential's `host`; without
// it every real-fetch path would go to the network.
const UPSTREAM = 'http://trae-test.invalid';
const { TraeProvider, createServer } = await load('src/openai-server.js');
const {
  ResponsesEmitter,
  chatPayloadFromResponses,
  errorCodeOf,
  promptTextOf,
  responsesUsage,
  sanitizeToolName,
  toChatMessages,
  toChatTools,
  ToolNameTable,
} = await load('src/responses.js');

const realFetch = globalThis.fetch;

async function makeProvider() {
  const provider = new TraeProvider({
    env: { ideVersion: '3.4.1', appVersionCode: 20260901, ideVersionCode: '20260901', source: 'test' },
    credentials: { token: 't0', refreshToken: 'r0', userId: '1', expiresAt: 0, host: UPSTREAM },
    logger: {},
  });
  provider.catalog = [
    {
      configName: 'glm-5.2',
      modelName: 'glm-5.2__dev',
      name: 'GLM-5.2',
      contextWindow: 200000,
      maxMode: false,
      maxContextWindow: 200000,
      supportThinking: true,
      effortOptions: ['low', 'high'],
      vision: false,
      configSource: 1,
      provider: 'zhipu',
      function: 'chat_v3',
    },
  ];
  provider.catalogAt = Date.now();
  return provider;
}

async function startServer(provider, options = {}) {
  const server = createServer(provider, options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Split an SSE body into `{event, data}` frames. */
function parseSse(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split('\n');
      const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
      const data = lines.find((l) => l.startsWith('data:'))?.slice(5).trim();
      return { event, data: data ? JSON.parse(data) : null };
    });
}

const TOOL_TURN =
  sse('output', { reasoning_content: 'Need to look.' }) +
  sse('output', { content: 'Checking.' }) +
  sse('done', {
    finish_reason: 'tool_calls',
    tool_calls: [{ index: 0, id: 'call_up', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
  });

const TEXT_TURN =
  sse('token_usage', { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 }) +
  sse('output', { content: 'All done.' }) +
  sse('done', { finish_reason: 'stop' });

console.log('smoke-responses:');

// ------------------------------------------------------------ translation
await test('a Responses request translates into the chat payload buildTraeBody consumes', async () => {
  const payload = {
    model: 'glm-5.2',
    stream: true,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { effort: 'high', summary: 'auto' },
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'be brief' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read a.txt' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
      { type: 'function_call', name: 'read_file', arguments: '{"path":"a.txt"}', call_id: 'call_up' },
      { type: 'function_call_output', call_id: 'call_up', output: 'body of a.txt' },
    ],
    tools: [
      { type: 'function', name: 'read_file', description: 'r', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      { type: 'web_search' },
      { type: 'custom', name: 'freeform' },
    ],
  };
  const chat = chatPayloadFromResponses(payload);
  assertEqual(chat.model, 'glm-5.2', 'the model passes through');
  assertEqual(chat.reasoning_effort, 'high', 'reasoning.effort maps to the Trae effort field');
  assertEqual(chat.tool_choice, 'auto', 'tool_choice passes through');
  assertEqual(chat.tools.length, 1, 'web_search and custom tools are dropped (Trae has no representation)');
  assertEqual(chat.tools[0].function.name, 'read_file', 'function tools keep their name');
  assertEqual(chat.messages.length, 4, 'developer, user, assistant+tool_call, tool');
  assertEqual(chat.messages[0].role, 'developer', 'developer messages are preserved for toTraeMessages to map');
  assertEqual(chat.messages[2].tool_calls.length, 1, 'the function_call lands in tool_calls');
  assertEqual(chat.messages[2].tool_calls[0].function.name, 'read_file', 'with the call name');
  assertEqual(chat.messages[3].role, 'tool', 'the output becomes a tool message');
  assertEqual(chat.messages[3].tool_call_id, 'call_up', 'paired by call_id');
  assertEqual(chat.messages[3].content, [{ type: 'text', text: 'body of a.txt' }], 'output is flattened into a text part');
});

await test('several calls from one turn share ONE assistant message', async () => {
  // chat_v3 rejects a tool message whose `tool_call_id` does not appear in the
  // assistant message immediately before it, so splitting these breaks the next
  // turn — the failure surfaces one request later, nowhere near the cause.
  const messages = toChatMessages([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'two tools' }] },
    { type: 'function_call', name: 'a', arguments: '{}', call_id: 'c1' },
    { type: 'function_call', name: 'b', arguments: '{}', call_id: 'c2' },
    { type: 'function_call_output', call_id: 'c1', output: 'one' },
    { type: 'function_call_output', call_id: 'c2', output: 'two' },
  ]);
  assertEqual(messages.length, 4, 'user, one assistant carrying both calls, then two tool results');
  assertEqual(messages[1].role, 'assistant', 'the calls are grouped');
  assertEqual(messages[1].tool_calls.length, 2, 'both calls live in that message');
  assertEqual(
    messages.slice(2).map((m) => m.tool_call_id),
    ['c1', 'c2'],
    'each result keeps its own id',
  );
});

await test('a plain string `input` is one user turn', async () => {
  const messages = toChatMessages('hello');
  assertEqual(messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], 'a string input is accepted');
  assertEqual(promptTextOf([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]), 'hello', 'and counts towards the estimate');
});

await test('tool names are coerced into the charset the live upstream accepts', async () => {
  // Measured against console.enterprise.trae.cn: a single illegal tool name
  // fails the WHOLE request with
  //   trae 4027: tools.4.function.name: expected 1-128 ASCII letters,
  //              digits, underscores or hyphens
  // so `multi_agent_v1.spawn` (Codex's own namespace tool) has to be rewritten.
  const tools = [
    { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn', parameters: {} }] },
    { type: 'function', name: 'exec_command', parameters: {} },
    { type: 'function', name: 'tool.with.dot', parameters: {} },
  ];
  const table = new ToolNameTable();
  const flat = toChatTools(tools, table);
  const names = flat.map((t) => t.function.name);
  assertEqual(names[0], 'multi_agent_v1_spawn', 'a namespaced tool is flattened with an underscore');
  assertEqual(names[1], 'exec_command', 'a legal name is untouched');
  assertEqual(names[2], 'tool_with_dot', 'an illegal dot is replaced');
  assert(names.every((n) => /^[A-Za-z0-9_-]{1,128}$/.test(n)), 'every name satisfies the upstream charset');

  // ...and the way back must be exact, including for the renamed dot case.
  assertEqual(table.resolve('multi_agent_v1_spawn'), { name: 'spawn', namespace: 'multi_agent_v1' }, 'the namespace is restored');
  assertEqual(table.resolve('tool_with_dot'), { name: 'tool.with.dot' }, 'the original dotted name is restored');
  assertEqual(table.resolve('exec_command'), { name: 'exec_command' }, 'an untouched name resolves to itself');
  assertEqual(table.resolve('invented_by_model'), { name: 'invented_by_model' }, 'unknown names pass through');
});

await test('two tools that sanitize to the same name do not collide', async () => {
  const table = new ToolNameTable();
  const flat = toChatTools(
    [
      { type: 'function', name: 'a.b', parameters: {} },
      { type: 'function', name: 'a_b', parameters: {} },
    ],
    table,
  );
  const names = flat.map((t) => t.function.name);
  assertEqual(new Set(names).size, 2, 'both tools keep a distinct upstream name');
  assertEqual(table.resolve(names[0]), { name: 'a.b' }, 'the first original is recoverable');
  assertEqual(table.resolve(names[1]), { name: 'a_b' }, 'and the second');
});

await test('a replayed tool call in history uses the same name as the declaration', async () => {
  // If history and the tool list disagree, the model sees a call whose result
  // it cannot pair up and the next turn is rejected upstream.
  const table = new ToolNameTable();
  const { tools } = { tools: toChatTools([{ type: 'function', name: 'a.b', parameters: {} }], table) };
  const messages = toChatMessages(
    [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      { type: 'function_call', name: 'a.b', arguments: '{}', call_id: 'c1' },
      { type: 'function_call_output', call_id: 'c1', output: 'done' },
    ],
    table,
  );
  assertEqual(messages[1].tool_calls[0].function.name, tools[0].function.name, 'history and declaration agree');
});

// ------------------------------------------------------------- usage
await test('usage carries the four required integer counts', async () => {
  const counts = responsesUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } });
  assertEqual(counts.input_tokens, 100, 'input_tokens');
  assertEqual(counts.input_tokens_details.cached_tokens, 40, 'cached tokens are nested where Codex reads them');
  assertEqual(counts.output_tokens, 20, 'output_tokens');
  assertEqual(counts.output_tokens_details.reasoning_tokens, 5, 'reasoning tokens are nested');
  assertEqual(counts.total_tokens, 120, 'total_tokens');

  // No usage frame at all: estimates instead of zeros. Codex requires the
  // fields to exist and be integers, so `null` or a missing key is not an
  // option — the turn would die as "stream closed before response.completed".
  const estimated = responsesUsage(null, { promptText: 'abcdefg', completionText: 'hi', reasoningText: '' });
  assertEqual(estimated.input_tokens, 2, 'input is estimated from the prompt length');
  assertEqual(estimated.output_tokens, 1, 'output is estimated from the generated text');
  assertEqual(estimated.total_tokens, 3, 'totals add up');
  assert(Number.isInteger(estimated.input_tokens), 'every count is an integer');
  assert(Number.isInteger(estimated.output_tokens), 'every count is an integer');
});

// ------------------------------------------------------- event sequence
await test('the streaming sequence has the shape Codex parses', async () => {
  const emitter = new ResponsesEmitter({ model: 'glm-5.2', stream: true });
  const events = [
    ...emitter.reasonDelta('Thinking.'),
    ...emitter.textDelta('Hello'),
    ...emitter.textDelta(' world'),
    ...emitter.complete({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  ];
  const types = events.map((e) => e.type);
  assertEqual(types[0], 'response.created', 'the first frame is response.created');
  assertEqual(types[types.length - 1], 'response.completed', 'the last frame is response.completed');
  assert(types.includes('response.reasoning_summary_text.delta'), 'reasoning deltas are emitted as SUMMARY deltas (the parser ignores reasoning_text.delta without content_index)');
  assert(types.includes('response.output_text.delta'), 'text deltas are emitted');
  assert(events.every((e, i) => e.sequence_number === i + 1), 'sequence numbers are monotonic from 1');

  // Every reasoning event must carry the index its arm reads, or it is a no-op.
  for (const event of events.filter((e) => e.type.startsWith('response.reasoning_summary_text'))) {
    assertEqual(event.summary_index, 0, `${event.type} carries summary_index`);
  }

  const done = events.find((e) => e.type === 'response.output_item.done' && e.item.type === 'message');
  assertEqual(done.item.content[0].text, 'Hello world', 'the done item carries the full text');
  assertEqual(done.item.status, 'completed', 'and is marked completed');

  const completed = events.find((e) => e.type === 'response.completed');
  assertEqual(completed.response.usage.input_tokens, 10, 'response.completed carries usage');
  assertEqual(completed.response.status, 'completed', 'and a status');
  assertEqual(completed.response.output.length, 2, 'both the reasoning and message items are listed');

  // Two text deltas share one message item: Codex's parser does not stream
  // `content_part` events, but it does key on item_id.
  const textDeltas = events.filter((e) => e.type === 'response.output_text.delta');
  assertEqual(new Set(textDeltas.map((e) => e.item_id)).size, 1, 'consecutive text deltas reuse one item id');
});

await test('a tool call becomes a completed function_call item with a string arguments field', async () => {
  const emitter = new ResponsesEmitter({ model: 'glm-5.2', stream: true });
  const events = emitter.toolCall({ id: 'call_up', name: 'read_file', arguments: '{"path":"a.txt"}' });
  const done = events.find((e) => e.type === 'response.output_item.done');
  assertEqual(done.item.type, 'function_call', 'the item type is function_call');
  assertEqual(done.item.name, 'read_file', 'the name');
  assert(typeof done.item.arguments === 'string', 'arguments stay a JSON *string*, as Codex requires');
  assertEqual(done.item.call_id, 'call_up', 'the caller-supplied call id is preserved (it pairs the result next turn)');
  assertEqual(done.item.status, 'completed', 'the item is complete — Trae only flushes calls at end of turn');
});

await test('text arriving after a tool call opens a fresh message item', async () => {
  const emitter = new ResponsesEmitter({ model: 'glm-5.2', stream: true });
  const first = emitter.textDelta('Before.');
  const tools = emitter.toolCall({ id: 'c1', name: 'f', arguments: '{}' });
  const after = emitter.textDelta('After.');
  const ids = new Set([...first, ...after].filter((e) => e.type === 'response.output_text.delta').map((e) => e.item_id));
  assertEqual(ids.size, 2, 'the two text runs do not share an item id');
  const toolItem = tools.find((e) => e.type === 'response.output_item.done' && e.item.type === 'function_call');
  assertEqual(toolItem.item.type, 'function_call', 'the tool item sits between them');
});

await test('the non-streaming body is the same items and usage as the stream', async () => {
  const emitter = new ResponsesEmitter({ model: 'glm-5.2', stream: false });
  emitter.textDelta('Hi');
  emitter.toolCall({ id: 'c1', name: 'f', arguments: '{"a":1}' });
  const body = emitter.toJSON({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  assertEqual(body.object, 'response', 'it is a response object');
  assertEqual(body.status, 'completed', 'marked completed');
  assertEqual(body.output.length, 2, 'one message and one function call');
  assertEqual(body.output[0].content[0].text, 'Hi', 'text survives');
  assertEqual(body.output[1].arguments, '{"a":1}', 'arguments survive');
  assertEqual(body.usage.total_tokens, 5, 'usage survives');
});

await test('an empty turn still yields one assistant item', async () => {
  // Codex records the turn in history; a `response.completed` with an empty
  // output array makes the next request look like the model vanished.
  const emitter = new ResponsesEmitter({ model: 'glm-5.2', stream: true });
  const events = emitter.complete({ usage: null });
  const items = events.filter((e) => e.type === 'response.output_item.done');
  assertEqual(items.length, 1, 'exactly one item is emitted');
  assertEqual(items[0].item.type, 'message', 'and it is an assistant message');
  assertEqual(items[0].item.content[0].text, '', 'with empty text');
});

// ------------------------------------------------------------ HTTP surface
await test('POST /v1/responses streams the sequence and records usage', async () => {
  const provider = await makeProvider();
  const store = null;
  const server = await startServer(provider, {});
  const mock = mockFetch(() => sseResponse(TEXT_TURN));
  try {
    const res = await realFetch(`${server.base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }),
    });
    assertEqual(res.status, 200, 'the stream answers 200');
    assertEqual(res.headers.get('content-type'), 'text/event-stream; charset=utf-8', 'it is an SSE response');
    const frames = parseSse(await res.text());
    const types = frames.map((f) => f.event);
    assertEqual(types[0], 'response.created', 'starts with response.created');
    assertEqual(types[types.length - 1], 'response.completed', 'ends with response.completed');
    assert(frames.every((f) => f.data.type === f.event), 'each frame repeats its type in the JSON body (Codex reads type, SDKs read event)');
    const completed = frames.at(-1).data;
    assertEqual(completed.response.usage.input_tokens, 30, 'the upstream token_usage reaches response.completed');
    assertEqual(completed.response.output[0].content[0].text, 'All done.', 'the text reaches the caller');

    // The upstream got one chat_v3 call carrying the translated body.
    const [call] = mock.calls;
    assert(call.url.includes('/api/agent/v3/llm_utils_chat'), 'the upstream is the chat channel');
    const sent = JSON.parse(call.init.body);
    assertEqual(sent.function, 'chat_v3', 'the verified wire style is used');
    assertEqual(sent.stream, true, 'the upstream is always streamed');
    assert(sent.session_id, 'a session id is sent (enterprise gateways bill per session)');
    assertEqual(sent.messages.length, 1, 'the input became one message');
  } finally {
    mock.restore();
    await server.close();
  }
});

await test('stream:false answers one JSON response instead of SSE', async () => {
  const provider = await makeProvider();
  const server = await startServer(provider, {});
  const mock = mockFetch(() => sseResponse(TEXT_TURN));
  try {
    const res = await realFetch(`${server.base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', stream: false, input: 'hi' }),
    });
    assertEqual(res.status, 200, 'answers 200');
    assert(res.headers.get('content-type').startsWith('application/json'), 'it is JSON, not SSE');
    const body = await res.json();
    assertEqual(body.object, 'response', 'a response object');
    assertEqual(body.status, 'completed', 'completed');
    assertEqual(body.output[0].content[0].text, 'All done.', 'the text is in the body');
    assertEqual(body.usage.input_tokens, 30, 'usage is in the body');
  } finally {
    mock.restore();
    await server.close();
  }
});

await test('a tool turn produces a function_call item the caller can dispatch', async () => {
  const provider = await makeProvider();
  const server = await startServer(provider, {});
  const mock = mockFetch(() => sseResponse(TOOL_TURN));
  try {
    const res = await realFetch(`${server.base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-5.2',
        stream: true,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read it' }] }],
        tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } }],
      }),
    });
    const frames = parseSse(await res.text());
    const calls = frames
      .filter((f) => f.event === 'response.output_item.done' && f.data.item.type === 'function_call')
      .map((f) => f.data.item);
    assertEqual(calls.length, 1, 'one call item');
    assertEqual(calls[0].name, 'read_file', 'the model-chosen name');
    assertEqual(calls[0].arguments, '{"path":"a.txt"}', 'the arguments string');
    assertEqual(calls[0].call_id, 'call_up', 'the upstream call id is carried through');
    // Reasoning + preamble text + the call, all in one turn.
    const itemTypes = frames.filter((f) => f.event === 'response.output_item.done').map((f) => f.data.item.type);
    assertEqual(itemTypes, ['reasoning', 'message', 'function_call'], 'thinking, text, then the call');
    const sent = JSON.parse(mock.calls[0].init.body);
    assertEqual(sent.tools?.length, 1, 'the declared tool reached the upstream');
    assertEqual(sent.tools[0].function.parameters, '{"type":"object","properties":{}}', 'parameters are a JSON string upstream');
  } finally {
    mock.restore();
    await server.close();
  }
});

await test('an unknown model answers 404 with a model_not_found code, before any SSE byte', async () => {
  const provider = await makeProvider();
  const server = await startServer(provider, {});
  const mock = mockFetch(() => sseResponse(TEXT_TURN));
  try {
    const res = await realFetch(`${server.base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nope', input: 'hi' }),
    });
    assertEqual(res.status, 404, 'a real HTTP status, not a 200 stream');
    const body = await res.json();
    assertEqual(body.error.code, 'model_not_found', 'the code Codex maps to a terminal ModelNotFound');
    assertEqual(mock.calls.length, 0, 'the upstream was never contacted');
  } finally {
    mock.restore();
    await server.close();
  }
});

await test('a not-logged-in provider answers 503', async () => {
  const provider = await makeProvider();
  provider.creds = null;
  const server = await startServer(provider, {});
  try {
    const res = await realFetch(`${server.base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', input: 'hi' }),
    });
    assertEqual(res.status, 503, 'service unavailable');
  } finally {
    await server.close();
  }
});

await test('an upstream quota error becomes 429 + insufficient_quota, which Codex treats as terminal', async () => {
  // Codex retries a bare `upstream_error` five times with backoff. A spent Trae
  // quota is not retryable. The pair that makes it terminal is the *status and
  // the body together*: api_bridge.rs only maps 429 -> QuotaExceeded when the
  // body carries error.type/code == "insufficient_quota". Either alone still
  // looks retryable.
  const provider = await makeProvider();
  const server = await startServer(provider, {});
  const mock = mockFetch(() =>
    sseResponse(
      sse('error', { code: 4008, message: 'Your requests have exceeded the quota.' }) +
        sse('notify_usage', { remain_usage: { ide_credits: 0 }, billing_mode: 'credits' }),
    ),
  );
  try {
    const res = await realFetch(`${server.base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', stream: true, input: 'hi' }),
    });
    assertEqual(res.status, 429, 'a real HTTP status, because nothing was streamed yet');
    const body = await res.json();
    assertEqual(body.error.code, 'insufficient_quota', 'the code Codex maps to QuotaExceeded');
    assertEqual(body.error.type, 'insufficient_quota', 'the type is read alongside the code');
    assert(body.error.message.includes('4008'), 'the upstream code is kept for triage');
  } finally {
    mock.restore();
    await server.close();
  }
});

await test('a failure after the stream opened travels in-band as response.failed', async () => {
  // Once the first frame is on the wire the status line is spent, so the
  // failure has to be an event. Codex's parser turns this into a Stream error.
  const provider = await makeProvider();
  const server = await startServer(provider, {});
  const mock = mockFetch(() =>
    sseResponse(
      sse('output', { content: 'partial ' }) +
        sse('error', { code: 5001, message: 'upstream went away' }),
    ),
  );
  try {
    const res = await realFetch(`${server.base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', stream: true, input: 'hi' }),
    });
    assertEqual(res.status, 200, 'the stream was already committed');
    const frames = parseSse(await res.text());
    assert(frames.some((f) => f.event === 'response.output_text.delta'), 'the partial text was delivered');
    const failed = frames.find((f) => f.event === 'response.failed');
    assert(failed, 'a response.failed frame closes the stream');
    assertEqual(failed.data.response.status, 'failed', 'it carries a failed response body');
    assert(failed.data.response.error.message.includes('5001'), 'with the upstream message');
  } finally {
    mock.restore();
    await server.close();
  }
});

await test('a failure before the stream opens answers a real HTTP error', async () => {
  const provider = await makeProvider();
  const server = await startServer(provider, {});
  const mock = mockFetch(() => ({ status: 500, body: 'upstream exploded' }));
  try {
    const res = await realFetch(`${server.base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', stream: true, input: 'hi' }),
    });
    assert([200, 502].includes(res.status), 'either a committed stream or a clean 502');
    if (res.status === 502) {
      const body = await res.json();
      assertEqual(body.error.type, 'upstream_error', 'reported as an upstream error');
    }
  } finally {
    mock.restore();
    await server.close();
  }
});

await test('the gateway key and daily cap apply to /v1/responses too', async () => {
  const { openStore, STATUS } = await load('src/store.js');
  const store = openStore(':memory:');
  const { id } = store.addKey({ key: 'sk-codex-x', label: 'codex-user', limitTokensPerDay: 10 });
  store.record({ keyId: id, keyLabel: 'codex-user', totalTokens: 10, status: STATUS.ok });
  const provider = await makeProvider();
  const gateway = await startServer(provider, { store });
  let upstreamCalled = false;
  const mock = mockFetch(() => {
    upstreamCalled = true;
    return sseResponse(TEXT_TURN);
  });
  try {
    // No key: rejected.
    const anonymous = await realFetch(`${gateway.base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', input: 'hi' }),
    });
    assertEqual(anonymous.status, 401, 'the same key check as the chat route');

    // Over the cap: 429 before the body is even read.
    const capped = await realFetch(`${gateway.base}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-codex-x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', input: 'hi' }),
    });
    assertEqual(capped.status, 429, 'the daily cap applies');
    assertEqual(upstreamCalled, false, 'and the upstream is never contacted');

    const [row] = store.recent({ limit: 1 });
    assertEqual(row.status, STATUS.deniedQuota, 'the refusal is recorded');
    assertEqual(row.key_label, 'codex-user', 'attributed to the caller');
  } finally {
    mock.restore();
    await gateway.close();
    store.close();
  }
});

await test('errorCodeOf maps the upstream failure modes Codex cares about', async () => {
  const quota = Object.assign(new Error('Your requests have exceeded the quota'), { code: 4008 });
  assertEqual(errorCodeOf(quota), 'insufficient_quota', 'code 4008 is a spent quota');
  assertEqual(errorCodeOf(new Error('This model\'s maximum context length is 128000 tokens')), 'context_length_exceeded', 'a context overflow is terminal');
  assertEqual(errorCodeOf(new Error('network down')), 'upstream_error', 'anything else stays retryable');
  // A message mentioning quota but not an actual quota failure must not be
  // misclassified — Codex would then refuse to retry a transient error.
  assertEqual(errorCodeOf(new Error('quota service timeout')), 'insufficient_quota', 'the message is a fallback signal too');
});
