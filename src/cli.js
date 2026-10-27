#!/usr/bin/env node
// cli.js - login / models / serve / chat / usage / keys / report
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectEnv, loadCredentials, saveCredentials, CRED_DIR, CRED_FILE } from './env.js';
import { webLogin } from './trae-auth.js';
import { chat } from './trae-client.js';
import { fetchQuota, formatQuota, tenantOf } from './quota.js';
import { TraeProvider, startServer } from './openai-server.js';
import { openStore, startOfToday, SQLITE_HELP, keyStem } from './store.js';
import { createAdminHandler } from './admin.js';

/** Where the gateway database lives unless `--db` says otherwise. */
export const DEFAULT_DB = path.join(CRED_DIR, 'gateway.db');

function requireCredentials() {
  const creds = loadCredentials();
  if (!creds) {
    console.error(`未找到凭据 (${CRED_FILE})，请先运行: node src/cli.js login`);
    process.exit(1);
  }
  return creds;
}

/**
 * Parse `--flag value` and `--flag=value` after the command name.
 * Unknown positional arguments are returned as `_`.
 */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) flags[token.slice(2)] = true;
        else {
          flags[token.slice(2)] = next;
          i += 1;
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

/** Every non-internal IPv4 address this machine answers on. */
function lanAddresses() {
  const out = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      // 169.254/16 is the self-assigned address a machine gives itself when
      // DHCP failed; it is reachable by nobody else, so listing it as a LAN
      // address would be actively misleading.
      if (entry.address.startsWith('169.254.')) continue;
      out.push({ name, address: entry.address });
    }
  }
  return out;
}

async function cmdLogin() {
  const env = detectEnv();
  console.log(`Trae CN 环境: ideVersion=${env.ideVersion} versionCode=${env.appVersionCode} (${env.source})`);
  console.log('即将在浏览器中打开 Trae 授权页，请在页面上登录你自己的账号。\n');
  const creds = await webLogin({
    ideVersion: env.ideVersion,
    onAuthorizeUrl: (url) => {
      console.log(`授权链接：\n${url}\n`);
      if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    },
  });
  const file = saveCredentials(creds);
  console.log(`\n登录成功 ✓`);
  console.log(`  userId: ${creds.userId}`);
  if (creds.username) console.log(`  username: ${creds.username}`);
  console.log(`  凭据已写入 ${file} (0600)`);

  const models = await new TraeProvider({ env, credentials: creds }).models();
  console.log(`  可用模型 ${models.length} 个，例如: ${models.slice(0, 5).map((m) => m.configName).join(', ')}`);
}

async function cmdModels() {
  const provider = new TraeProvider({ credentials: requireCredentials() });
  const models = await provider.models({ force: true });
  console.log(`共 ${models.length} 个模型（来源: ${provider.env.source}）\n`);
  console.log('config_name'.padEnd(28) + 'display'.padEnd(26) + 'ctx'.padEnd(10) + '思考');
  for (const m of models) {
    const ctx = (m.maxMode ? m.maxContextWindow : m.contextWindow) || 0;
    console.log(
      m.configName.padEnd(28) +
        String(m.name).slice(0, 24).padEnd(26) +
        String(ctx || '-').padEnd(10) +
        (m.supportThinking ? (m.effortOptions.join('/') || 'yes') : '-'),
    );
  }
}

/** Where the gateway config lives by default (next to the database). */
export const DEFAULT_CONFIG = path.join(CRED_DIR, 'gateway.json');

/**
 * Read a JSON config file, if present.
 *
 * The point of this indirection is that a one-click npm script cannot carry a
 * `--admin-password`: `package.json` is committed, and an operator's admin
 * password in a tracked file is a credential leak waiting for a `git push`.
 * Flags still win over the file, so `npm run gateway -- --port 9000` works.
 * @param {string} file
 * @returns {object}
 */
function readConfig(file, { required = false } = {}) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('配置必须是 JSON 对象');
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') {
      // An *explicit* `--config` must exist: silently falling back to
      // single-user mode because of a typo would start a different service
      // than the one asked for. The default path may be absent, which is how
      // a plain `serve` keeps its historical loopback behaviour.
      if (required) {
        throw new Error(
          `配置文件不存在: ${file}\n  先运行: npm run gateway:init -- --admin-password '你的口令'`,
        );
      }
      return {};
    }
    if (err instanceof SyntaxError) throw new Error(`配置不是合法 JSON (${file}): ${err.message}`);
    throw new Error(`读取配置失败 (${file}): ${err.message}`);
  }
}

async function cmdServe() {
  const { flags } = parseArgs(process.argv.slice(3));
  const explicitConfig = typeof flags.config === 'string';
  const configFile = explicitConfig ? path.resolve(flags.config) : DEFAULT_CONFIG;
  const config = readConfig(configFile, { required: explicitConfig });

  const port = Number(flags.port ?? process.env.PORT ?? config.port ?? 8317);
  const host = String(flags.host ?? process.env.HOST ?? config.host ?? '127.0.0.1');
  const apiKey = flags['api-key'] ?? process.env.API_KEY ?? config.apiKey ?? null;
  const adminPassword = flags['admin-password'] ?? process.env.ADMIN_PASSWORD ?? config.adminPassword ?? null;
  // Which model an omitted / `auto` request resolves to. The upstream's own
  // ordering puts Doubao first, so without this a gateway handed to colleagues
  // silently answers with a model nobody asked for.
  const defaultModel = flags['default-model'] ?? process.env.DEFAULT_MODEL ?? config.defaultModel ?? null;

  // Gateway mode is opt-in: `--db` (with or without a path) turns on the key
  // table, the daily caps and the usage ledger. Without it `serve` behaves
  // exactly as before — one optional `--api-key`, no database — so an existing
  // single-user setup keeps working after an upgrade.
  const gateway = Boolean(flags.db || flags.gateway || config.db);
  let store = null;
  if (gateway) {
    const dbFlag = typeof flags.db === 'string' ? flags.db : typeof config.db === 'string' ? config.db : null;
    const file = dbFlag ? path.resolve(dbFlag) : DEFAULT_DB;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      store = openStore(file);
    } catch (err) {
      console.error(`无法打开数据库 ${file}: ${err.message}`);
      if (err.message === SQLITE_HELP) console.error(SQLITE_HELP);
      process.exit(1);
    }
  }

  // A non-loopback bind with no credential is an open relay spending your own
  // quota. Refuse rather than warn: a warning on stderr is exactly the message
  // that scrolls past in a terminal someone is not watching.
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (!loopback && !store && !apiKey) {
    console.error(
      `拒绝启动：--host ${host} 会把端点暴露到局域网，但没有 --api-key 也没有 --db。\n` +
        '  请二选一：加 --db（推荐，按人发 key 并记账）或加 --api-key（单一共享口令）。',
    );
    process.exit(1);
  }
  if (!loopback && store && !adminPassword) {
    console.error(
      '拒绝启动：网关模式下绑定非回环地址时必须设置 --admin-password。\n' +
        '  否则任何拿到 key 的人都能打开 /admin 改自己的额度、看所有人的用量。',
    );
    store.close();
    process.exit(1);
  }

  const provider = new TraeProvider({ credentials: requireCredentials(), defaultModel });
  // The admin header wants the account balance, which is a networked call. It
  // is cached for five minutes and refreshed in the background: an operator
  // opening the page must never wait on the dashboard endpoint, and a balance a
  // few minutes stale is still the right number to reconcile against.
  let quotaCache = { at: 0, value: null, inFlight: false };
  const quotaReader = () => {
    if (!quotaCache.inFlight && Date.now() - quotaCache.at > 5 * 60 * 1000) {
      quotaCache = { ...quotaCache, inFlight: true };
      fetchQuota(loadCredentials() ?? {})
        .then((snapshot) => {
          quotaCache = { at: Date.now(), value: snapshot, inFlight: false };
          store?.recordQuota({ ...snapshot, source: 'web_user_ent_usage' });
        })
        .catch(() => {
          quotaCache = { ...quotaCache, at: Date.now(), inFlight: false };
        });
    }
    return quotaCache.value;
  };

  const adminHandler = store
    ? createAdminHandler({ store, password: adminPassword, quota: quotaReader })
    : null;

  const { server, url } = await startServer(provider, { port, host, apiKey, store, adminHandler });
  const actualPort = server.address()?.port ?? port;
  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  console.log(`Trae CN → OpenAI 兼容服务已启动`);
  console.log(`  本机入口:   http://${shownHost}:${actualPort}/v1`);
  if (!loopback) {
    const addresses = lanAddresses();
    if (addresses.length) {
      console.log('  局域网入口（分发给同事）:');
      for (const entry of addresses) console.log(`              http://${entry.address}:${actualPort}/v1   (${entry.name})`);
      console.log('              静态 IP 更稳：DHCP 续约后地址可能变，记得在路由器里做绑定。');
    } else {
      console.log('  局域网入口: (未检测到非回环 IPv4 地址)');
    }
  }
  if (store) {
    const keys = store.listKeys();
    console.log(`  鉴权:       按人发 key（已登记 ${keys.length} 把：${keys.map((k) => k.label).join(', ') || '尚未创建'}）`);
    console.log(`  数据库:     ${store.file}`);
    console.log(`  管理页:     http://${shownHost}:${actualPort}/admin${adminPassword ? '（需管理口令）' : '（仅本机可访问）'}`);
    if (!keys.length) console.log('  下一步:     node src/cli.js keys add alice');
  } else {
    console.log(`  API Key : ${apiKey || '(未设置，仅监听 127.0.0.1)'}`);
  }
  if (defaultModel) console.log(`  默认模型:   ${defaultModel}（请求不传 model 时使用）`);
  console.log(`  模型目录: http://${shownHost}:${actualPort}/v1/models`);
  try {
    const models = await provider.models();
    console.log(`  已加载 ${models.length} 个模型`);
  } catch (err) {
    console.error(`  模型目录预拉取失败: ${err.message}`);
  }

  const shutdown = () => {
    console.log('\n已停止');
    try {
      server.close();
      store?.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdChat() {
  const prompt = process.argv.slice(3).join(' ');
  if (!prompt) {
    console.error('用法: node src/cli.js chat <提示词>');
    process.exit(1);
  }
  const provider = new TraeProvider({ credentials: requireCredentials() });
  await provider.ensureFresh();
  await provider.models();
  const caps = provider.resolveModel('auto');
  const body = {
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    function: caps.function || 'chat_v3',
    stream: true,
    config_name: caps.configName,
    model: caps.modelName || caps.configName,
    model_name: caps.modelName || caps.configName,
    config_source: caps.configSource ?? 1,
    is_custom_model: false,
    provider: caps.provider || '',
    // Enterprise gateways bill a seat per chat session; without it the call is
    // scored against the consumer credit ledger and answers 4008.
    session_id: crypto.randomUUID(),
  };
  const result = await chat({
    creds: provider.creds,
    env: provider.env,
    body,
    onEvent: (event) => {
      if (event.type === 'text') process.stdout.write(event.text);
      else if (event.type === 'reason') process.stderr.write(event.text);
    },
  });
  process.stdout.write('\n');
  if (result.usage) console.error(`\n[usage] ${JSON.stringify(result.usage)}`);
}

async function cmdUsage() {
  const creds = requireCredentials();
  const snapshot = await fetchQuota(creds);
  console.log(formatQuota(snapshot, { ...tenantOf(creds.token), username: creds.username || '' }));
}

/**
 * Resolve the gateway database path from a `--db` flag, then the config file,
 * then the default. `keys` and `report` share this so an operator who points
 * `serve` at a custom database does not silently manage a different one.
 * @param {object} flags - parsed CLI flags.
 */
function resolveDb(flags) {
  if (typeof flags.db === 'string') return path.resolve(flags.db);
  const configFile = typeof flags.config === 'string' ? path.resolve(flags.config) : DEFAULT_CONFIG;
  try {
    const config = readConfig(configFile);
    if (typeof config.db === 'string' && config.db) return path.resolve(config.db);
  } catch {
    /* an unreadable config is reported by `serve`; here the default is fine */
  }
  return DEFAULT_DB;
}

/** `keys add|list|rm|enable|disable|limit` — the operator's key management. */
async function cmdKeys() {
  const { flags, positional } = parseArgs(process.argv.slice(3));
  const action = positional[0] || 'list';
  const file = resolveDb(flags);
  let store;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    store = openStore(file);
  } catch (err) {
    console.error(`无法打开数据库 ${file}: ${err.message}`);
    console.error(`  可加 --db <path> 指定别的位置，或先 npm run gateway:init 写好配置。`);
    process.exit(1);
  }

  try {
    if (action === 'add') {
      const label = positional[1] || flags.label;
      if (!label) {
        console.error('用法: node src/cli.js keys add <label> [--note 备注] [--limit 200000]');
        process.exit(1);
      }
      const plaintext = `sk-${keyStem(label)}-${crypto.randomBytes(16).toString('hex')}`;
      const limit = flags.limit === undefined ? null : Number(flags.limit);
      if (flags.limit !== undefined && !Number.isFinite(limit)) {
        console.error('--limit 必须是数字（tokens/天），或省略表示不限');
        process.exit(1);
      }
      const created = store.addKey({ key: plaintext, label, note: flags.note ?? null, limitTokensPerDay: limit });
      console.log(`已创建 ${created.label}（${created.masked}）`);
      console.log('');
      console.log(`  ${plaintext}`);
      console.log('');
      console.log('数据库保存了明文，随时可用 `keys show <label>` 或管理页 /admin 再看。');
      console.log('需要作废请 keys rm 或 keys disable。');
      return;
    }

    if (action === 'show') {
      const needle = positional[1];
      if (!needle) {
        // No argument means "every key", which is what the admin page shows.
        const all = store.listKeys();
        if (!all.length) {
          console.log('还没有 key。用 node src/cli.js keys add <label> 创建。');
          return;
        }
        for (const key of all) {
          console.log(`${key.label.padEnd(14)}${key.key ?? '(旧 key，无明文) ' + key.masked}`);
        }
        return;
      }
      const key = findKey(store, needle);
      if (!key) {
        console.error(`找不到 ${needle}`);
        process.exit(1);
      }
      console.log(`${key.label}: ${key.key ?? '(旧 key，无明文，只能显示 ' + key.masked + ')'}`);
      return;
    }

    if (action === 'list' || action === undefined) {
      const keys = store.listKeys();
      if (!keys.length) {
        console.log('还没有 key。用 node src/cli.js keys add <label> 创建。');
        return;
      }
      const rows = keys.map((key) => {
        const used = store.tokensToday(key.id);
        const state = !key.enabled ? '已停用' : key.limitTokensPerDay !== null && used.tokens >= key.limitTokensPerDay ? '已触顶' : '启用';
        const limit = key.limitTokensPerDay === null ? '不限' : String(key.limitTokensPerDay);
        return { label: key.label, masked: key.masked, state, today: `${used.tokens}/${limit}`, note: key.note ?? '', id: key.id };
      });
      const widths = { label: 10, masked: 24, state: 6, today: 18 };
      console.log(
        'label'.padEnd(widths.label) +
          'key'.padEnd(widths.masked) +
          '状态'.padEnd(widths.state) +
          '今日 tokens/上限'.padEnd(widths.today) +
          '备注',
      );
      for (const row of rows) {
        console.log(
          row.label.padEnd(widths.label) +
            row.masked.padEnd(widths.masked) +
            row.state.padEnd(widths.state) +
            row.today.padEnd(widths.today) +
            row.note,
        );
      }
      console.log('');
      console.log(`数据库: ${file}`);
      return;
    }

    if (action === 'rm' || action === 'remove' || action === 'delete') {
      const label = positional[1];
      if (!label) {
        console.error('用法: node src/cli.js keys rm <label|key-id>');
        process.exit(1);
      }
      const key = findKey(store, label);
      if (!key) {
        console.error(`找不到 ${label}`);
        process.exit(1);
      }
      store.removeKey(key.id);
      console.log(`已删除 ${key.label}（${key.masked}）。历史用量仍保留在报告里。`);
      return;
    }

    if (action === 'enable' || action === 'disable') {
      const label = positional[1];
      if (!label) {
        console.error(`用法: node src/cli.js keys ${action} <label>`);
        process.exit(1);
      }
      const key = findKey(store, label);
      if (!key) {
        console.error(`找不到 ${label}`);
        process.exit(1);
      }
      store.setEnabled(key.id, action === 'enable');
      console.log(`${key.label}: ${action === 'enable' ? '已启用' : '已停用（立即生效，无需重启）'}`);
      return;
    }

    if (action === 'limit') {
      const label = positional[1];
      const raw = positional[2];
      if (!label || raw === undefined) {
        console.error('用法: node src/cli.js keys limit <label> <tokens/天|none>');
        process.exit(1);
      }
      const key = findKey(store, label);
      if (!key) {
        console.error(`找不到 ${label}`);
        process.exit(1);
      }
      const value = raw === 'none' || raw === '0' ? null : Number(raw);
      if (value !== null && !Number.isFinite(value)) {
        console.error('上限必须是数字，或 none 表示不限');
        process.exit(1);
      }
      store.setLimit(key.id, value);
      console.log(`${key.label}: 日上限 ${value === null ? '不限额' : value}`);
      return;
    }

    console.error(`未知子命令: ${action}（可用: add / list / rm / enable / disable / limit）`);
    process.exit(1);
  } finally {
    store.close();
  }
}

/** Resolve a key by label or by a prefix of its id/hash. */
function findKey(store, needle) {
  const key = store.listKeys().find((row) => row.label === needle || row.masked === needle || row.id === needle);
  if (key) return key;
  if (/^[0-9a-f]{6,}$/i.test(needle)) return store.listKeys().find((row) => row.id.startsWith(needle.toLowerCase())) ?? null;
  return null;
}

/** `report` (alias `usage-report`) — per-person totals over a window. */
async function cmdReport() {
  const { flags } = parseArgs(process.argv.slice(3));
  const days = Math.max(1, Math.min(90, Number(flags.days ?? 1) || 1));
  const file = resolveDb(flags);
  let store;
  try {
    store = openStore(file);
  } catch (err) {
    console.error(`无法打开数据库 ${file}: ${err.message}`);
    console.error(`  可加 --db <path> 指定别的位置，或先 npm run gateway:init 写好配置。`);
    process.exit(1);
  }

  try {
    // Local midnight, N-1 days back: `--days 7` means "today plus the six
    // preceding calendar days", which is what an operator expects.
    const until = startOfToday() + 86400;
    const since = startOfToday() - (days - 1) * 86400;
    const rows = store.report({ since, until });
    const label = days === 1 ? '今日' : `近 ${days} 天`;
    console.log(`${label}用量（${store.file}）\n`);

    if (!rows.length) {
      console.log('  没有记录。可能是：还没开始用、数据库路径不对，或所有请求都被拦在最前面。');
      return;
    }

    const grand = rows.reduce(
      (acc, row) => ({
        requests: acc.requests + row.requests,
        tokens: acc.tokens + row.totalTokens,
        aborted: acc.aborted + row.abortedRequests,
        errors: acc.errors + row.upstreamErrors,
        denied: acc.denied + row.quotaDenied + row.unauthorized + row.disabledDenied,
      }),
      { requests: 0, tokens: 0, aborted: 0, errors: 0, denied: 0 },
    );

    const pad = (value, width) => String(value).padEnd(width);
    const padLeft = (value, width) => String(value).padStart(width);
    console.log(`${pad('caller', 14)}${padLeft('请求', 8)}${padLeft('tokens', 12)}${padLeft('占比', 8)}${padLeft('中断', 8)}${padLeft('上游错误', 10)}${padLeft('被拒', 8)}`);
    for (const row of rows) {
      const share = grand.tokens > 0 ? `${Math.round((row.totalTokens / grand.tokens) * 100)}%` : '—';
      console.log(
        pad(row.label, 14) +
          padLeft(row.requests, 8) +
          padLeft(row.totalTokens, 12) +
          padLeft(share, 8) +
          padLeft(row.abortedRequests, 8) +
          padLeft(row.upstreamErrors, 10) +
          padLeft(row.quotaDenied + row.unauthorized + row.disabledDenied, 8),
      );
    }
    console.log(
      pad('合计', 14) +
        padLeft(grand.requests, 8) +
        padLeft(grand.tokens, 12) +
        padLeft('100%', 8) +
        padLeft(grand.aborted, 8) +
        padLeft(grand.errors, 10) +
        padLeft(grand.denied, 8),
    );

    const byModel = store.byModel({ since, until });
    if (byModel.length) {
      console.log('\n按模型:');
      for (const row of byModel.slice(0, 8)) {
        console.log(`  ${pad(row.model, 30)}${padLeft(row.requests, 6)} 次${padLeft(row.totalTokens, 12)} tokens`);
      }
    }

    const latest = store.latestQuota();
    if (latest) {
      console.log(
        `\n上游余额快照（${new Date(latest.ts * 1000).toLocaleString()}）：` +
          `已用 ${latest.consumed} / 总量 ${latest.total}，剩余 ${latest.remaining}` +
          `${latest.billing_mode ? `（${latest.billing_mode}）` : ''}`,
      );
      console.log('  这是账号级读数，不是本次窗口的增量：只用来判断本地记账有没有漏记。');
    }

    if (grand.aborted > 0) {
      console.log(`\n提示: 有 ${grand.aborted} 次请求在完成前被客户端断开。这些已计入 tokens（若上游已回传），`);
      console.log('      说明有调用方在中途取消 —— 常见于 IDE 里点了停止，或客户端超时。');
    }
    if (grand.denied > 0) {
      console.log(`\n提示: 有 ${grand.denied} 次请求被拒（401/403/429）。429 表示某人当日额度已触顶。`);
    }
  } finally {
    store.close();
  }
}

/**
 * `init` — write the gateway config file that the one-click npm scripts read.
 *
 * Deliberately interactive about the admin password: generating one and
 * printing it is how the current running instance was set up, but a password
 * that only ever appeared in a terminal scrollback is easily lost. Here the
 * operator sets it, and the file is written 0600.
 */
async function cmdInit() {
  const { flags } = parseArgs(process.argv.slice(3));
  const configFile = typeof flags.config === 'string' ? path.resolve(flags.config) : DEFAULT_CONFIG;
  const host = String(flags.host ?? '0.0.0.0');
  const port = Number(flags.port ?? 8317);
  const dbFlag = typeof flags.db === 'string' ? flags.db : path.join(CRED_DIR, 'gateway.db');
  const adminPassword = typeof flags['admin-password'] === 'string' ? flags['admin-password'] : null;

  if (fs.existsSync(configFile) && !flags.force) {
    console.error(`${configFile} 已存在。要覆盖请加 --force。`);
    console.error('当前配置：');
    console.error(JSON.stringify(readConfig(configFile), null, 2));
    process.exit(1);
  }

  // Secrets never go to stdout: only whether one was set.
  if (!adminPassword) {
    console.error(
      '需要 --admin-password <口令>：这个文件会被 npm 脚本读取，口令必须由你指定，不能自动生成。\n' +
        '  例：node src/cli.js init --admin-password \'你的口令\'',
    );
    process.exit(1);
  }

  const config = { host, port, db: path.resolve(dbFlag), adminPassword };
  if (typeof flags['default-model'] === 'string') config.defaultModel = flags['default-model'];
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  const temp = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, configFile);
  fs.chmodSync(configFile, 0o600);

  console.log(`已写入 ${configFile}（0600，含口令，不要提交）`);
  console.log(`  host: ${config.host}`);
  console.log(`  port: ${config.port}`);
  console.log(`  db  : ${config.db}`);
  console.log('  adminPassword: (已设置)');
  console.log('');
  console.log('下一步: npm run gateway');
}

/** `stop` — find and terminate the gateway process holding the configured port. */
async function cmdStop() {
  const { flags } = parseArgs(process.argv.slice(3));
  const configFile = typeof flags.config === 'string' ? path.resolve(flags.config) : DEFAULT_CONFIG;
  const config = readConfig(configFile);
  const port = Number(flags.port ?? config.port ?? 8317);
  const { execFileSync } = await import('node:child_process');
  let pids = [];
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    pids = out.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    console.log(`端口 ${port} 上没有监听进程。`);
    return;
  }
  if (!pids.length) {
    console.log(`端口 ${port} 上没有监听进程。`);
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGTERM');
      console.log(`已停止 pid ${pid}（端口 ${port}）`);
    } catch (err) {
      console.error(`停止 pid ${pid} 失败: ${err.message}`);
    }
  }
}

const commands = {
  login: cmdLogin,
  models: cmdModels,
  serve: cmdServe,
  chat: cmdChat,
  usage: cmdUsage,
  keys: cmdKeys,
  report: cmdReport,
  'usage-report': cmdReport,
  init: cmdInit,
  stop: cmdStop,
};

const command = process.argv[2];
if (!commands[command]) {
  console.log('用法: node src/cli.js <login|models|init|serve|stop|chat|usage|keys|report>');
  console.log('');
  console.log('  login                  浏览器登录 Trae 账号');
  console.log('  models                 列出可用模型');
  console.log('  init [--admin-password <pw>] [--host 0.0.0.0] [--port 8317] [--default-model <id>]');
  console.log('                         生成 npm run gateway 用的配置（0600）');
  console.log('  serve [--host 0.0.0.0] [--db] [--admin-password <pw>] [--default-model <id>] [--config <file>]');
  console.log('                         启动 OpenAI 兼容服务；--db 开启多 key + 记账');
  console.log(`                         配置默认读 ${DEFAULT_CONFIG}（npm run gateway 用）`);
  console.log('  stop                   停止占用配置端口的网关进程');
  console.log('  keys add <label> [--limit N]   创建一把 key（只显示一次）');
  console.log('  keys list              查看 key 与今日用量');
  console.log('  keys show [label]      查看完整 key（管理员）');
  console.log('  keys rm|enable|disable <label>');
  console.log('  keys limit <label> <N|none>');
  console.log('  report [--days 7]      按人汇总用量');
  process.exit(command ? 1 : 0);
}
commands[command]().catch((err) => {
  console.error(`失败: ${err.message}`);
  process.exit(1);
});
