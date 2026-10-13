#!/usr/bin/env node
// test/live-refresh.js - OPT-IN live check of the expiry-triggered refresh path.
//
//   node test/live-refresh.js
//
// Not part of `npm run check`: it needs the network and a real refresh token.
//
// Why it exists: the offline suites cover `needsRefresh()`, the store's refresh
// call and the enterprise host choice *separately*. This one exercises the
// chain as it actually runs in production —
//
//   expired access token -> adapter.ensureFresh() -> store.refresh()
//     -> POST <account host>/cloudide/api/v3/trae/oauth/ExchangeToken
//     -> rotated token persisted -> the original request succeeds
//
// Isolation: the credential file is redirected with TRAE_PROXY_CRED_DIR and
// starts from a *copy* whose expiry has been forced into the past, so the real
// ~/.trae-proxy/credentials.json is never read or written. Refresh tokens are
// not single-use (measured), so rotating the copy does not disturb the original.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL_CRED = path.join(os.homedir(), '.trae-proxy', 'credentials.json');
if (!fs.existsSync(REAL_CRED)) {
  console.error(`skip: no credentials at ${REAL_CRED} (run the login first)`);
  process.exit(0);
}

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-live-refresh-'));
const SCRATCH_CRED = path.join(SCRATCH, 'credentials.json');
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const realBefore = digest(REAL_CRED);

const original = JSON.parse(fs.readFileSync(REAL_CRED, 'utf8'));
const stale = { ...original, expiresAt: Math.floor(Date.now() / 1000) - 3600, expiredRaw: '' };
fs.writeFileSync(SCRATCH_CRED, JSON.stringify(stale, null, 2), { mode: 0o600 });

process.env.TRAE_PROXY_CRED_DIR = SCRATCH;

const { TraeAdapter } = await import('../lib/adapter.js');
const { CredentialStore } = await import('../lib/credentials.js');
const { detectEnv } = await import('../src/env.js');

const env = detectEnv();
const store = new CredentialStore({ scope: 'trae-cn', id: 'trae-cn', source: 'oauth', edition: 'cn' });
const adapter = new TraeAdapter({ env, credentials: store, requestStyle: 'chat_v3', logger: console });

// Record every outbound URL so the refresh host can be asserted.
const seen = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  seen.push(String(url));
  return realFetch(url, init);
};

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log(`scratch: ${SCRATCH}`);
console.log(`stale expiresAt: ${new Date(stale.expiresAt * 1000).toISOString()}\n`);

try {
  const models = await adapter.listModels('trae-cn');
  check(models.length > 0, 'a request with an expired token succeeds', `${models.length} models`);

  const refreshCalls = seen.filter((u) => u.includes('/oauth/ExchangeToken'));
  check(refreshCalls.length >= 1, 'the refresh endpoint was called', refreshCalls[0] ?? '(none)');
  check(
    refreshCalls.every((u) => u.startsWith(original.host)),
    'the refresh used the account\'s own host',
    `expected prefix ${original.host}`,
  );
  check(
    refreshCalls.every((u) => !u.startsWith('https://api.trae.cn')),
    'the refresh did NOT fall back to the hardcoded api.trae.cn',
  );

  const rotated = JSON.parse(fs.readFileSync(SCRATCH_CRED, 'utf8'));
  check(rotated.token !== stale.token, 'the access token was rotated');
  check(
    rotated.expiresAt > Math.floor(Date.now() / 1000),
    'the persisted expiry moved into the future',
    new Date(rotated.expiresAt * 1000).toISOString(),
  );
  check(Boolean(rotated.refreshToken), 'a refresh token is still present after rotation');
  check(rotated.userId === original.userId, 'the user id survived the rotation');

  check(digest(REAL_CRED) === realBefore, 'the real credential file was not touched');
} catch (err) {
  const message = err?.message ?? String(err);
  check(false, 'the refresh chain completed', message);
  // The gateway masks a dead refresh token as its own business code
  // `30022 网络异常`. That is a credential state, not a plugin defect, so say
  // which one it is instead of leaving the operator guessing.
  if (/30022|refresh token 已失效|REFRESH_FAILED/.test(message)) {
    console.log('\n诊断：这枚 refresh token 已失效（网关把它报成「网络异常」，实际是鉴权失败）。');
    console.log('这不是插件的缺陷 —— 重新登录后本项即可通过：');
    console.log('  node src/cli.js login      # 或安装后在 DSH 里运行登录命令');
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\nlive-refresh: ${failures ? 'FAILED' : 'PASSED'}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
