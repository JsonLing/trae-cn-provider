#!/usr/bin/env node
// test/smoke-gateway.js - the b2b gateway: key table, daily caps, usage ledger,
// and the admin surface.
//
//   node test/smoke-gateway.js
//
// Everything here is offline: the upstream is a scripted `fetch`, and the
// database is a real (in-memory or temp-file) SQLite opened through
// `node:sqlite`, so the SQL itself is exercised rather than mocked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// ---------------------------------------------------------------- admin
await test('the admin page renders real numbers server-side', async () => {
  const store = openStore(':memory:');
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
