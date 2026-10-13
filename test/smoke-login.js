#!/usr/bin/env node
// test/smoke-login.js - offline end-to-end test of the `/trae-login` command.
//
// The plugin's login path (command registration -> webLogin -> authorize URL ->
// callback -> credential write) had no coverage: `lib/index.js` reaches the
// command registry through `ctx.get('commands')`, which the adapter/client
// suites never provide, so that whole branch was dead code under test.
//
// Nothing here touches the network or a browser:
//   * `openInApp` is stubbed, so `openBrowser()` never spawns the system opener.
//   * global `fetch` is a landmine, and the only request made is the *synthetic*
//     loopback callback, sent with the real fetch captured beforehand.
//   * HOME is redirected to a scratch dir before the plugin loads, so a bug here
//     can never overwrite the real ~/.trae-proxy/credentials.json.
//
//   node test/smoke-login.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, assertEqual, installShims, load, mockFetch, recordingLogger, test } from './support.js';

installShims();

// src/env.js derives CRED_DIR from `TRAE_PROXY_CRED_DIR` (or os.homedir()), so
// this must happen before the plugin module — and therefore that one — loads.
// $HOME itself is left alone on purpose: `lib/llm.js` also uses it as the last
// fallback root for the host's own `@deepseek-ai/*` packages, and moving it
// would break this suite's module resolution.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-login-'));
process.env.TRAE_PROXY_CRED_DIR = path.join(SCRATCH, '.trae-proxy');

const plugin = await load('lib/index.js');
const realFetch = globalThis.fetch;

const CRED_FILE = path.join(SCRATCH, '.trae-proxy', 'credentials.json');
const ENV = { ideVersion: '3.4.1', appVersionCode: 20260401, ideVersionCode: '20260401', source: 'test' };

function makeCtx({ commands = true } = {}) {
  const registered = [];
  const opened = [];
  const ctx = {
    logger: recordingLogger(),
    fiber: { entry: { options: { id: 'trae-cn' } } },
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get(name) {
      if (name === 'commands') {
        return commands ? { register: (definition) => (registered.push(definition), () => {}) } : undefined;
      }
      // Stubbed so `openBrowser()` cannot spawn the real system opener.
      if (name === 'openInApp') return { openUrl: (url) => opened.push(url) };
      return undefined;
    },
    llm: {
      registerConfigurableProviders: () => () => {},
      registerAdapter: () => Object.assign(() => {}, { replace: () => {} }),
    },
  };
  return { ctx, registered, opened };
}

await test('the login command registers and drives the browser flow', async () => {
  const { ctx, registered, opened } = makeCtx();
  // Any provider HTTP call during login is a bug: the credential callback path
  // is deliberately exchange-free.
  const mock = mockFetch((url) => {
    throw new Error(`unexpected upstream call during login: ${url}`);
  });
  try {
    plugin.apply(ctx, { credentialSource: 'oauth', ...ENV });

    assertEqual(registered.length, 1, 'exactly one human command registered');
    const command = registered[0];
    assertEqual(command.name, 'trae-login', 'command name');
    assertEqual(command.recordInput, false, 'the command does not record input');
    assert(typeof command.handler === 'function', 'command exposes a handler');

    const pending = command.handler();

    // webLogin() starts its loopback listener synchronously, so the authorize
    // URL is available within a few ticks.
    for (let i = 0; i < 200 && !opened.length; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEqual(opened.length, 1, 'authorize URL handed to the opener');

    const authorize = new URL(opened[0]);
    assertEqual(authorize.host, 'www.trae.cn', 'authorize host');
    assertEqual(authorize.pathname, '/authorization', 'authorize path');
    assertEqual(authorize.searchParams.get('client_id'), 'ono9krqynydwx5', 'client id');
    assertEqual(authorize.searchParams.get('code_challenge_method'), 'S256', 'PKCE method');
    assert(authorize.searchParams.get('code_challenge'), 'PKCE challenge present');
    const callback = authorize.searchParams.get('auth_callback_url');
    assert(callback?.startsWith('http://127.0.0.1:'), `loopback callback, got ${callback}`);

    // Trae answers the callback by delivering credentials directly (measured):
    // there is no authorization code and therefore no exchange round trip.
    const jwt = {
      Token: 'fake-access-token-not-a-real-secret',
      RefreshToken: 'fake-refresh-token',
      TokenExpireAt: Date.now() + 3600_000,
      RefreshExpireAt: Date.now() + 86_400_000,
    };
    const userInfo = { UserInfo: { UserID: '429404416', Name: 'tester' } };
    const query = new URLSearchParams({
      scope: 'saas',
      host: 'https://api.trae.cn',
      userJwt: JSON.stringify(jwt),
      userInfo: JSON.stringify(userInfo),
      refreshToken: jwt.RefreshToken,
    });
    const response = await realFetch(`${callback}?${query}`);
    assertEqual(response.status, 200, 'synthetic callback accepted');

    const result = await pending;
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    assert(/登录成功/.test(text), `handler reports success, got: ${text}`);

    assert(fs.existsSync(CRED_FILE), `credentials written to the scratch HOME (${CRED_FILE})`);
    const saved = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    assertEqual(saved.refreshToken, jwt.RefreshToken, 'refresh token persisted');
    assertEqual(saved.token, jwt.Token, 'access token persisted');
    assertEqual(saved.userId, '429404416', 'user id persisted');
    assert(JSON.stringify(saved).indexOf(SCRATCH) === -1, 'no scratch path leaked into the credential');
  } finally {
    mock.restore();
  }
});

await test('a host without the commands service degrades instead of failing', async () => {
  const { ctx, registered } = makeCtx({ commands: false });
  const mock = mockFetch(() => {
    throw new Error('no upstream call expected');
  });
  try {
    // Must not throw: the plugin is optional-commands.
    plugin.apply(ctx, { credentialSource: 'oauth', ...ENV });
    assertEqual(registered.length, 0, 'nothing registered without the service');
  } finally {
    mock.restore();
  }
});

// The scratch HOME must never be the real one, or this suite would clobber the
// operator's own login.
assert(SCRATCH !== os.userInfo().homedir || SCRATCH.startsWith(os.tmpdir()), 'scratch HOME is isolated');

console.log(process.exitCode ? 'smoke-login: FAILED' : 'smoke-login: PASSED');
