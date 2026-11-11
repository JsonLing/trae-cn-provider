#!/usr/bin/env node
// test/smoke-gateway.js - the b2b gateway: key table, daily caps, usage ledger,
// and the admin surface.
//
//   node test/smoke-gateway.js
//
// Everything here is offline: the upstream is a scripted `fetch`, and the
// database is a real (in-memory or temp-file) SQLite opened through
// `node:sqlite`, so the SQL itself is exercised rather than mocked.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { assert, assertEqual, mockFetch, sse, sseResponse, test } from './support.js';
import { installShims, load } from './support.js';

installShims();

const { GatewayStore, STATUS, hashKey, startOfToday, openStore } = await load('src/store.js');
const { createServer, createRequestHandler } = await load('src/openai-server.js');
const { createAdminHandler } = await load('src/admin.js');

// A catalog shaped exactly like the real one, reduced to what the surface reads.
const CATALOG = {
  data: {
    function_configs: [
      {
        config_name: 'glm-5.2',
        model_name: 'glm-5.2__dev',
        display_name: 'GLM-5.2',
        context_window: 200000,
        max_mode: false,
        support_thinking: false,
        effort_options: [],
        vision: false,
        config_source: 1,
        provider: 'zhipu',
        function: 'chat_v3',
      },
    ],
  },
};

/** A provider whose catalog is static, so no catalog call reaches the network. */
async function makeProvider() {
  const { TraeProvider } = await load('src/openai-server.js');
  const provider = new TraeProvider({
    env: { ideVersion: '3.4.1', appVersionCode: 20260901, ideVersionCode: '20260901', source: 'test' },
    credentials: { token: 't0', refreshToken: 'r0', userId: '1', expiresAt: 0 },
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
      supportThinking: false,
      effortOptions: [],
      vision: false,
      configSource: 1,
      provider: 'zhipu',
      function: 'chat_v3',
    },
  ];
  provider.catalogAt = Date.now();
  return provider;
}

/** Start a gateway on an ephemeral port and return its base URL. */
async function startGateway(provider, store, options = {}) {
  const adminHandler = options.adminHandler === undefined ? createAdminHandler({ store }) : options.adminHandler;
  const server = createServer(provider, { store, adminHandler, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const realFetch = globalThis.fetch;

/** GET a URL while forcing a specific `Host` header (fetch forbids it). */
function getWithHost(url, hostHeader) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, headers: { Host: hostHeader } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

console.log('smoke-gateway:');

// ---------------------------------------------------------------- store
await test('a key authenticates by SHA-256 and is readable back by the operator', async () => {
  const store = openStore(':memory:');
  try {
    const created = store.addKey({ key: 'sk-alice-supersecret', label: 'alice' });
    const row = store.db.prepare('SELECT * FROM keys').get();
    // Authentication reads the hash; the plaintext column exists only so an
    // operator can re-read a key after the fact.
    assertEqual(row.id, hashKey('sk-alice-supersecret'), 'id is the hash');
    assertEqual(row.secret, 'sk-alice-supersecret', 'the plaintext is kept for the admin view');
    assertEqual(created.key, 'sk-alice-supersecret', 'addKey hands the plaintext back');
    assertEqual(store.listKeys()[0].key, 'sk-alice-supersecret', 'and listKeys exposes it');
    assertEqual(store.listKeys()[0].masked, 'sk-alice-…cret', 'the masked form is still available');
    assertEqual(store.authenticate('sk-alice-supersecret').ok, true, 'the right key authenticates');
    assertEqual(store.authenticate('sk-alice-wrong').reason, 'unknown', 'a wrong key does not');
  } finally {
    store.close();
  }
});

await test('a database without the secret column is migrated, leaving old keys masked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-cn-migrate-'));
  const file = path.join(dir, 'legacy.db');
  try {
    // Build the pre-migration shape by hand, then open it through GatewayStore.
    const { DatabaseSync } = await import('node:sqlite');
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE keys (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, note TEXT, prefix TEXT NOT NULL, last4 TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, limit_tokens_per_day INTEGER, created_at INTEGER NOT NULL, last_seen INTEGER
    )`);
    legacy
      .prepare('INSERT INTO keys (id, label, prefix, last4, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(hashKey('sk-old-key-abcd'), 'old', 'sk-old-key-', 'abcd', Math.floor(Date.now() / 1000));
    legacy.close();

    const store = openStore(file);
    assertEqual(store.listKeys().length, 1, 'the legacy row survives');
    assertEqual(store.listKeys()[0].key, null, 'a pre-migration key has no recoverable plaintext');
    assertEqual(store.authenticate('sk-old-key-abcd').ok, true, 'and still authenticates');
    // A new key written after migration does carry its plaintext.
    store.addKey({ key: 'sk-new-key-efgh', label: 'new' });
    const fresh = store.listKeys().find((k) => k.label === 'new');
    assertEqual(fresh.key, 'sk-new-key-efgh', 'new rows get the secret column populated');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('a label with no ASCII letters still yields an sk-<stem>- shape', async () => {
  const { keyStem } = await load('src/store.js');
  assertEqual(keyStem('alice'), 'alice', 'ascii passes through');
  assertEqual(keyStem('Alice Smith'), 'alice-smith', 'spaces become dashes');
  assertEqual(keyStem('烧麦'), 'key', 'a Chinese label falls back to `key`');
  assertEqual(keyStem('测试新key'), 'key', 'and so does a mixed one with no ascii stem');
  assertEqual(keyStem('---'), 'key', 'punctuation only falls back too');
});

await test('a disabled key is distinguishable from an unknown one', async () => {
  const store = openStore(':memory:');
  try {
    const { id } = store.addKey({ key: 'sk-bob-x', label: 'bob' });
    store.setEnabled(id, false);
    const auth = store.authenticate('sk-bob-x');
    assertEqual(auth.ok, false, 'disabled keys do not authenticate');
    assertEqual(auth.reason, 'disabled', 'reason is `disabled`, not `unknown`');
    assertEqual(auth.key.label, 'bob', 'the label survives, for the audit row');
  } finally {
    store.close();
  }
});

await test('the daily cap counts tokens, ignores refused requests, and trips at the limit', async () => {
  const store = openStore(':memory:');
  try {
    const { id } = store.addKey({ key: 'sk-carol-x', label: 'carol', limitTokensPerDay: 100 });
    // A refused request carries no tokens and must not consume the cap.
    store.record({ keyId: id, keyLabel: 'carol', status: STATUS.deniedUnauthorized });
    assertEqual(store.checkQuota(store.getKey(id)).allowed, true, 'a 401 row does not eat the cap');

    store.record({ keyId: id, keyLabel: 'carol', totalTokens: 60, status: STATUS.ok });
    assertEqual(store.checkQuota(store.getKey(id)).used, 60, '60 tokens counted');
    assertEqual(store.checkQuota(store.getKey(id)).allowed, true, 'still under a 100 cap');

    store.record({ keyId: id, keyLabel: 'carol', totalTokens: 40, status: STATUS.ok });
    const atLimit = store.checkQuota(store.getKey(id));
    assertEqual(atLimit.used, 100, 'exactly at the cap');
    assertEqual(atLimit.allowed, false, 'the cap is inclusive: 100/100 is over budget');

    store.record({ keyId: id, keyLabel: 'carol', totalTokens: 500, status: STATUS.aborted });
    assertEqual(store.checkQuota(store.getKey(id)).used, 600, 'an aborted call with tokens still counts');
  } finally {
    store.close();
  }
});

await test('an unlimited key never trips the cap', async () => {
  const store = openStore(':memory:');
  try {
    const { id } = store.addKey({ key: 'sk-dave-x', label: 'dave' });
    store.record({ keyId: id, keyLabel: 'dave', totalTokens: 10_000_000, status: STATUS.ok });
    const quota = store.checkQuota(store.getKey(id));
    assertEqual(quota.allowed, true, 'no cap set means always allowed');
    assertEqual(quota.limit, null, 'the limit is reported as null');
  } finally {
    store.close();
  }
});

await test('deleting a key keeps its usage in the report', async () => {
  const store = openStore(':memory:');
  try {
    const { id } = store.addKey({ key: 'sk-erin-x', label: 'erin' });
    store.record({ keyId: id, keyLabel: 'erin', totalTokens: 42, status: STATUS.ok });
    store.removeKey(id);
    const report = store.report();
    assertEqual(report.length, 1, 'the row survives the key');
    assertEqual(report[0].label, 'erin', 'and still names the person');
    assertEqual(report[0].totalTokens, 42, 'with the tokens intact');
  } finally {
    store.close();
  }
});

await test('the report buckets by status so each failure mode is visible', async () => {
  const store = openStore(':memory:');
  try {
    const { id } = store.addKey({ key: 'sk-frank-x', label: 'frank' });
    store.record({ keyId: id, keyLabel: 'frank', totalTokens: 10, status: STATUS.ok });
    store.record({ keyId: id, keyLabel: 'frank', totalTokens: 5, status: STATUS.aborted });
    store.record({ keyId: id, keyLabel: 'frank', status: STATUS.upstreamError, error: '4008' });
    store.record({ keyId: id, keyLabel: 'frank', status: STATUS.deniedQuota });
    const [row] = store.report();
    assertEqual(row.okRequests, 1, 'ok');
    assertEqual(row.abortedRequests, 1, 'aborted');
    assertEqual(row.upstreamErrors, 1, 'upstream error');
    assertEqual(row.quotaDenied, 1, 'quota denied');
    assertEqual(row.requests, 4, 'all four rows counted as requests');
  } finally {
    store.close();
  }
});

await test('a file-backed store survives a close and reopen', async () => {
  const file = path.join(os.tmpdir(), `trae-cn-gateway-${process.pid}-${Date.now()}.db`);
  try {
    const first = openStore(file);
    const { id } = first.addKey({ key: 'sk-gina-x', label: 'gina', limitTokensPerDay: 500 });
    first.record({ keyId: id, keyLabel: 'gina', totalTokens: 77, status: STATUS.ok });
    first.close();

    const second = openStore(file);
    assertEqual(second.listKeys().length, 1, 'the key persisted');
    assertEqual(second.authenticate('sk-gina-x').key.label, 'gina', 'and still authenticates');
    assertEqual(second.report()[0].totalTokens, 77, 'and the usage persisted');
    second.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  }
});

// ---------------------------------------------------------------- surface
await test('an unknown key is refused with 401 and a usage row', async () => {
  const store = openStore(':memory:');
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  try {
    const res = await realFetch(`${gateway.base}/v1/models`, { headers: { Authorization: 'Bearer sk-nobody' } });
    assertEqual(res.status, 401, 'unknown key is refused');
    const [row] = store.recent({ limit: 1 });
    assertEqual(row.status, STATUS.deniedUnauthorized, 'the refusal is recorded');
    assertEqual(row.key_label, 'unknown', 'under an `unknown` caller');
  } finally {
    await gateway.close();
    store.close();
  }
});

await test('a disabled key is refused with 403 and names the label', async () => {
  const store = openStore(':memory:');
  const { id } = store.addKey({ key: 'sk-hank-x', label: 'hank' });
  store.setEnabled(id, false);
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  try {
    const res = await realFetch(`${gateway.base}/v1/models`, { headers: { Authorization: 'Bearer sk-hank-x' } });
    assertEqual(res.status, 403, 'disabled key is refused');
    const body = await res.json();
    assert(body.error.message.includes('hank'), 'the message names the person, so they know to ask for a re-issue');
    const [row] = store.recent({ limit: 1 });
    assertEqual(row.status, STATUS.deniedDisabled, 'recorded as a disabled-key refusal');
  } finally {
    await gateway.close();
    store.close();
  }
});

await test('a valid key gets the catalog and is never billed for /v1/models', async () => {
  const store = openStore(':memory:');
  store.addKey({ key: 'sk-ivy-x', label: 'ivy' });
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  try {
    const res = await realFetch(`${gateway.base}/v1/models`, { headers: { Authorization: 'Bearer sk-ivy-x' } });
    assertEqual(res.status, 200, 'the catalog is served');
    const body = await res.json();
    assertEqual(body.data.length, 1, 'one model');
    assertEqual(store.recent({ limit: 5 }).length, 0, 'listing models writes no usage row');
  } finally {
    await gateway.close();
    store.close();
  }
});

await test('a non-streaming call records prompt, completion and total tokens', async () => {
  const store = openStore(':memory:');
  store.addKey({ key: 'sk-jack-x', label: 'jack' });
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  const mock = mockFetch(() =>
    sseResponse(
      sse('output', { content: 'hello' }) +
        sse('token_usage', { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }) +
        sse('done', { finish_reason: 'stop' }),
    ),
  );
  try {
    const res = await realFetch(`${gateway.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-jack-x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assertEqual(res.status, 200, 'the call succeeded');
    const body = await res.json();
    assertEqual(body.usage.total_tokens, 18, 'usage is echoed to the caller');

    const [row] = store.recent({ limit: 1 });
    assertEqual(row.key_label, 'jack', 'attributed to jack');
    assertEqual(row.model, 'glm-5.2', 'with the model');
    assertEqual(row.prompt_tokens, 11, 'prompt tokens');
    assertEqual(row.completion_tokens, 7, 'completion tokens');
    assertEqual(row.total_tokens, 18, 'total tokens');
    assertEqual(row.status, STATUS.ok, 'status ok');
    assert(row.session_id, 'the upstream session id is captured for reconciliation');
  } finally {
    mock.restore();
    await gateway.close();
    store.close();
  }
});

await test('an omitted `stream` yields a JSON body, not an SSE stream', async () => {
  // OpenAI's default is non-streaming. Getting this wrong is invisible to curl
  // but breaks every official SDK: the client parses an SSE body as JSON and
  // reports `choices` undefined.
  const store = openStore(':memory:');
  store.addKey({ key: 'sk-vera-x', label: 'vera' });
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  const mock = mockFetch(() =>
    sseResponse(
      sse('output', { content: 'hi' }) +
        sse('token_usage', { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }) +
        sse('done', { finish_reason: 'stop' }),
    ),
  );
  try {
    // No `stream` key at all — exactly what the Python/Node SDKs send.
    const implicit = await realFetch(`${gateway.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-vera-x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assertEqual(implicit.status, 200, 'the call succeeds');
    assert(
      (implicit.headers.get('content-type') || '').includes('application/json'),
      `an omitted stream must answer JSON, got ${implicit.headers.get('content-type')}`,
    );
    const body = await implicit.json();
    assertEqual(body.object, 'chat.completion', 'the payload is a full completion');
    assertEqual(body.choices[0].message.content, 'hi', 'with the assistant text');

    // An explicit `stream: true` still streams.
    const explicit = await realFetch(`${gateway.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-vera-x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(
      (explicit.headers.get('content-type') || '').includes('text/event-stream'),
      'stream:true still answers SSE',
    );
    await explicit.text();
  } finally {
    mock.restore();
    await gateway.close();
    store.close();
  }
});

await test('a streaming call records exactly one row, not one per chunk', async () => {
  const store = openStore(':memory:');
  store.addKey({ key: 'sk-kim-x', label: 'kim' });
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  const mock = mockFetch(() =>
    sseResponse(
      sse('output', { content: 'a' }) +
        sse('output', { content: 'b' }) +
        sse('output', { content: 'c' }) +
        sse('token_usage', { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }) +
        sse('done', { finish_reason: 'stop' }),
    ),
  );
  try {
    const res = await realFetch(`${gateway.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-kim-x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assertEqual(res.status, 200, 'the stream opened');
    const text = await res.text();
    assert(text.includes('data: [DONE]'), 'the stream terminated properly');
    const rows = store.recent({ limit: 10 });
    assertEqual(rows.length, 1, 'three output chunks produced one usage row');
    assertEqual(rows[0].total_tokens, 7, 'with the upstream token count');
  } finally {
    mock.restore();
    await gateway.close();
    store.close();
  }
});

await test('an upstream 4008 is recorded as an error, not silently dropped', async () => {
  const store = openStore(':memory:');
  const { id } = store.addKey({ key: 'sk-lee-x', label: 'lee' });
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  const mock = mockFetch(() =>
    sseResponse(
      sse('error', { code: 4008, message: 'Your requests have exceeded the quota.' }) +
        sse('notify_usage', { remain_usage: { ide_credits: 0, work_credits: 0 }, billing_mode: 'credits' }),
    ),
  );
  try {
    const res = await realFetch(`${gateway.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-lee-x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assertEqual(res.status, 502, 'the failure surfaces to the caller');
    const [row] = store.recent({ limit: 1 });
    assertEqual(row.status, STATUS.upstreamError, 'the row says upstream_error');
    assert(row.error.includes('4008'), 'and keeps the upstream code for triage');
    assertEqual(row.key_label, 'lee', 'attributed to the caller who hit it');
  } finally {
    mock.restore();
    await gateway.close();
    store.close();
  }
});

await test('an omitted model resolves to the configured default, not the catalog head', async () => {
  // The upstream lists Doubao first; an operator who hands out keys wants a
  // specific model unless the caller says otherwise.
  const { TraeProvider } = await load('src/openai-server.js');
  const provider = await makeProvider();
  provider.catalog = [
    { configName: 'Doubao-Seed-Evolving', modelName: 'doubao-evo', name: 'Doubao Seed Evolving' },
    { configName: 'DeepSeek-V4.1-Flash-1017', modelName: 'ds-1017', name: 'DeepSeek V4.1 Flash 1017' },
  ];
  provider.defaultModel = 'DeepSeek-V4.1-Flash-1017';
  assertEqual(provider.resolveModel('auto').configName, 'DeepSeek-V4.1-Flash-1017', 'auto uses the default');
  assertEqual(provider.resolveModel(undefined).configName, 'DeepSeek-V4.1-Flash-1017', 'omitted uses the default');
  assertEqual(provider.resolveModel('default').configName, 'DeepSeek-V4.1-Flash-1017', '`default` uses it too');
  assertEqual(provider.resolveModel('Doubao-Seed-Evolving').configName, 'Doubao-Seed-Evolving', 'an explicit model still wins');
  assertEqual(provider.resolveModel('deepseek-v4.1-flash-1017').configName, 'DeepSeek-V4.1-Flash-1017', 'case-insensitive');
  assertEqual(provider.resolveModel('1017').configName, 'DeepSeek-V4.1-Flash-1017', 'substring still resolves');
  assertEqual(provider.resolveModel('nonexistent'), null, 'unknown names return null');

  // No configured default keeps the historical behaviour: the catalog head.
  const plain = await makeProvider();
  assertEqual(plain.resolveModel('auto').configName, 'glm-5.2', 'unset default falls back to the head');

  // A stale default must not 404 every request — fall back and warn.
  const stale = await makeProvider();
  stale.logger = { warn: () => {}, error: () => {}, info: () => {} };
  stale.catalog = [{ configName: 'glm-5.2', modelName: 'glm-5.2__dev', name: 'GLM-5.2' }];
  stale.defaultModel = 'retired-model';
  assertEqual(stale.resolveModel('auto').configName, 'glm-5.2', 'a missing default degrades to the head');
  assertEqual(TraeProvider.length >= 0, true, 'the provider class is importable');
});

await test('a caller over the daily cap gets 429 before the body is even read', async () => {
  const store = openStore(':memory:');
  const { id } = store.addKey({ key: 'sk-mona-x', label: 'mona', limitTokensPerDay: 10 });
  store.record({ keyId: id, keyLabel: 'mona', totalTokens: 10, status: STATUS.ok });
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  let upstreamCalled = false;
  const mock = mockFetch(() => {
    upstreamCalled = true;
    return { status: 500, body: 'should not be called' };
  });
  try {
    const res = await realFetch(`${gateway.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-mona-x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assertEqual(res.status, 429, 'the cap answers 429');
    const body = await res.json();
    assert(body.error.message.includes('10/10'), 'the message says how far over they are');
    assertEqual(upstreamCalled, false, 'the upstream was never contacted');
    const [row] = store.recent({ limit: 1 });
    assertEqual(row.status, STATUS.deniedQuota, 'the refusal is recorded');
  } finally {
    mock.restore();
    await gateway.close();
    store.close();
  }
});

await test('a client hanging up mid-stream is recorded as aborted', async () => {
  const store = openStore(':memory:');
  store.addKey({ key: 'sk-nate-x', label: 'nate' });
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  // The upstream never finishes: it emits one chunk and then hangs, which is
  // exactly the shape a cancelled IDE request produces.
  //
  // The abort signal has to be wired by hand here. Real `fetch` (undici) fails
  // the pending body read when the signal aborts; a stub that ignores it would
  // hang forever and prove nothing about the handler's abort path.
  const mock = mockFetch(
    (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse('output', { content: 'partial' })));
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener('abort', () => {
                try {
                  controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                } catch {
                  /* already errored */
                }
              });
            }
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );
  try {
    const abort = new AbortController();
    const res = await realFetch(`${gateway.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-nate-x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: abort.signal,
    });
    // Read the first frame so the handler is genuinely mid-stream, then hang up.
    const reader = res.body.getReader();
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => {});

    // Give the handler a beat to observe the close and write its row.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const rows = store.recent({ limit: 5 });
    assert(rows.length >= 1, 'the aborted call produced a row');
    assertEqual(rows[0].status, STATUS.aborted, 'and is labelled aborted, not ok');
  } finally {
    mock.restore();
    await gateway.close();
    store.close();
  }
});

await test('an aborted call keeps the tokens the upstream had already reported', async () => {
  // The upstream publishes `token_usage` *before* `done`. A client that hangs
  // up in between has still been charged, so the row must not read 0 — that is
  // what made the ledger under-count, and aborts are the expensive rows.
  const store = openStore(':memory:');
  store.addKey({ key: 'sk-iris-x', label: 'iris' });
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  const mock = mockFetch(
    (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(sse('output', { content: 'partial' })));
            // Arrives before the hang-up, exactly like the real stream.
            setTimeout(() => {
              try {
                controller.enqueue(
                  encoder.encode(sse('token_usage', { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 })),
                );
              } catch {
                /* the client already left */
              }
            }, 20);
            init?.signal?.addEventListener('abort', () => {
              try {
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              } catch {
                /* already errored */
              }
            });
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );
  try {
    const abort = new AbortController();
    const res = await realFetch(`${gateway.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-iris-x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      signal: abort.signal,
    });
    const reader = res.body.getReader();
    await reader.read();
    // Let the token_usage frame reach the handler before disconnecting.
    await new Promise((resolve) => setTimeout(resolve, 120));
    abort.abort();
    await reader.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 250));

    const [row] = store.recent({ limit: 1 });
    assertEqual(row.status, STATUS.aborted, 'still labelled aborted');
    assertEqual(row.prompt_tokens, 900, 'the prompt tokens the upstream charged are kept');
    assertEqual(row.completion_tokens, 100, 'so are the completion tokens');
    assertEqual(row.total_tokens, 1000, 'and the row is no longer silently 0');
  } finally {
    mock.restore();
    await gateway.close();
    store.close();
  }
});

await test('a stream that dies after token_usage still bills its tokens', async () => {
  // Two shapes reach the same gap: an explicit `error` frame, and a stream that
  // simply ends without `done`. Both used to throw away the usage they had.
  for (const [label, frames] of [
    [
      'error frame',
      sse('output', { content: 'partial' }) +
        sse('token_usage', { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 }) +
        sse('error', { code: 4222, message: '上游返回错误' }),
    ],
    [
      'truncated stream',
      sse('output', { content: 'partial' }) +
        sse('token_usage', { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 }),
    ],
  ]) {
    const store = openStore(':memory:');
    store.addKey({ key: 'sk-jude-x', label: 'jude' });
    const provider = await makeProvider();
    const gateway = await startGateway(provider, store);
    const mock = mockFetch(() => sseResponse(frames));
    try {
      const res = await realFetch(`${gateway.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: 'Bearer sk-jude-x', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'glm-5.2', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
      });
      await res.text();
      const [row] = store.recent({ limit: 1 });
      assertEqual(row.status, STATUS.upstreamError, `${label}: still an upstream error`);
      assertEqual(row.total_tokens, 1000, `${label}: the billed tokens survive the failure`);
    } finally {
      mock.restore();
      await gateway.close();
      store.close();
    }
  }
});

// ---------------------------------------------------------------- admin
await test('the admin page renders real numbers server-side', async () => {  const store = openStore(':memory:');
  const { id } = store.addKey({ key: 'sk-olga-x', label: 'olga', limitTokensPerDay: 1000, note: '设计部' });
  store.record({ keyId: id, keyLabel: 'olga', totalTokens: 123, status: STATUS.ok });
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  try {
    const res = await realFetch(`${gateway.base}/admin`);
    assertEqual(res.status, 200, 'the page is served');
    const html = await res.text();
    assert(html.includes('olga'), 'the key label is present');
    assert(html.includes('设计部'), 'the note is present');
    // The operator distributes these keys, so the page must show them in full.
    assert(html.includes('sk-olga-x'), 'the plaintext key is rendered for the operator');
    assert(html.includes('123'), 'today\'s token count is in the first paint');
  } finally {
    await gateway.close();
    store.close();
  }
});

await test('the admin page requires its own password, separate from the /v1 keys', async () => {
  const store = openStore(':memory:');
  store.addKey({ key: 'sk-pete-x', label: 'pete' });
  const provider = await makeProvider();
  const adminHandler = createAdminHandler({ store, password: 'letmein' });
  const gateway = await startGateway(provider, store, { adminHandler });
  try {
    const anonymous = await realFetch(`${gateway.base}/admin`);
    assertEqual(anonymous.status, 401, 'no password is refused');
    assert(anonymous.headers.get('www-authenticate')?.startsWith('Basic'), 'and advertises Basic auth');

    // The /v1 key must NOT open the admin page: otherwise a colleague could
    // raise their own cap or mint themselves a new key.
    const withApiKey = await realFetch(`${gateway.base}/admin`, { headers: { Authorization: 'Bearer sk-pete-x' } });
    assertEqual(withApiKey.status, 401, 'a valid API key does not grant admin access');

    const correct = `Basic ${Buffer.from('admin:letmein').toString('base64')}`;
    const allowed = await realFetch(`${gateway.base}/admin`, { headers: { Authorization: correct } });
    assertEqual(allowed.status, 200, 'the right password opens it');

    const wrong = `Basic ${Buffer.from('admin:nope').toString('base64')}`;
    const denied = await realFetch(`${gateway.base}/admin`, { headers: { Authorization: wrong } });
    assertEqual(denied.status, 401, 'a wrong password does not');
  } finally {
    await gateway.close();
    store.close();
  }
});

await test('creating a key through the admin API returns it, and it stays readable', async () => {
  const store = openStore(':memory:');
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  try {
    const res = await realFetch(`${gateway.base}/admin/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'quinn', limitTokensPerDay: 500 }),
    });
    assertEqual(res.status, 201, 'created');
    const created = await res.json();
    assert(created.key.startsWith('sk-quinn-'), `the key carries the label stem, got ${created.key}`);
    assertEqual(created.key.length > 30, true, 'and has real entropy');
    assertEqual(store.listKeys().length, 1, 'one key in the store');

    // The value authenticates by hash, and is stored so it can be shown again.
    assertEqual(store.authenticate(created.key).ok, true, 'the returned key works');
    const rawRow = store.db.prepare('SELECT * FROM keys').get();
    assertEqual(rawRow.id, hashKey(created.key), 'lookup still goes through the hash');
    assertEqual(rawRow.secret, created.key, 'the plaintext is persisted for the operator');

    const overview = await realFetch(`${gateway.base}/admin/api/overview`).then((r) => r.json());
    assertEqual(overview.keys[0].masked, created.masked, 'the overview carries the masked form');
    assertEqual(overview.keys[0].key, created.key, 'and the full key alongside it');
    assertEqual(overview.keys[0].limitTokensPerDay, 500, 'with its cap');
  } finally {
    await gateway.close();
    store.close();
  }
});

await test('toggling and capping a key through the admin API takes effect immediately', async () => {
  const store = openStore(':memory:');
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  try {
    const { key, id } = await realFetch(`${gateway.base}/admin/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'rosa' }),
    }).then((r) => r.json());

    await realFetch(`${gateway.base}/admin/api/keys/${id}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const denied = await realFetch(`${gateway.base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
    assertEqual(denied.status, 403, 'the key stops working the moment it is disabled');

    await realFetch(`${gateway.base}/admin/api/keys/${id}/limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limitTokensPerDay: 10 }),
    });
    const capped = await realFetch(`${gateway.base}/admin/api/keys/${id}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }).then((r) => r.json());
    assertEqual(capped.enabled, true, 're-enabled');
    store.record({ keyId: id, keyLabel: 'rosa', totalTokens: 10, status: STATUS.ok });
    const quota = store.checkQuota(store.getKey(id));
    assertEqual(quota.allowed, false, 'and the new cap is already in force');
  } finally {
    await gateway.close();
    store.close();
  }
});

await test('the admin page reports a window, and the date picker can narrow it', async () => {
  const store = openStore(':memory:');
  const { id } = store.addKey({ key: 'sk-wanda-x', label: 'wanda' });
  const today = startOfToday();
  store.record({ keyId: id, keyLabel: 'wanda', totalTokens: 40, status: STATUS.ok, ts: today + 60 });
  store.record({ keyId: id, keyLabel: 'wanda', totalTokens: 10, status: STATUS.ok, ts: today - 3 * 86400 + 60 });
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);

  const day = (offset) => {
    const d = new Date((today - offset * 86400) * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  try {
    // Default window is today only.
    const todayOnly = await realFetch(`${gateway.base}/admin/api/overview`).then((r) => r.json());
    assertEqual(todayOnly.window.days, 1, 'the default window is one day');
    assertEqual(todayOnly.window.from, day(0), 'from is today');
    assertEqual(todayOnly.report.reduce((a, r) => a + r.totalTokens, 0), 40, 'only today\'s tokens');
    assertEqual(todayOnly.daily.length, 1, 'one bucket for one day');

    // An explicit range reaches back and includes both days.
    const ranged = await realFetch(`${gateway.base}/admin/api/overview?from=${day(3)}&to=${day(0)}`).then((r) => r.json());
    assertEqual(ranged.window.days, 4, 'four calendar days, inclusive');
    assertEqual(ranged.report.reduce((a, r) => a + r.totalTokens, 0), 50, 'both recorded days');
    assertEqual(ranged.daily.length, 4, 'a bucket per day, including the quiet ones');
    // Zero-filled buckets are what let the UI show a gap instead of hiding it.
    assertEqual(ranged.daily.filter((d) => d.tokens === 0).length, 2, 'quiet days appear with zeros');

    // A reversed range is clamped rather than returning nothing.
    const reversed = await realFetch(`${gateway.base}/admin/api/overview?from=${day(0)}&to=${day(3)}`).then((r) => r.json());
    assertEqual(reversed.window.days, 1, 'a to-before-from range collapses to the start day');

    // Presets still work.
    const preset = await realFetch(`${gateway.base}/admin/api/overview?days=7`).then((r) => r.json());
    assertEqual(preset.window.days, 7, 'days=N preset');

    // Requests are filtered by the same window.
    const recent = await realFetch(`${gateway.base}/admin/api/requests?limit=50&from=${day(7)}&to=${day(0)}`).then((r) => r.json());
    assertEqual(recent.requests.length, 2, 'both requests inside the range');
  } finally {
    await gateway.close();
    store.close();
  }
});

await test('changing the window repaints the key and model tables, not just the cards', async () => {
  // Regression: the key/model tables were rendered once, server-side, and no
  // client code ever touched them. Picking a wider range updated the two
  // headline cards while the per-key numbers stayed frozen at "today" — the
  // exact symptom of "切了时间但 key 与用量没跟着刷新".
  const store = openStore(':memory:');
  const { id } = store.addKey({ key: 'sk-vera-x', label: 'vera', limitTokensPerDay: 1000 });
  const today = startOfToday();
  // 40 tokens today, 507 a week ago: the two windows must disagree visibly.
  store.record({ keyId: id, keyLabel: 'vera', totalTokens: 40, status: STATUS.ok, ts: today + 60 });
  store.record({ keyId: id, keyLabel: 'vera', totalTokens: 500, status: STATUS.ok, ts: today - 6 * 86400 + 60 });
  store.record({ keyId: id, keyLabel: 'vera', totalTokens: 7, status: STATUS.aborted, ts: today - 6 * 86400 + 120 });
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  try {
    const todayOnly = await realFetch(`${gateway.base}/admin/api/overview`).then((r) => r.json());
    const week = await realFetch(`${gateway.base}/admin/api/overview?days=7`).then((r) => r.json());

    // The response carries ready-made markup for both panels. Without it the
    // browser cannot rebuild the table at all: the copy payload embeds the
    // request's Host, which only the server sees.
    assert(typeof week.html?.keys === 'string' && week.html.keys.includes('<table'), 'the overview ships the key table markup');
    assert(typeof week.html?.models === 'string' && week.html.models.includes('<table'), 'and the model table markup');

    // The markup must differ between windows. A table that renders identical
    // HTML for a day and for a week is a table that is not scoped to the window.
    assert(week.html.keys !== todayOnly.html.keys, 'a week-wide key table differs from a one-day one');
    assert(week.html.models !== todayOnly.html.models, 'same for the model table');

    // And it must carry the numbers for the window it was asked for.
    assert(todayOnly.html.keys.includes('40'), "today's table shows today's 40 tokens");
    assert(!todayOnly.html.keys.includes('547'), "and not the week's total");
    assert(week.html.keys.includes('547'), 'the week table shows 40 + 500 + 7 = 547 tokens');
    assert(week.html.models.includes('547'), 'and so does the model table');
  } finally {
    await gateway.close();
    store.close();
  }
});

await test('the repainted key table keeps its pills and bars in step with the window', async () => {
  // A row that looks healthy on a narrow range must look capped on a range that
  // includes the spend; otherwise the pill contradicts the number beside it.
  const store = openStore(':memory:');
  const { id } = store.addKey({ key: 'sk-wes-x', label: 'wes', limitTokensPerDay: 100 });
  const today = startOfToday();
  store.record({ keyId: id, keyLabel: 'wes', totalTokens: 150, status: STATUS.ok, ts: today - 2 * 86400 + 60 });
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  try {
    const narrow = await realFetch(`${gateway.base}/admin/api/overview`).then((r) => r.json());
    const wide = await realFetch(`${gateway.base}/admin/api/overview?days=7`).then((r) => r.json());
    assert(narrow.html.keys.includes('pill on'), 'spending nothing today, the key looks healthy');
    assert(wide.html.keys.includes('pill capped'), 'over a range that includes the spend, it is capped');
    assert(wide.html.keys.includes('width:100%'), 'and its bar is full');
    assert(wide.html.keys.includes('150'), 'the cap is measured against the windowed total');
  } finally {
    await gateway.close();
    store.close();
  }
});

await test('a reload after creating a key keeps the selected window', async () => {
  // Regression: the create handler overwrote the hash with `#created=…`, so the
  // reload dropped `#w=…` and the page fell back to "today" — the operator's
  // range vanished right after they created a key. The hash now carries both
  // parts and the boot path reads them independently.
  const store = openStore(':memory:');
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  try {
    const html = await realFetch(`${gateway.base}/admin`).then((r) => r.text());
    assert(html.includes('hashOf({ w: currentQuery(), created: created.label })'), 'create carries the window forward');
    assert(html.includes('hashOf({ w: currentQuery() })'), 'row actions do too');
    assert(!/location\.hash = 'created='/.test(html), 'and nothing overwrites the window any more');
    assert(html.includes("hashPart(location.hash, 'w')"), 'boot reads the window part');
    assert(html.includes("hashPart(location.hash, 'created')"), 'and the created part');
    assert(html.includes('current = query;'), 'the active window is remembered');
  } finally {
    await gateway.close();
    store.close();
  }
});

await test('the page script is valid JavaScript, and encodes its window into the hash', async () => {
  // The page is one big template literal, so `node --check` on admin.js never
  // looks inside <script>: a syntax error there ships silently and breaks every
  // button on the page. Compiling the extracted script catches it, and the
  // round-trip check catches the other half of the same bug — a window written
  // into the hash as `w=from=…&to=…` is split on `&` when read back, so `to`
  // disappears and a 30-day range collapses to one day on the next refresh.
  const store = openStore(':memory:');
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  try {
    const html = await realFetch(`${gateway.base}/admin`).then((r) => r.text());
    const open = html.indexOf('<script>');
    const close = html.lastIndexOf('</script>');
    assert(open > 0 && close > open, 'the page carries exactly one inline script');
    const script = html.slice(open + '<script>'.length, close);
    // Compile only: running it needs a DOM. This is the check that `node --check`
    // on admin.js cannot do, because the whole page is one template literal.
    new vm.Script(script, { filename: 'admin-inline.js' });

    // Execute just the hash helpers, which are pure and self-contained. They are
    // lifted by anchor rather than by line number so a reshuffle does not
    // silently turn this into a no-op.
    const helpersStart = script.indexOf('function hashOf(');
    // Search *after* the helpers: the same loop header appears earlier, inside
    // `setPressed`, and anchoring on that first hit yields an empty slice.
    const helpersEnd = script.indexOf("for (const b of document.querySelectorAll('#presets button'))", helpersStart);
    assert(helpersStart > 0 && helpersEnd > helpersStart, 'the hash helpers are findable in the page script');
    const helpers = new vm.Script(
      script.slice(helpersStart, helpersEnd) + '\n;({ hashOf, hashPart });',
      { filename: 'admin-hash.js' },
    ).runInThisContext();

    const encoded = helpers.hashOf({ w: 'from=2026-10-12&to=2026-11-10' });
    // No leading `#`: the browser adds it when the value is assigned to
    // `location.hash`, and `hashPart` accepts either form.
    assertEqual(encoded, 'w=from%3D2026-10-12%26to%3D2026-11-10', 'the window is encoded as one value');
    assertEqual(helpers.hashPart('#' + encoded, 'w'), 'from=2026-10-12&to=2026-11-10', 'and reads back intact');
    assertEqual(helpers.hashPart(encoded, 'w'), 'from=2026-10-12&to=2026-11-10', 'with or without the leading #');
    assertEqual(helpers.hashPart('#w=days%3D7&created=alice', 'w'), 'days=7', 'parts are order-independent');
    assertEqual(helpers.hashPart('#w=days%3D7&created=alice', 'created'), 'alice', 'and both are readable');
    assertEqual(helpers.hashPart('#created=alice', 'w'), null, 'a missing window is null, not garbage');
    // The bug this locks: an unencoded window loses everything after the first `&`.
    assert(!encoded.includes('&to='), 'no raw `&` survives into the hash');
  } finally {
    await gateway.close();
    store.close();
  }
});

await test('the copy payload carries the base URL the viewer actually reached', async () => {
  // An operator opening /admin on loopback must not hand a colleague a
  // 127.0.0.1 URL: the key travels with the address that served the page.
  const store = openStore(':memory:');
  const { id, key } = store.addKey({ key: 'sk-xavier-x', label: 'xavier' });
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  try {
    // `fetch` refuses to override `Host` (it is a forbidden header name), so
    // the LAN case has to go through the low-level http client.
    const lan = await getWithHost(`${gateway.base}/admin`, '10.255.47.198:8317');
    assert(lan.includes('http://10.255.47.198:8317/v1'), 'the LAN host appears in the copy payload');
    assert(lan.includes(key), 'together with the key');

    const loopback = await realFetch(`${gateway.base}/admin`).then((r) => r.text());
    assert(loopback.includes('http://127.0.0.1'), 'a loopback request gets a loopback payload');
    assert(!loopback.includes('10.255.47.198:8317'), 'and not the LAN address it was not opened on');
  } finally {
    await gateway.close();
    store.close();
  }
});

await test('a cross-site POST to the admin API is refused', async () => {
  const store = openStore(':memory:');
  const provider = await makeProvider();
  const gateway = await startGateway(provider, store);
  try {
    const res = await realFetch(`${gateway.base}/admin/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ label: 'mallory' }),
    });
    assertEqual(res.status, 403, 'an alien Origin cannot mint keys');
    assertEqual(store.listKeys().length, 0, 'nothing was created');
  } finally {
    await gateway.close();
    store.close();
  }
});

await test('the OpenAI surface still works with no store at all (single-key mode)', async () => {
  const provider = await makeProvider();
  const server = createServer(provider, { apiKey: 'shared-secret' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assertEqual((await realFetch(`${base}/v1/models`)).status, 401, 'no key is refused');
    const ok = await realFetch(`${base}/v1/models`, { headers: { Authorization: 'Bearer shared-secret' } });
    assertEqual(ok.status, 200, 'the shared key works');
    assertEqual((await realFetch(`${base}/admin`)).status, 404, 'and there is no admin page without a store');
  } finally {
    server.close();
  }
});

await test('the quota snapshot is kept for reconciliation but never billed as tokens', async () => {
  const store = openStore(':memory:');
  try {
    store.recordQuota({ total: 4500, consumed: 1200, remaining: 3300, billingMode: 'credits', source: 'notify_usage' });
    const latest = store.latestQuota();
    assertEqual(latest.remaining, 3300, 'remaining is stored');
    assertEqual(latest.billing_mode, 'credits', 'and the billing mode');
    assertEqual(store.report().length, 0, 'a quota reading creates no usage row');
  } finally {
    store.close();
  }
});

await test('startOfToday is local midnight, so a 23:59 call and a 00:01 call fall in different days', async () => {
  const noon = new Date(2026, 9, 27, 12, 0, 0).getTime();
  const start = startOfToday(noon);
  const startDate = new Date(start * 1000);
  assertEqual([startDate.getHours(), startDate.getMinutes(), startDate.getSeconds()], [0, 0, 0], 'midnight');
  assertEqual(startDate.getDate(), 27, 'same calendar day');
});

console.log(process.exitCode ? '\nsmoke-gateway: FAILED' : '\nsmoke-gateway: PASSED');
