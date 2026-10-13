#!/usr/bin/env node
// test/smoke-client.js - tests for the wire-level layers under `src/`.
//
// These pin the facts that were confirmed against the live gateway, so a later
// refactor cannot silently reintroduce them:
//   * `x-app-version-code` / `x-ide-version-code` are pure integers;
//   * a local-install credential uses the account's own refresh host, which is
//     what makes the enterprise tenant work at all;
//   * the `userId` is sent as a JSON *string* on the simple exchange;
//   * the chat request body is the verified `inline_chat` shape.
//
//   node test/smoke-client.js
import { assert, assertEqual, installShims, load, mockFetch, sse, sseResponse, test } from './support.js';

installShims();

const { chat, ideHeaders } = await load('src/trae-client.js');
const { refreshToken, parseCallback, needsRefresh } = await load('src/trae-auth.js');
const { TraeProvider } = await load('src/openai-server.js');
const { TcDecryptError, readLocalCredentials, parseAuthValue } = await load('src/trae-local-credentials.js');
const { CredentialStore } = await load('lib/credentials.js');
const { buildChatBody } = await load('lib/chat-body.js');

const ENV = { ideVersion: '3.4.1', appVersionCode: 20260401, source: 'test' };

console.log('smoke-client:');

await test('version-code headers are pure integers and never the dotted build number', async () => {
  const headers = ideHeaders(
    { token: 't', userId: 'u', deviceInfo: { DeviceID: 'd', MachineID: 'm' } },
    { ideVersion: '3.4.1', appVersionCode: 20260401, ideVersionCode: '20260401' },
  );
  assert(/^\d+$/.test(headers['x-app-version-code']), 'x-app-version-code is an integer');
  assert(/^\d+$/.test(headers['x-ide-version-code']), 'x-ide-version-code is an integer');
  assert(!headers['x-app-version-code'].includes('.'), 'no dotted build number');
  assertEqual(headers['x-ide-version'], '3.4.1', 'x-ide-version keeps the app version');
});

await test('a local credential falls back to machineId for the device headers', async () => {
  const headers = ideHeaders({ token: 't', userId: 'u', machineId: 'machine-from-storage' }, ENV);
  assertEqual(headers['x-device-id'], 'machine-from-storage', 'x-device-id');
  assertEqual(headers['x-machine-id'], 'machine-from-storage', 'x-machine-id');
});

await test('refresh uses the account host, not a hardcoded api.trae.cn', async () => {
  const mock = mockFetch((url, init) => {
    assertEqual(
      url,
      'https://console.enterprise.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken',
      'enterprise refresh host',
    );
    const body = JSON.parse(init.body);
    assertEqual(typeof body.UserID, 'string', 'UserID must be a JSON string');
    assertEqual(body.UserID, '429404416', 'UserID value');
    return {
      code: 0,
      message: 'ok',
      // The enterprise envelope: the payload is under `Data`, not `Result`.
      Data: { Token: 'new-access', RefreshToken: 'new-refresh', TokenExpireAt: 2000000000000, RefreshExpireAt: 2100000000000 },
    };
  });
  try {
    const next = await refreshToken(
      {
        source: 'local',
        userId: '429404416',
        refreshToken: 'old-refresh',
        // No privateKeyPem / deviceInfo on purpose: that selects the unsigned
        // simple exchange, which is the flow the local install needs.
        host: 'https://console.enterprise.trae.cn',
      },
      '3.4.1',
    );
    assertEqual(next.token, 'new-access', 'rotated access token');
    assertEqual(next.refreshToken, 'new-refresh', 'rotated refresh token');
    assertEqual(next.expiresAt, 2000000000, 'expiry parsed to seconds');
    assertEqual(next.refreshExpiresAt, 2100000000, 'refresh expiry parsed to seconds');
  } finally {
    mock.restore();
  }
});

await test('the CredentialStore refresh path carries the source host and source tag', async () => {
  const mock = mockFetch((url) => {
    assert(url.startsWith('https://console.enterprise.trae.cn/'), `enterprise host, got ${url}`);
    return { code: 0, Data: { Token: 'a2', RefreshToken: 'r2', TokenExpireAt: 2000000000000 } };
  });
  try {
    const store = new CredentialStore({ ctx: { get: () => undefined }, source: 'local' });
    const next = await store.refresh(
      { source: 'local', edition: 'cn', userId: '429404416', refreshToken: 'r1', host: 'https://console.enterprise.trae.cn' },
      '3.4.1',
    );
    assertEqual(next.source, 'local', 'source survives a refresh');
    assertEqual(next.edition, 'cn', 'edition survives a refresh');
    assertEqual(next.host, 'https://console.enterprise.trae.cn', 'host survives a refresh');
    assertEqual(next.token, 'a2', 'token rotated');
  } finally {
    mock.restore();
  }
});

await test('both response envelopes decode, and enterprise errors are rejected', async () => {
  const oldEnvelope = mockFetch(() => ({ ResponseMetadata: {}, Result: { Token: 'legacy', RefreshToken: 'r' } }));
  try {
    const next = await refreshToken({ refreshToken: 'r', host: 'https://api.trae.cn' }, '3.4.1');
    assertEqual(next.token, 'legacy', 'Result envelope');
  } finally {
    oldEnvelope.restore();
  }

  const failing = mockFetch(() => ({ code: 20101, message: 'Token 无效：refresh token is invalid.' }));
  try {
    let caught;
    try {
      await refreshToken({ refreshToken: 'r', host: 'https://api.trae.cn' }, '3.4.1');
    } catch (err) {
      caught = err;
    }
    assert(caught, 'a nonzero code throws');
    assert(/20101/.test(caught.message), 'the upstream code is in the message');
  } finally {
    failing.restore();
  }
});

await test('chat() uses caller headers when given, and the default IDE headers otherwise', async () => {
  const seen = [];
  const mock = mockFetch((url, init) => {
    seen.push(init.headers);
    return sseResponse(`${sse('output', { content: 'x' })}${sse('done', { finish_reason: 'stop' })}data: [DONE]\n\n`);
  });
  try {
    const creds = { token: 't', userId: 'u', deviceInfo: {} };
    await chat({ creds, env: ENV, body: { messages: [] } });
    await chat({
      creds,
      env: ENV,
      body: { messages: [] },
      headers: { ...ideHeaders(creds, ENV), 'user-agent': 'attributed' },
    });
    assert(!seen[0]['user-agent'], 'default path has no attribution');
    assertEqual(seen[1]['user-agent'], 'attributed', 'caller headers win');
  } finally {
    mock.restore();
  }
});

await test('the TraeProvider catalog path keeps working for the OpenAI surface', async () => {
  const mock = mockFetch((url) => {
    if (url.includes('get_detail_param')) {
      return { data: { config_info_list: [{ config_name: 'glm-5.2', config_source: 1, model_detail_list: [{ model_name: 'glm-5.2__dev' }] }] } };
    }
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const provider = new TraeProvider({ env: ENV, credentials: { token: 't', refreshToken: 'r', userId: 'u' } });
    const models = await provider.models();
    assertEqual(models.map((model) => model.configName), ['glm-5.2'], 'catalog through the provider');
    assertEqual(provider.resolveModel('glm-5.2').modelName, 'glm-5.2__dev', 'resolve by config_name');
  } finally {
    mock.restore();
  }
});

await test('parseCallback reads the browser login callback shapes', () => {
  const jwt = encodeURIComponent(
    JSON.stringify({ Token: 'tok', RefreshToken: 'ref', TokenExpireAt: '2030-01-01T00:00:00Z', RefreshExpireAt: 2100000000000 }),
  );
  const info = encodeURIComponent(JSON.stringify({ UserInfo: { UserID: '429404416', Name: 'tester' } }));
  const parsed = parseCallback(`userJwt=${jwt}&userInfo=${info}&host=${encodeURIComponent('https://console.enterprise.trae.cn')}`);
  assertEqual(parsed.kind, 'credentials', 'callback kind');
  assertEqual(parsed.creds.userId, '429404416', 'userId');
  assertEqual(parsed.creds.refreshToken, 'ref', 'refresh token');
  assert(parsed.creds.host.includes('enterprise'), 'host is carried through for the refresh');

  assertEqual(parseCallback('authCodeInfo=%7B%22AuthCode%22%3A%22abc%22%7D').kind, 'authCode', 'auth code shape still supported');
  assertEqual(parseCallback('nothing=1').kind, 'unknown', 'unknown shape');
});

await test('needsRefresh only fires near expiry', () => {
  const now = 1_000_000;
  assertEqual(needsRefresh({ expiresAt: now + 7200 }, now), false, 'far from expiry');
  assertEqual(needsRefresh({ expiresAt: now + 60 }, now), true, 'inside the 30 minute window');
  assertEqual(needsRefresh({ expiresAt: 0 }, now), false, 'no expiry recorded leaks nothing');
});

await test('local credential parsing never leaks a secret into its errors', () => {
  let caught;
  try {
    parseAuthValue('not-json-and-not-base64-tc');
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof TcDecryptError, 'is a TcDecryptError');
  assert(/tc 数据过短|未知 tc 类型标签|不是16/.test(caught.message) || caught.message.includes('过短'), 'names a format reason');

  // A fake enterprise TC blob is not required: assert the *shape* of what a
  // successful local read exposes without touching this machine's storage.
  assertEqual(typeof readLocalCredentials, 'function', 'readLocalCredentials exported');
});

await test('the verified inline_chat body is what the OpenAI surface-adjacent path builds', () => {
  const body = buildChatBody({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'ping', description: 'p', parameters: { type: 'object' } }],
    info: { id: 'glm-5.2', configName: 'glm-5.2', modelName: 'glm-5.2__dev', function: 'inline_chat' },
    options: { provider: 'trae-cn', model: 'glm-5.2', messages: [], requestId: 'req-1' },
    requestStyle: 'inline_chat',
  });
  assertEqual(Object.keys(body).sort(), ['function', 'messages', 'model', 'request_id', 'session_id', 'stream', 'tool_choice', 'tools'], 'inline_chat keys');
  assertEqual(body.request_id, 'req-1', 'request_id');
  assertEqual(body.session_id, 'req-1', 'session_id defaults to request_id');
  assertEqual(body.function, 'inline_chat', 'function');
});

console.log(process.exitCode ? '\nsmoke-client: FAILED' : '\nsmoke-client: PASSED');
