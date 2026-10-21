#!/usr/bin/env node
// test/smoke-plugin.js - the plugin *entry* contract, which the adapter/client
// suites do not touch.
//
// Every bug this file exists to catch was found only by actually booting a real
// DSH profile, and two of them aborted the entire boot rather than degrading:
//
//   1. `Config` was a plain defaults object when `@deepseek-ai/schemastery` did
//      not resolve. cordis validates through `Config['~standard'].validate`, so
//      the plugin took the whole profile down with
//      "Cannot read properties of undefined (reading 'validate')".
//      (`installShims()` makes schemastery resolve here, so this file asserts
//      the *real* schema path; `test/check.sh` runs the fallback path.)
//   2. The OpenAI surface passed `createServer(provider)` — an `http.Server` —
//      to `webServer.register()` as if it were a `(req, res)` handler, so every
//      mounted request failed as an opaque 400.
//
//   node test/smoke-plugin.js
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { assert, assertEqual, installShims, load, mockFetch, recordingLogger, sse, sseResponse, test, userMessage } from './support.js';

installShims();

// Hermetic credentials.
//
// This suite drives `apply()` with the default `credentialSource: 'oauth'`, so
// without this it would read the developer's own ~/.trae-proxy/credentials.json
// — passing on a machine that happens to be logged in and failing on a fresh
// clone or in CI. That is a test that passes for the wrong reason.
//
// `src/env.js` reads TRAE_PROXY_CRED_DIR at import time, so this has to run
// before the plugin module is loaded.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-plugin-'));
process.env.TRAE_PROXY_CRED_DIR = path.join(SCRATCH, '.trae-proxy');
const CRED_FILE = path.join(SCRATCH, '.trae-proxy', 'credentials.json');

const STUB_CREDS = {
  source: 'oauth',
  clientId: 'client-under-test',
  token: 'fake-access-token-not-a-real-secret',
  refreshToken: 'fake-refresh-token',
  userId: '429404416',
  // Already in the past-but-truthy range that needsRefresh() ignores, so no
  // refresh is attempted and the mocked fetch is the only traffic.
  expiresAt: 0,
  host: 'https://api.trae.cn',
  deviceInfo: { DeviceID: 'device-1', MachineID: 'machine-1' },
};
const writeStubCredentials = () => {
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify(STUB_CREDS), { mode: 0o600 });
};
const hideStubCredentials = () => {
  try {
    fs.rmSync(CRED_FILE);
  } catch {
    /* already absent */
  }
};
writeStubCredentials();

const plugin = await load('lib/index.js');
const { TraeProvider } = await load('src/openai-server.js');

const CATALOG = {
  code: 0,
  data: {
    config_info_list: [
      {
        config_name: 'glm-5.2',
        config_source: 1,
        config_switch: true,
        usage: 'chat_completion',
        context_window_tokens: { dev: 116000 },
        display_config: { display_name: 'GLM-5.2' },
        model_detail_list: [{ model_name: 'glm-5.2__dev', prompt_max_tokens: 100000 }],
      },
      {
        // Internal nodes must be filtered out of the published catalog.
        config_name: 'summary',
        config_source: 1,
        config_switch: true,
        usage: 'summary',
        model_detail_list: [{ model_name: 'Doubao_1_6', prompt_max_tokens: 1000 }],
      },
    ],
  },
};

const CHAT_SSE = [
  sse('output', { content: 'ok' }),
  sse('token_usage', { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
  sse('done', { finish_reason: 'stop' }),
  'data: [DONE]\n\n',
].join('');

const ENV = { ideVersion: '3.4.1', appVersionCode: 20260401, ideVersionCode: '20260401', source: 'test' };

/** A ctx covering exactly what `apply()` touches: effect / fiber / get / llm / logger. */
function makeCtx({ withWebServer = true } = {}) {
  const calls = { adapters: [], providers: [], commands: [], mounts: [], disposed: 0 };
  const ctx = {
    logger: recordingLogger(),
    fiber: { entry: { options: { id: 'trae-cn' } } },
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get(name) {
      if (name === 'webServer') return withWebServer ? ctx.webServer : undefined;
      return undefined;
    },
    llm: {
      registerConfigurableProviders(entries) {
        calls.providers.push(...entries);
        return () => {};
      },
      registerAdapter(providers, adapter) {
        calls.adapters.push({ providers, adapter });
        return Object.assign(() => {}, { replace: () => {} });
      },
    },
    webServer: {
      register(route) {
        calls.mounts.push(route);
        return () => {
          calls.disposed += 1;
        };
      },
    },
  };
  return { ctx, calls };
}

/** Drive a captured `kind: 'prefix'` mount the way the host web server does. */
function serveMount(mount) {
  const server = http.createServer((req, res) => {
    const original = req.url ?? '/';
    const queryIndex = original.indexOf('?');
    const pathname = queryIndex < 0 ? original : original.slice(0, queryIndex);
    const search = queryIndex < 0 ? '' : original.slice(queryIndex);
    const rest = pathname.startsWith(mount.path) ? pathname.slice(mount.path.length) : pathname;
    req.url = `${rest || '/'}${search}`;
    try {
      return mount.handler(req, res);
    } finally {
      req.url = original;
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

await test('Config is a Standard Schema cordis can validate', async () => {
  assert(plugin.Config, 'Config is exported');
  assert(plugin.Config['~standard'], 'Config exposes ~standard');
  // The exact call cordis makes in resolveConfig().
  const result = plugin.Config['~standard'].validate({});
  assert(!('then' in result), 'validation is synchronous');
  assert(!result.issues, `validation reported issues: ${JSON.stringify(result.issues)}`);
  assertEqual(result.value.requestStyle, 'chat_v3', 'default requestStyle');
  assertEqual(result.value.credentialSource, 'oauth', 'default credentialSource');
  assertEqual(result.value.openAIPath, '/trae-cn', 'mount prefix, not the base URL');
  const overridden = plugin.Config['~standard'].validate({ credentialSource: 'local', edition: 'sg' }).value;
  assertEqual(overridden.credentialSource, 'local', 'override honoured');
  assertEqual(overridden.edition, 'sg', 'override honoured');
});

await test('apply() registers the provider, the adapter and the mount', async () => {
  const mock = mockFetch((url) => {
    if (url.includes('get_detail_param')) return CATALOG;
    if (url.includes('llm_utils_chat')) return sseResponse(CHAT_SSE);
    throw new Error(`unexpected url ${url}`);
  });
  const { ctx, calls } = makeCtx();
  try {
    const api = plugin.apply(ctx, { credentialSource: 'oauth', ideVersion: ENV.ideVersion, appVersionCode: ENV.appVersionCode });

    assertEqual(plugin.name, 'trae-cn-provider', 'plugin name');
    assert(plugin.inject.includes('llm'), "inject includes 'llm'");

    assertEqual(calls.providers.length, 1, 'one configurable provider registered');
    assertEqual(calls.providers[0].provider, 'trae-cn', 'provider id');
    assertEqual(calls.providers[0].settingsNs, 'trae-cn', 'settings namespace follows the patch row id');

    assertEqual(calls.adapters.length, 1, 'one adapter registered');
    assertEqual(calls.adapters[0].providers, ['trae-cn'], 'adapter owns the trae-cn route');
    const adapter = calls.adapters[0].adapter;
    // cordis rejects an adapter whose providerInfo().id does not match the route.
    assertEqual(adapter.providerInfo('trae-cn').id, 'trae-cn', 'providerInfo id matches the route');

    const models = await adapter.listModels('trae-cn');
    assert(models.length === 1, `internal nodes filtered out, got ${models.map((m) => m.id).join(',')}`);
    assertEqual(models[0].id, 'glm-5.2', 'catalog model id');

    assertEqual(calls.mounts.length, 1, 'OpenAI surface mounted');
    assertEqual(calls.mounts[0].kind, 'prefix', 'mount is a prefix route');
    assertEqual(calls.mounts[0].path, '/trae-cn', 'mount prefix');
    assert(api?.adapter, 'apply returns the adapter handle');
  } finally {
    mock.restore();
  }
});

await test('prepareCall().stream() returns an AsyncIterable, not a promise of one', async () => {
  // The harness (`dsh-llm` -> adapterStream) dereferences `Symbol.asyncIterator`
  // *synchronously* on whatever `prepareCall().stream()` returns, so it must be
  // an async iterable itself. An earlier bug pointed `stream` at the async
  // `streamWithInfo`, which resolves to the iterable — a Promise — and every
  // model call died instantly with
  // `dispatch(...)[Symbol.asyncIterator] is not a function`.
  const mock = mockFetch((url) => {
    if (url.includes('get_detail_param')) return CATALOG;
    if (url.includes('llm_utils_chat')) return sseResponse(CHAT_SSE);
    throw new Error(`unexpected url ${url}`);
  });
  const { ctx, calls } = makeCtx();
  try {
    plugin.apply(ctx, { credentialSource: 'oauth', ideVersion: ENV.ideVersion, appVersionCode: ENV.appVersionCode });
    const adapter = calls.adapters[0].adapter;

    const prepared = await adapter.prepareCall('trae-cn', 'glm-5.2', undefined);
    const dispatched = prepared.stream({ provider: 'trae-cn', model: 'glm-5.2', messages: [userMessage('hi')] });

    // Synchronous contract the host enforces.
    assert(
      typeof dispatched?.[Symbol.asyncIterator] === 'function',
      `stream() must be an AsyncIterable, got ${dispatched?.constructor?.name ?? typeof dispatched}`,
    );

    // And it still produces the real chunk stream end to end.
    const chunks = [];
    for await (const chunk of dispatched) chunks.push(chunk.type);
    assert(chunks.includes('text-delta') || chunks.includes('block-start'), `stream delivered content chunks, got ${chunks.join(',')}`);
    assert(chunks.includes('finish'), `stream delivered a terminal finish, got ${chunks.join(',')}`);
  } finally {
    mock.restore();
  }
});

await test('the mounted surface answers /trae-cn/v1/models and a chat completion', async () => {
  let sawBody = null;
  // Captured before `mockFetch` swaps the global: the requests below go to our
  // own loopback server and must not be swallowed by the upstream stub.
  const realFetch = globalThis.fetch;
  const mock = mockFetch((url, init) => {
    if (url.includes('get_detail_param')) return CATALOG;
    if (url.includes('llm_utils_chat')) {
      sawBody = JSON.parse(init.body);
      return sseResponse(CHAT_SSE);
    }
    throw new Error(`unexpected url ${url}`);
  });
  const { ctx, calls } = makeCtx();
  try {
    plugin.apply(ctx, { credentialSource: 'oauth', ideVersion: ENV.ideVersion, appVersionCode: ENV.appVersionCode });
    const mount = calls.mounts[0];
    const { server, base } = await serveMount(mount);
    try {
      const health = await realFetch(`${base}/trae-cn/health`);
      assertEqual(health.status, 200, 'health status');

      const listed = await realFetch(`${base}/trae-cn/v1/models`);
      assertEqual(listed.status, 200, 'models status');
      // No blanket CORS grant: a page must not be able to read this surface.
      assertEqual(listed.headers.get('access-control-allow-origin'), null, 'no wildcard Access-Control-Allow-Origin');
      const body = await listed.json();
      assertEqual(body.data.length, 1, 'models listed');
      assertEqual(body.data[0].id, 'glm-5.2', 'model id');

      // A browser-originated request would spend the signed-in user's Trae quota,
      // so it is refused before any upstream call. `sawBody` staying null above
      // and below proves nothing reached the provider.
      const crossOrigin = await realFetch(`${base}/trae-cn/v1/models`, {
        headers: { Origin: 'https://evil.example' },
      });
      assertEqual(crossOrigin.status, 403, 'cross-origin request refused');
      assertEqual(crossOrigin.headers.get('access-control-allow-origin'), null, 'refusal carries no CORS grant');
      const refusal = await crossOrigin.json();
      assertEqual(refusal.error.type, 'permission_error', 'refusal type');

      const crossOriginChat = await realFetch(`${base}/trae-cn/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: false }),
      });
      assertEqual(crossOriginChat.status, 403, 'cross-origin chat refused');

      const chat = await realFetch(`${base}/trae-cn/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: false }),
      });
      assertEqual(chat.status, 200, 'chat status');
      const completion = await chat.json();
      assertEqual(completion.choices[0].message.content, 'ok', 'chat content');
      // The verified wire shape, not the experimental one.
      assertEqual(sawBody.function, 'chat_v3', 'wire function');
      assertEqual(sawBody.config_name, 'glm-5.2', 'config_name present');
      assertEqual(sawBody.model_name, 'glm-5.2__dev', 'model_name carries the __dev profile');
    } finally {
      server.close();
    }
  } finally {
    mock.restore();
  }
});

await test('allowBrowserOrigins admits only the origins it lists', async () => {
  const realFetch = globalThis.fetch;
  const { createServer } = await import('../src/openai-server.js');
  const provider = { ready: true, env: { source: 'test' }, models: async () => [], logger: {} };
  const server = createServer(provider, { allowOrigins: ['https://ok.example'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const allowed = await realFetch(`${base}/v1/models`, { headers: { Origin: 'https://ok.example' } });
    assertEqual(allowed.status, 200, 'listed origin passes');
    assertEqual(allowed.headers.get('access-control-allow-origin'), 'https://ok.example', 'echoes the listed origin');
    assertEqual(allowed.headers.get('vary'), 'Origin', 'Vary: Origin on an allowed reply');

    const other = await realFetch(`${base}/v1/models`, { headers: { Origin: 'https://other.example' } });
    assertEqual(other.status, 403, 'unlisted origin still refused');
  } finally {
    server.close();
  }
});

await test('apply() tolerates a host without the webServer service', async () => {
  const mock = mockFetch((url) => {
    if (url.includes('get_detail_param')) return CATALOG;
    throw new Error(`unexpected url ${url}`);
  });
  const { ctx, calls } = makeCtx({ withWebServer: false });
  try {
    plugin.apply(ctx, { credentialSource: 'oauth', ideVersion: ENV.ideVersion, appVersionCode: ENV.appVersionCode });
    assertEqual(calls.adapters.length, 1, 'adapter still registered');
    assertEqual(calls.mounts.length, 0, 'no mount without a web server');
  } finally {
    mock.restore();
  }
});

await test('a missing credential is a clear error, never a crash or a leak', async () => {
  const mock = mockFetch(() => {
    throw new Error('no request should be made without credentials');
  });
  const { ctx, calls } = makeCtx();
  hideStubCredentials();
  try {
    // apply() itself must stay inert with no login present.
    plugin.apply(ctx, { credentialSource: 'oauth', ideVersion: ENV.ideVersion, appVersionCode: ENV.appVersionCode });
    assertEqual(calls.adapters.length, 1, 'the adapter is still registered');

    let caught;
    try {
      await calls.adapters[0].adapter.listModels('trae-cn');
    } catch (err) {
      caught = err;
    }
    assert(caught, 'asking for models rejects rather than returning garbage');
    assertEqual(caught.code, 'MISSING_CREDENTIAL', 'a stable code');
    assert(/trae-login/.test(caught.message), 'the message names the login command');
    assert(!/fake-access-token|fake-refresh-token/.test(caught.message), 'no token in the message');
  } finally {
    writeStubCredentials();
    mock.restore();
  }
});

await test('the login command returns a result the host accepts', async () => {
  // `CommandResult` is a closed union validated at the registry boundary by
  // @deepseek-ai/dsh-commands (`normalizeResult` in its lib/index.js), which
  // throws `command "<name>" returned unknown result kind "<kind>"`. The entry
  // used to return { kind: 'text', text }, so /trae-login completed the login
  // and then threw on return — and nothing here caught it, because the suite
  // asserted registration but never the handler's return value.
  const { commandSuccess, commandFailure } = await load('lib/support.js');

  // Mirrors the host's rules, quoted from that source.
  const assertCommandResult = (label, value) => {
    assert(value && typeof value === 'object', `${label}: handler must return a CommandResult`);
    assert('kind' in value, `${label}: missing kind`);
    if (value.kind === 'success') {
      assert(
        value.text === undefined || typeof value.text === 'string',
        `${label}: success text must be a string when supplied`,
      );
      return;
    }
    if (value.kind === 'error') {
      assert(
        typeof value.text === 'string' && value.text.trim().length > 0,
        `${label}: error text must be a non-empty string`,
      );
      return;
    }
    throw new Error(`${label}: unknown result kind "${String(value.kind)}"`);
  };

  assertCommandResult('commandSuccess', commandSuccess('已登录'));
  assertCommandResult('commandFailure', commandFailure('登录失败：示例'));
  assertEqual(commandSuccess('x').kind, 'success', "the success kind is 'success', not 'text'");
  assertEqual(commandFailure('x').kind, 'error', "the failure kind is 'error'");
  assertEqual(commandFailure('x').text, 'x', 'the failure field is `text`, not `message`');

  // A success result without text is legal in the host's shape.
  assertCommandResult('commandSuccess(undefined)', commandSuccess(undefined));
});

// Referenced so the fixture is not mistaken for dead code if the suites change.
assert(TraeProvider, 'the OpenAI surface provider is importable');
assert(STUB_CREDS.token.startsWith('fake-'), 'the fixture token is obviously fake');

console.log(process.exitCode ? 'smoke-plugin: FAILED' : 'smoke-plugin: PASSED');
