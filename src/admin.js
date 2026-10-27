// admin.js - the operator-facing console for the gateway.
//
// One HTML page and a small JSON API, both served by the same process as the
// OpenAI surface. Deliberately dependency-free: the page is assembled from
// template strings and the browser's own `fetch`, so `node src/cli.js serve`
// stays the only thing an operator has to run. Introducing a front-end build
// step here would turn a one-command deployment into two.
//
// Authorisation is separate from the `/v1` keys on purpose. An API key holder
// must never be able to reach this page: they could raise their own daily cap,
// read everyone else's usage, or mint themselves a new key. `adminPassword`
// gates the whole `/admin` prefix with HTTP Basic auth; with no password set the
// page is only bound to loopback (the CLI refuses a non-loopback bind without
// it, see `serveCommand`).
import crypto from 'node:crypto';
import { STATUS, startOfToday } from './store.js';

const REALM = 'trae-cn gateway admin';

/** Constant-time string compare, so a wrong password leaks no timing signal. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) {
    // Still hash both sides before returning, to keep the branch's timing flat.
    crypto.timingSafeEqual(crypto.createHash('sha256').update(left).digest(), crypto.createHash('sha256').update(right).digest());
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    // No third-party script is ever loaded, and the page has no inline event
    // handlers, so a strict policy costs nothing and blocks injected markup.
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: { message } });
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** Milliseconds → a short human duration. */
function humanMs(ms) {
  if (ms === null || ms === undefined) return '—';
  const value = Number(ms);
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value / 60000)}min`;
}

/** Epoch seconds → `YYYY-MM-DD HH:mm` in local time. */
function humanTime(seconds) {
  if (!seconds) return '—';
  const date = new Date(Number(seconds) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Compact token count: `1.2M`, `18.4k`, `512`. */
function humanTokens(count) {
  const value = Number(count) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

/**
 * The admin surface.
 *
 * @param {object} options
 * @param {import('./store.js').GatewayStore} options.store
 * @param {() => object|null} options.quota - latest balance reading, for reconciliation.
 * @param {string|null} [options.password] - Basic-auth password; null disables auth (loopback only).
 * @param {() => object[]} [options.keysSnapshot] - extra operational detail for the header.
 * @returns {(req: any, res: any) => Promise<boolean>} handler; resolves true when it owned the request.
 */
export function createAdminHandler({ store, quota = () => null, password = null } = {}) {
  const authorised = (req) => {
    if (!password) return true;
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) return false;
    let decoded = '';
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      return false;
    }
    // `user:pass`; the username carries no meaning, but curl and browsers both
    // require one to be present.
    const colon = decoded.indexOf(':');
    const presented = colon < 0 ? decoded : decoded.slice(colon + 1);
    return safeEqual(presented, password);
  };

  return async function handleAdmin(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path !== '/admin' && !path.startsWith('/admin/')) return false;

    // A browser sends `Origin` on cross-site POSTs; the OpenAI surface refuses
    // those outright. The admin page is same-origin, so anything carrying an
    // Origin that does not match its own Host is a cross-site attempt.
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    if (origin) {
      const host = req.headers.host || '';
      const expected = [`http://${host}`, `https://${host}`];
      if (!expected.includes(origin)) {
        sendError(res, 403, '拒绝跨站请求');
        return true;
      }
    }

    if (!authorised(req)) {
      res.writeHead(401, { 'WWW-Authenticate': `Basic realm="${REALM}"`, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('需要管理口令');
      return true;
    }

    if (req.method === 'GET' && path === '/admin') {
      sendHtml(res, renderPage({ store, quota, password }));
      return true;
    }

    if (req.method === 'GET' && path === '/admin/api/overview') {
      const days = Number(url.searchParams.get('days') || 1);
      const since = days > 1 ? startOfToday() - (days - 1) * 86400 : startOfToday();
      sendJson(res, 200, {
        window: { days, since },
        keys: store.listKeys(),
        report: store.report({ since }),
        byModel: store.byModel({ since }),
        quota: quota() ?? store.latestQuota(),
      });
      return true;
    }

    if (req.method === 'GET' && path === '/admin/api/requests') {
      const limit = Number(url.searchParams.get('limit') || 100);
      const label = url.searchParams.get('label');
      sendJson(res, 200, { requests: store.recent({ limit: Math.min(500, limit), label }) });
      return true;
    }

    if (req.method === 'POST' && path === '/admin/api/keys') {
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error), true;
      const label = String(body.label || '').trim();
      if (!label) return sendError(res, 400, 'label 必填'), true;
      // The key is generated here, not accepted from the client: an operator
      // pasting a weak string would silently weaken every downstream call.
      const plaintext = `sk-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${crypto.randomBytes(16).toString('hex')}`;
      try {
        const created = store.addKey({
          key: plaintext,
          label,
          note: body.note ?? null,
          limitTokensPerDay:
            body.limitTokensPerDay === undefined || body.limitTokensPerDay === null || body.limitTokensPerDay === ''
              ? null
              : Number(body.limitTokensPerDay),
        });
        // Returned exactly once, never readable again: only its hash is stored.
        sendJson(res, 201, { ...created, key: plaintext });
      } catch (err) {
        sendError(res, 400, err.message);
      }
      return true;
    }

    const keyAction = path.match(/^\/admin\/api\/keys\/([0-9a-f]{64})\/(toggle|limit)$/);
    if (req.method === 'POST' && keyAction) {
      const [, id, action] = keyAction;
      if (!store.getKey(id)) return sendError(res, 404, 'key 不存在'), true;
      const body = await readJsonBody(req).catch(() => ({}));
      if (action === 'toggle') {
        const enabled = body.enabled === undefined ? !store.getKey(id).enabled : Boolean(body.enabled);
        store.setEnabled(id, enabled);
        sendJson(res, 200, { id, enabled });
        return true;
      }
      const raw = body.limitTokensPerDay;
      store.setLimit(id, raw === null || raw === undefined || raw === '' ? null : Number(raw));
      sendJson(res, 200, { id, limitTokensPerDay: store.getKey(id).limitTokensPerDay });
      return true;
    }

    if (req.method === 'DELETE' && /^\/admin\/api\/keys\/[0-9a-f]{64}$/.test(path)) {
      const id = path.slice('/admin/api/keys/'.length);
      const removed = store.removeKey(id);
      return removed ? (sendJson(res, 200, { removed: true }), true) : (sendError(res, 404, 'key 不存在'), true);
    }

    sendError(res, 404, `未知路径: ${path}`);
    return true;
  };
}

/**
 * Render the whole page.
 *
 * Server-rendered on purpose: the first paint contains the real numbers, so an
 * operator opening the page while `serve` is busy still sees today's usage
 * without waiting on a fetch round-trip.
 */
function renderPage({ store, quota, password = null }) {
  const keys = store.listKeys();
  const today = store.report();
  const byModel = store.byModel();
  const balance = quota() ?? store.latestQuota();
  const totals = today.reduce(
    (acc, row) => ({
      requests: acc.requests + row.requests,
      tokens: acc.tokens + row.totalTokens,
      aborted: acc.aborted + row.abortedRequests,
      errors: acc.errors + row.upstreamErrors,
      denied: acc.denied + row.quotaDenied + row.unauthorized + row.disabledDenied,
    }),
    { requests: 0, tokens: 0, aborted: 0, errors: 0, denied: 0 },
  );
  const usageById = new Map(today.map((row) => [row.label, row]));

  const keyRows = keys
    .map((key) => {
      const used = usageById.get(key.label) ?? {};
      const spent = Number(used.totalTokens ?? 0);
      const limit = key.limitTokensPerDay;
      const pct = limit ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
      const state = !key.enabled ? 'off' : limit !== null && spent >= limit ? 'capped' : 'on';
      return `<tr data-key="${escapeHtml(key.id)}">
        <td><strong>${escapeHtml(key.label)}</strong><div class="sub">${escapeHtml(key.masked)}${key.note ? ` · ${escapeHtml(key.note)}` : ''}</div></td>
        <td><span class="pill ${state}">${state === 'on' ? '启用' : state === 'off' ? '已停用' : '已触顶'}</span></td>
        <td class="num">${humanTokens(spent)}${limit !== null ? `<div class="sub">上限 ${humanTokens(limit)} · ${pct}%</div>` : '<div class="sub">不限额</div>'}</td>
        <td class="num">${Number(used.requests ?? 0)}</td>
        <td class="num">${Number(used.abortedRequests ?? 0) + Number(used.upstreamErrors ?? 0)}</td>
        <td class="num">${key.lastSeen ? humanTime(key.lastSeen) : '—'}</td>
        <td class="actions">
          <button data-act="toggle" data-enabled="${key.enabled ? '0' : '1'}">${key.enabled ? '停用' : '启用'}</button>
          <button data-act="limit">改上限</button>
          <button data-act="delete" class="danger">删除</button>
        </td>
      </tr>`;
    })
    .join('');

  const modelRows = byModel
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.model)}</td><td class="num">${row.requests}</td><td class="num">${humanTokens(row.totalTokens)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>trae-cn 网关 · 管理</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; font: 14px/1.5 -apple-system, "PingFang SC", Segoe UI, sans-serif; background: #f8fafc; color: #0f172a; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 10px; }
  .muted { color: #64748b; }
  .sub { color: #64748b; font-size: 12px; font-weight: 400; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 18px; min-width: 130px; }
  .card .v { font-size: 22px; font-weight: 700; }
  .card .k { font-size: 12px; color: #64748b; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  th { font-size: 12px; font-weight: 600; color: #475569; background: #f8fafc; }
  tr:last-child td { border-bottom: 0; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .pill.on { background: #dcfce7; color: #166534; }
  .pill.off { background: #e2e8f0; color: #475569; }
  .pill.capped { background: #fee2e2; color: #991b1b; }
  button { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid #cbd5e1; background: #fff; cursor: pointer; }
  button:hover { background: #f1f5f9; }
  button.danger { color: #b91c1c; border-color: #fca5a5; }
  form.inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #475569; }
  input { font: inherit; padding: 6px 9px; border: 1px solid #cbd5e1; border-radius: 6px; width: 170px; }
  #out { margin-top: 12px; white-space: pre-wrap; font-family: ui-monospace, Menlo, monospace; font-size: 12px; background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; display: none; }
  .warn { margin-top: 16px; padding: 10px 14px; border-radius: 8px; background: #fffbeb; border: 1px solid #fcd34d; color: #78350f; }
  .empty { padding: 18px; text-align: center; color: #94a3b8; background: #fff; border: 1px dashed #e2e8f0; border-radius: 10px; }
</style>
</head>
<body>
<h1>trae-cn 网关</h1>
<div class="muted">账号：单账号（本机登录态） · 数据：本地 SQLite · 统计窗口：今日（${humanTime(startOfToday())} 起）</div>

<div class="cards">
  <div class="card"><div class="v">${totals.requests}</div><div class="k">今日请求</div></div>
  <div class="card"><div class="v">${humanTokens(totals.tokens)}</div><div class="k">今日 tokens</div></div>
  <div class="card"><div class="v">${keys.filter((k) => k.enabled).length}/${keys.length}</div><div class="k">启用 / 全部 key</div></div>
  <div class="card"><div class="v">${totals.aborted}</div><div class="k">中断（已记账）</div></div>
  <div class="card"><div class="v">${totals.denied}</div><div class="k">被拒（401/403/429）</div></div>
  ${balance ? `<div class="card"><div class="v">${balance.remaining}</div><div class="k">上游余额${balance.billing_mode ? ` · ${escapeHtml(balance.billing_mode)}` : ''}</div></div>` : ''}
</div>

${passwordlessWarning(password)}

<h2>创建 key</h2>
<form class="inline" id="create">
  <label>label（报告分组名）<input name="label" placeholder="alice" required></label>
  <label>备注<input name="note" placeholder="设计部"></label>
  <label>日上限 tokens（留空=不限）<input name="limit" type="number" min="0" placeholder="200000"></label>
  <button type="submit">生成</button>
</form>
<div class="muted" style="margin-top:6px">完整 key 只显示一次；数据库里只保存它的 SHA-256 哈希。</div>

<h2>Key 与今日用量</h2>
${
  keys.length
    ? `<table>
<thead><tr><th>label</th><th>状态</th><th class="num">今日 tokens</th><th class="num">请求</th><th class="num">异常</th><th>最近调用</th><th>操作</th></tr></thead>
<tbody>${keyRows}</tbody></table>`
    : '<div class="empty">还没有 key。先在上方创建一把，再发给同事。</div>'
}

<h2>按模型</h2>
${
  byModel.length
    ? `<table><thead><tr><th>模型</th><th class="num">请求</th><th class="num">tokens</th></tr></thead><tbody>${modelRows}</tbody></table>`
    : '<div class="empty">今日还没有调用。</div>'
}

<h2>最近请求</h2>
<div id="recent" class="empty">加载中…</div>

<div id="out"></div>

<script>
const out = document.getElementById('out');
const show = (text) => { out.style.display = 'block'; out.textContent = text; };

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || ('HTTP ' + res.status));
  return data;
}

document.getElementById('create').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const limit = String(form.get('limit') || '').trim();
  try {
    const created = await api('POST', '/admin/api/keys', {
      label: form.get('label'), note: form.get('note'),
      limitTokensPerDay: limit === '' ? null : Number(limit),
    });
    show('新 key（只显示这一次，请立刻复制给使用者）：\\n\\n' + created.key);
    event.target.reset();
  } catch (err) { show('创建失败：' + err.message); }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const id = button.closest('tr').dataset.key;
  try {
    if (button.dataset.act === 'toggle') {
      await api('POST', '/admin/api/keys/' + id + '/toggle', { enabled: button.dataset.enabled === '1' });
      location.reload();
    } else if (button.dataset.act === 'limit') {
      const raw = prompt('每日 token 上限（留空表示不限额）：', '200000');
      if (raw === null) return;
      await api('POST', '/admin/api/keys/' + id + '/limit', { limitTokensPerDay: raw.trim() === '' ? null : Number(raw) });
      location.reload();
    } else if (button.dataset.act === 'delete') {
      if (!confirm('删除后该 key 立即失效，历史用量仍保留在报告里。继续？')) return;
      await api('DELETE', '/admin/api/keys/' + id);
      location.reload();
    }
  } catch (err) { show('操作失败：' + err.message); }
});

fetch('/admin/api/requests?limit=30').then((res) => res.json()).then(({ requests }) => {
  const host = document.getElementById('recent');
  if (!requests.length) { host.className = 'empty'; host.textContent = '暂无请求记录'; return; }
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const ms = (value) => value === null || value === undefined || !Number.isFinite(Number(value)) ? '—'
    : Number(value) < 1000 ? Math.round(Number(value)) + 'ms' : (Number(value) / 1000).toFixed(1) + 's';
  const rows = requests.map((row) =>
    '<tr><td>' + esc(row.key_label) + '</td><td>' + esc(row.model || '—') +
    '</td><td class="num">' + (row.total_tokens || 0) + '</td><td>' + esc(row.status) +
    '</td><td class="num">' + ms(row.ms) + '</td><td class="sub">' + new Date(row.ts * 1000).toLocaleTimeString() + '</td></tr>'
  ).join('');
  host.className = '';
  host.innerHTML = '<table><thead><tr><th>caller</th><th>模型</th><th class="num">tokens</th><th>状态</th><th class="num">耗时</th><th>时间</th></tr></thead><tbody>' + rows + '</tbody></table>';
}).catch(() => {
  const host = document.getElementById('recent');
  host.className = 'empty'; host.textContent = '无法加载请求记录';
});
</script>
</body>
</html>`;
}

/** Say so plainly when the page is reachable without a password. */
function passwordlessWarning(password = null) {
  if (password) return '';
  return `<div class="warn">未设置管理口令（<code>serve --admin-password</code>）。本页仅应从本机访问；
任何人连上它就等于能改额度、看所有人的用量。</div>`;
}

export { escapeHtml, humanMs, humanTime, humanTokens, startOfToday };
