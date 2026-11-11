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
import { STATUS, startOfToday, keyStem } from './store.js';

const REALM = 'trae-cn gateway admin';

/**
 * The label printed in the page header. Deliberately static: the LAN address a
 * colleague must use is discovered per-request from the `Host` header (see
 * {@link onboardingText}), because the same page is opened from `127.0.0.1` by
 * the operator and from the LAN IP by everyone else, and each must be told the
 * address that actually works for them.
 */
const GATEWAY_LABEL = 'OpenAI 兼容端点';

/** Human text for the three key states rendered as a pill. */
const STATE_TEXT = { on: '启用', off: '已停用', capped: '已触顶' };

/**
 * What an operator pastes into a chat message when handing a key over.
 *
 * The key alone is useless without the base URL, and the base URL differs by
 * viewer: `127.0.0.1` for the operator, the LAN address for a colleague. The
 * `host` of the *current request* is therefore the best guess — it is by
 * definition an address that reached this gateway.
 * @param {string} apiKey - the plaintext key.
 * @param {string} [hostHeader] - the `Host` header of the serving request.
 */
function onboardingText(apiKey, hostHeader = '') {
  const host = String(hostHeader || '').trim() || '127.0.0.1:8317';
  return [
    `Base URL: http://${host}/v1`,
    `API Key:  ${apiKey}`,
    '模型:     DeepSeek-V4.1-Flash-1017（或从 /v1/models 选择）',
    '注意:     必须用 http://，不是 https://',
  ].join('\n');
}

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

/** `YYYY-MM-DD` → epoch seconds at local midnight, or null when unparseable. */
function parseDayStart(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d), 0, 0, 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  // Reject impossible dates: `new Date(2026, 1, 31)` silently rolls into March.
  if (date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) return null;
  return Math.floor(date.getTime() / 1000);
}

/** Local `YYYY-MM-DD` for an epoch-seconds instant. */
function localDay(seconds) {
  const date = new Date(Number(seconds) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Resolve the reporting window from the query string.
 *
 * Two shapes are accepted, because the UI has two controls and both must end up
 * at the same query:
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD  — an explicit range from the date picker
 *   ?days=N                          — a preset ("today", "last 7 days")
 *
 * `to` is inclusive in the URL but exclusive in the query (`until` is the next
 * midnight), which is what makes "from=to=today" mean exactly today.
 * @param {URL} url
 * @returns {{ days: number, from: string, to: string, range: { since: number, until: number } }}
 */
function resolveWindow(url) {
  const endOfToday = startOfToday() + 86400;
  const explicitFrom = parseDayStart(url.searchParams.get('from'));
  const explicitTo = parseDayStart(url.searchParams.get('to'));

  let since;
  let until;
  if (explicitFrom !== null) {
    since = explicitFrom;
    // A `to` before `from` is a UI slip, not a reason to return nothing:
    // clamp it so the page still shows the requested start day.
    until = explicitTo !== null && explicitTo >= explicitFrom ? explicitTo + 86400 : explicitFrom + 86400;
  } else {
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') || 1) || 1));
    since = startOfToday() - (days - 1) * 86400;
    until = endOfToday;
  }

  // The window is capped at 365 days for the same reason `report --days` is:
  // a hand-edited URL must not turn one page load into a full-table scan.
  const maxSpan = 365 * 86400;
  if (until - since > maxSpan) since = until - maxSpan;

  const days = Math.max(1, Math.round((until - since) / 86400));
  return { days, from: localDay(since), to: localDay(until - 1), range: { since, until } };
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
      sendHtml(res, renderPage({ store, quota, password, hostHeader: String(req.headers.host || '') }));
      return true;
    }

    if (req.method === 'GET' && path === '/admin/api/overview') {
      const window = resolveWindow(url);
      const { since, until } = window.range;
      const keys = store.listKeys();
      const report = store.report({ since, until });
      const byModel = store.byModel({ since, until });
      sendJson(res, 200, {
        window,
        keys,
        report,
        byModel,
        daily: store.daily({ since, until }),
        quota: quota() ?? store.latestQuota(),
        // Pre-rendered panels, so the browser never re-implements the table
        // markup (and never silently forgets a column when one is added). The
        // copy payload depends on the viewer's `Host`, which only the server
        // sees, so this cannot be built client-side at all.
        html: {
          keys: renderKeysPanel({ keys, report, hostHeader: String(req.headers.host || '') }),
          models: renderModelsPanel(byModel),
        },
      });
      return true;
    }

    if (req.method === 'GET' && path === '/admin/api/requests') {
      const limit = Number(url.searchParams.get('limit') || 100);
      const label = url.searchParams.get('label');
      const { since, until } = resolveWindow(url).range;
      sendJson(res, 200, { requests: store.recent({ limit: Math.min(500, limit), label, since, until }) });
      return true;
    }

    if (req.method === 'POST' && path === '/admin/api/keys') {
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error), true;
      const label = String(body.label || '').trim();
      if (!label) return sendError(res, 400, 'label 必填'), true;
      // The key is generated here, not accepted from the client: an operator
      // pasting a weak string would silently weaken every downstream call.
      const plaintext = `sk-${keyStem(label)}-${crypto.randomBytes(16).toString('hex')}`;
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

/** Roll the per-key report rows up into the five header cards. */
function sumTotals(report) {
  return report.reduce(
    (acc, row) => ({
      requests: acc.requests + row.requests,
      tokens: acc.tokens + row.totalTokens,
      aborted: acc.aborted + row.abortedRequests,
      errors: acc.errors + row.upstreamErrors,
      denied: acc.denied + row.quotaDenied + row.unauthorized + row.disabledDenied,
    }),
    { requests: 0, tokens: 0, aborted: 0, errors: 0, denied: 0 },
  );
}

/**
 * Inner HTML of the "Key 与用量" panel for one window.
 *
 * Extracted from {@link renderPage} because the page needs it twice: once at
 * first paint (server-rendered, so the numbers are real before any fetch) and
 * again on every range change. The browser cannot re-derive it — the usage
 * numbers come from the report, not from the key rows — so it is served over
 * `/admin/api/overview` as ready-made markup. Rendering it in one place is what
 * keeps the two paths from drifting apart; a second implementation in the page
 * script is exactly how the table kept showing today's numbers for a week-long
 * range.
 *
 * @param {{ keys: object[], report: object[], hostHeader?: string }} input
 */
function renderKeysPanel({ keys, report, hostHeader = '' }) {
  if (!keys.length) return '<div class="empty">还没有 key。先在上方创建一把，再发给同事。</div>';
  const usageById = new Map(report.map((row) => [row.label, row]));
  const rows = keys
    .map((key) => {
      const used = usageById.get(key.label) ?? {};
      const spent = Number(used.totalTokens ?? 0);
      const limit = key.limitTokensPerDay;
      const pct = limit ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
      const state = !key.enabled ? 'off' : limit !== null && spent >= limit ? 'capped' : 'on';
      // Older rows predate the `secret` column, so they can only be shown masked.
      // Say so instead of rendering an empty cell that looks like a bug.
      const keyCell = key.key
        ? `<code class="key">${escapeHtml(key.key)}</code>`
        : `<span class="muted">${escapeHtml(key.masked)}（旧 key，无明文）</span>`;
      // The copy button carries the whole onboarding payload — base URL *and*
      // key — because that is what an operator actually pastes into a chat
      // message. Copying the key alone makes the recipient ask "which URL?".
      const bundle = key.key ? onboardingText(key.key, hostHeader) : '';
      return `<tr data-key="${escapeHtml(key.id)}" data-label="${escapeHtml(key.label)}">
        <td>
          <div class="who">${escapeHtml(key.label)}</div>
          ${key.note ? `<div class="sub">${escapeHtml(key.note)}</div>` : ''}
        </td>
        <td class="keycell">
          ${keyCell}
          ${
            key.key
              ? `<button class="icon" data-copy="${escapeHtml(bundle)}" title="复制网关地址 + key">复制</button>`
              : ''
          }
        </td>
        <td><span class="pill ${state}">${STATE_TEXT[state]}</span></td>
        <td class="num">
          <div>${humanTokens(spent)}</div>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <div class="sub">${limit !== null ? `${humanTokens(limit)} · ${pct}%` : '不限额'}</div>
        </td>
        <td class="num">${Number(used.requests ?? 0)}</td>
        <td class="num">${Number(used.abortedRequests ?? 0) + Number(used.upstreamErrors ?? 0)}</td>
        <td class="sub">${key.lastSeen ? humanTime(key.lastSeen) : '—'}</td>
        <td class="actions">
          <button data-act="toggle" data-enabled="${key.enabled ? '0' : '1'}">${key.enabled ? '停用' : '启用'}</button>
          <button data-act="limit">上限</button>
          <button data-act="delete" class="danger">删除</button>
        </td>
      </tr>`;
    })
    .join('');
  return `<table>
<thead><tr>
  <th>label</th><th>key（点击复制：地址 + key）</th><th>状态</th>
  <th class="num">tokens</th><th class="num">请求</th><th class="num">异常</th><th>最近调用</th><th>操作</th>
</tr></thead>
<tbody>${rows}</tbody></table>`;
}

/** Inner HTML of the "按模型" panel; same two call sites as {@link renderKeysPanel}. */
function renderModelsPanel(byModel) {
  if (!byModel.length) return '<div class="empty">该时间范围内没有调用。</div>';
  const rows = byModel
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.model)}</td><td class="num">${row.requests}</td><td class="num">${humanTokens(row.totalTokens)}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>模型</th><th class="num">请求</th><th class="num">tokens</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * Render the whole page.
 *
 * Server-rendered on purpose: the first paint contains the real numbers, so an
 * operator opening the page while `serve` is busy still sees today's usage
 * without waiting on a fetch round-trip.
 */
function renderPage({ store, quota, password = null, hostHeader = '' }) {
  const keys = store.listKeys();
  const today = store.report();
  const byModel = store.byModel();
  const balance = quota() ?? store.latestQuota();
  const totals = sumTotals(today);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>trae-cn 网关 · 管理</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f4f6fb;
    --panel: #ffffff;
    --line: #e4e9f2;
    --line-soft: #eef2f8;
    --ink: #101a2e;
    --ink-2: #47536b;
    --ink-3: #8794ab;
    --accent: #3b5bfd;
    --accent-soft: #eaefff;
    --ok: #0f8a5f;   --ok-bg: #e4f7ee;
    --warn: #a96100; --warn-bg: #fff3dd;
    --bad: #b3242b;  --bad-bg: #fdeaea;
    --radius: 14px;
    --shadow: 0 1px 2px rgba(16, 26, 46, .06), 0 6px 20px rgba(16, 26, 46, .05);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 34px 30px 60px;
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
    background: radial-gradient(1100px 420px at 12% -8%, #e9eeff 0%, transparent 62%), var(--bg);
    color: var(--ink); -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1240px; margin: 0 auto; }

  header.top { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; margin-bottom: 22px; }
  h1 { font-size: 22px; margin: 0 0 5px; letter-spacing: -.015em; }
  .meta { color: var(--ink-3); font-size: 12.5px; }
  .meta code { background: var(--line-soft); padding: 1px 5px; border-radius: 5px; }

  h2 { font-size: 13px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-3); margin: 30px 0 11px; }

  /* ---- stat cards ---- */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 12px; }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 15px 17px; box-shadow: var(--shadow); }
  .stat .v { font-size: 25px; font-weight: 680; letter-spacing: -.02em; font-variant-numeric: tabular-nums; line-height: 1.2; }
  .stat .k { font-size: 11.5px; color: var(--ink-3); margin-top: 3px; }
  .stat.bad .v { color: var(--bad); }

  /* ---- toolbar / date range ---- */
  .toolbar {
    display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 11px 13px; box-shadow: var(--shadow);
  }
  .toolbar .label { font-size: 12px; color: var(--ink-3); margin-right: 2px; }
  .seg { display: inline-flex; background: var(--line-soft); border-radius: 9px; padding: 2.5px; gap: 2px; }
  .seg button {
    font-size: 12.5px; padding: 5px 11px; border: 0; border-radius: 7px;
    background: transparent; color: var(--ink-2); cursor: pointer; font-weight: 500;
  }
  .seg button:hover { background: #e6ecf8; }
  .seg button[aria-pressed="true"] { background: var(--panel); color: var(--accent); font-weight: 650; box-shadow: 0 1px 3px rgba(16,26,46,.12); }
  .range { display: inline-flex; align-items: center; gap: 6px; }
  input[type="date"] {
    font: inherit; font-size: 12.5px; padding: 5px 8px; color: var(--ink);
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px; cursor: pointer;
  }
  input[type="date"]:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .sep { color: var(--ink-3); font-size: 12px; }
  .ghost { font: inherit; font-size: 12.5px; padding: 5px 11px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink-2); cursor: pointer; }
  .ghost:hover { background: #f7f9fe; border-color: #cfd8e8; }
  .spacer { flex: 1; }

  /* ---- tables ---- */
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: 11px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase;
    color: var(--ink-3); background: #fafbfe; padding: 10px 14px; border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
  td { padding: 12px 14px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: #fafcff; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .who { font-weight: 600; }
  .sub { color: var(--ink-3); font-size: 11.5px; }
  .muted { color: var(--ink-3); }
  td.keycell { min-width: 300px; }
  code.key {
    display: inline-block; max-width: 100%; overflow-wrap: anywhere;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
    background: var(--line-soft); color: #26324a; padding: 3px 7px; border-radius: 6px;
    user-select: all; cursor: text;
  }
  .bar { height: 3px; border-radius: 2px; background: var(--line-soft); margin: 5px 0 3px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); border-radius: 2px; }

  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 650; white-space: nowrap; }
  .pill.on { background: var(--ok-bg); color: var(--ok); }
  .pill.off { background: #eaeef6; color: var(--ink-2); }
  .pill.capped { background: var(--bad-bg); color: var(--bad); }

  button { font: inherit; }
  td.actions { white-space: nowrap; }
  td.actions button, button.icon {
    font-size: 12px; padding: 4px 9px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--panel); color: var(--ink-2); cursor: pointer;
    margin-left: 4px;
  }
  td.actions button:hover, button.icon:hover { background: #f2f6fd; border-color: #ccd7e9; color: var(--ink); }
  td.actions button.danger { color: var(--bad); border-color: #f2c9cb; }
  td.actions button.danger:hover { background: var(--bad-bg); }

  /* ---- create form ---- */
  form.create { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  label.f { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; color: var(--ink-3); }
  input[type="text"], input[type="number"] {
    font: inherit; font-size: 13px; padding: 7px 10px; width: 178px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--ink);
  }
  input[type="text"]:focus, input[type="number"]:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
  button.primary {
    font: inherit; font-size: 13px; font-weight: 600; padding: 8px 18px; border-radius: 9px;
    border: 1px solid #2f49d4; background: var(--accent); color: #fff; cursor: pointer;
  }
  button.primary:hover { background: #2f49d4; }
  .hint { margin-top: 9px; font-size: 11.5px; color: var(--ink-3); }

  /* ---- misc ---- */
  #out {
    display: none; margin-top: 14px; padding: 13px 15px; border-radius: 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    background: #131b2d; color: #dfe6f5; white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .warn { margin-top: 18px; padding: 11px 15px; border-radius: 10px; background: var(--warn-bg); border: 1px solid #f0d6a8; color: var(--warn); font-size: 12.5px; }
  .empty { padding: 26px; text-align: center; color: var(--ink-3); font-size: 13px; }
  .empty.panel { border-style: dashed; background: transparent; box-shadow: none; }
  tr.flash { animation: flash 2.6s ease-out; }
  @keyframes flash { 0%, 45% { background: #dbe7ff; } 100% { background: transparent; } }
  .toast {
    position: fixed; left: 50%; bottom: 26px; transform: translate(-50%, 14px);
    background: #131b2d; color: #fff; font-size: 12.5px; padding: 9px 17px; border-radius: 999px;
    box-shadow: 0 8px 26px rgba(16,26,46,.28); opacity: 0; pointer-events: none;
    transition: opacity .18s ease, transform .18s ease;
  }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
  @media (max-width: 760px) {
    body { padding: 20px 14px 44px; }
    td.keycell { min-width: 0; }
    .stats { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<div class="wrap">

  <header class="top">
    <div>
      <h1>trae-cn 网关</h1>
      <div class="meta">
        单账号（本机登录态） · 本地 SQLite · <code>${escapeHtml(GATEWAY_LABEL)}</code>
      </div>
    </div>
    <div class="toolbar" style="box-shadow:none;background:transparent;border:0;padding:0">
      <button class="ghost" id="copy-all-keys">复制全部 key</button>
    </div>
  </header>

  <div class="stats">
    <div class="stat"><div class="v" data-stat="requests">${totals.requests}</div><div class="k">请求（所选区间）</div></div>
    <div class="stat"><div class="v" data-stat="tokens">${humanTokens(totals.tokens)}</div><div class="k">tokens（所选区间）</div></div>
    <div class="stat"><div class="v">${keys.filter((k) => k.enabled).length}/${keys.length}</div><div class="k">启用 / 全部 key</div></div>
    <div class="stat"><div class="v" data-stat="aborted">${totals.aborted}</div><div class="k">中断（已记账）</div></div>
    <div class="stat ${totals.denied > 0 ? 'bad' : ''}" data-stat-card="denied"><div class="v" data-stat="denied">${totals.denied}</div><div class="k">被拒（401/403/429）</div></div>
    ${balance ? `<div class="stat"><div class="v" data-stat="balance">${balance.remaining}</div><div class="k">上游余额${balance.billing_mode ? ` · ${escapeHtml(balance.billing_mode)}` : ''}</div></div>` : ''}
  </div>

  ${passwordlessWarning(password)}

  <h2>时间范围</h2>
  <div class="toolbar">
    <span class="label">快捷</span>
    <div class="seg" id="presets">
      <button data-days="1" aria-pressed="true">今日</button>
      <button data-days="7">近 7 天</button>
      <button data-days="30">近 30 天</button>
    </div>
    <span class="sep">或</span>
    <div class="range">
      <input type="date" id="from" aria-label="开始日期">
      <span class="sep">→</span>
      <input type="date" id="to" aria-label="结束日期">
      <button class="ghost" id="apply-range">应用</button>
    </div>
    <div class="spacer"></div>
    <span class="sub" id="range-label"></span>
  </div>

  <h2>创建 key</h2>
  <div class="panel" style="padding:16px">
    <form class="create" id="create">
      <label class="f">label（报告分组名）<input name="label" type="text" placeholder="alice" required></label>
      <label class="f">备注<input name="note" type="text" placeholder="设计部"></label>
      <label class="f">日上限 tokens（留空=不限）<input name="limit" type="number" min="0" placeholder="200000"></label>
      <button class="primary" type="submit">生成</button>
    </form>
    <div class="hint">创建后会立即出现在下表并可一键复制；鉴权走 SHA-256，明文只用于本页展示。</div>
  </div>

  <h2>Key 与用量</h2>
  <div class="panel" id="keys-panel">
    ${renderKeysPanel({ keys, report: today, hostHeader })}
  </div>

  <h2>按模型</h2>
  <div class="panel" id="models-panel">
    ${renderModelsPanel(byModel)}
  </div>

  <h2>最近请求</h2>
  <div class="panel">
    <div id="recent" class="empty">加载中…</div>
  </div>

  <div id="out"></div>
</div>
<div class="toast" id="toast"></div>

<script>
// ---- helpers ---------------------------------------------------------------
const out = document.getElementById('out');
const toastEl = document.getElementById('toast');
const show = (text) => { out.style.display = 'block'; out.textContent = text; };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ms = (v) => v === null || v === undefined || !Number.isFinite(Number(v)) ? '—'
  : Number(v) < 1000 ? Math.round(Number(v)) + 'ms' : (Number(v) / 1000).toFixed(1) + 's';

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1900);
}

/**
 * Copy text, with a visible fallback.
 *
 * \`navigator.clipboard\` only exists in a secure context and this page is a plain
 * HTTP LAN address, so the primary path frequently throws. When it does, show
 * the payload in a selectable prompt instead of failing silently — the operator
 * needs the value either way.
 */
async function copyText(value, okMessage) {
  try {
    await navigator.clipboard.writeText(value);
    toast(okMessage);
    return true;
  } catch {
    prompt('浏览器不允许自动复制，请手动复制：', value);
    return false;
  }
}

// ---- api -------------------------------------------------------------------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data && data.error ? data.error.message : 'HTTP ' + res.status);
  return data;
}

// ---- create ----------------------------------------------------------------
document.getElementById('create').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const limit = String(form.get('limit') || '').trim();
  try {
    const created = await api('POST', '/admin/api/keys', {
      label: form.get('label'), note: form.get('note'),
      limitTokensPerDay: limit === '' ? null : Number(limit),
    });
    const copied = await copyText(created.key, '已复制 ' + created.label + ' 的 key');
    show('已创建 ' + created.label + '：' + created.key + '\\n' +
      (copied ? '已复制到剪贴板。' : '请手动复制上面的 key。') + '\\n页面即将刷新…');
    event.target.reset();
    setTimeout(() => {
      // Carry the window across the reload. Replacing the hash outright would
      // drop a range the operator had picked, silently snapping the page back to
      // "today" right after they created a key.
      location.hash = hashOf({ w: currentQuery(), created: created.label });
      location.reload();
    }, 550);
  } catch (err) { show('创建失败：' + err.message); }
});

// ---- clipboard / row actions ----------------------------------------------
document.addEventListener('click', async (event) => {
  // One button, one payload: base URL + key + model, ready to paste into chat.
  const copyButton = event.target.closest('button[data-copy]');
  if (copyButton) {
    await copyText(copyButton.dataset.copy, '已复制网关地址 + key');
    return;
  }

  const allKeys = event.target.closest('#copy-all-keys');
  if (allKeys) {
    const rows = [...document.querySelectorAll('tbody tr[data-key]')]
      .map((tr) => {
        const label = tr.dataset.label || '';
        const key = tr.querySelector('code.key');
        return key ? label + '\\t' + key.textContent : null;
      })
      .filter(Boolean);
    if (!rows.length) return toast('没有可复制的 key');
    await copyText(rows.join('\\n'), '已复制 ' + rows.length + ' 把 key');
    return;
  }

  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const id = button.closest('tr').dataset.key;
  // Every one of these ends in a reload; keep the window the operator is looking
  // at instead of snapping back to the server-rendered default of "today".
  const reload = () => {
    location.hash = hashOf({ w: currentQuery() });
    location.reload();
  };
  try {
    if (button.dataset.act === 'toggle') {
      await api('POST', '/admin/api/keys/' + id + '/toggle', { enabled: button.dataset.enabled === '1' });
      reload();
    } else if (button.dataset.act === 'limit') {
      const raw = prompt('每日 token 上限（留空表示不限额）：', '200000');
      if (raw === null) return;
      await api('POST', '/admin/api/keys/' + id + '/limit', { limitTokensPerDay: raw.trim() === '' ? null : Number(raw) });
      reload();
    } else if (button.dataset.act === 'delete') {
      if (!confirm('删除后该 key 立即失效，历史用量仍保留在报告里。继续？')) return;
      await api('DELETE', '/admin/api/keys/' + id);
      reload();
    }
  } catch (err) { show('操作失败：' + err.message); }
});

// ---- date range ------------------------------------------------------------
const fromEl = document.getElementById('from');
const toEl = document.getElementById('to');
const rangeLabel = document.getElementById('range-label');

const isoDay = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
};
const today = new Date();
const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };

fromEl.value = isoDay(today);
toEl.value = isoDay(today);
fromEl.max = isoDay(today);
toEl.max = isoDay(today);

function setPressed(days) {
  for (const b of document.querySelectorAll('#presets button')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days));
  }
}

/** Reload the window in place, without a full page navigation. */
async function loadRange(query) {
  try {
    const data = await api('GET', '/admin/api/overview?' + query);
    const w = data.window;
    fromEl.value = w.from;
    toEl.value = w.to;
    rangeLabel.textContent = w.from === w.to ? w.from : w.from + ' ~ ' + w.to;

    // Everything below the date picker is scoped to the window, so every one of
    // them has to be repainted — not just the two headline cards. The key and
    // model tables are server-rendered markup, replaced wholesale.
    const totals = data.report.reduce((acc, row) => ({
      requests: acc.requests + row.requests,
      tokens: acc.tokens + row.totalTokens,
      aborted: acc.aborted + row.abortedRequests,
      denied: acc.denied + row.quotaDenied + row.unauthorized + row.disabledDenied,
    }), { requests: 0, tokens: 0, aborted: 0, denied: 0 });

    setStat('requests', totals.requests);
    setStat('tokens', fmtTokens(totals.tokens));
    setStat('aborted', totals.aborted);
    setStat('denied', totals.denied);
    document.querySelector('[data-stat-card="denied"]').classList.toggle('bad', totals.denied > 0);

    document.getElementById('keys-panel').innerHTML = data.html.keys;
    document.getElementById('models-panel').innerHTML = data.html.models;

    // Keep the balance card in step too: \`notify_usage\` snapshots arrive during
    // requests, so a stale figure here is the one number an operator would act on.
    if (data.quota) setStat('balance', String(data.quota.remaining ?? '—'));

    // Encoded as one value: a raw \`from=…&to=…\` would be split on \`&\` when read
    // back, silently dropping \`to\` and collapsing the range to its first day.
    location.hash = hashOf({ w: query });
    current = query;
    await loadRequests(query);
  } catch (err) { show('加载失败：' + err.message); }
}

function setStat(name, value) {
  const el = document.querySelector('[data-stat="' + name + '"]');
  if (el) el.textContent = value;
}

/** Same compact form the server uses for \`humanTokens\`. */
function fmtTokens(value) {
  const n = Number(value) || 0;
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
}

// The window currently on screen, so a reload can carry it along instead of
// falling back to the server-rendered default of "today".
let current = 'days=1';
const currentQuery = () => current;

/** \`{ w: 'from=…&to=…', created: 'alice' }\` → a hash both boot paths understand. */
function hashOf({ w, created }) {
  const parts = [];
  if (w) parts.push('w=' + encodeURIComponent(w));
  if (created) parts.push('created=' + encodeURIComponent(created));
  return parts.join('&');
}

/** Pull one \`key=value\` out of the hash, whatever order the parts are in. */
function hashPart(hash, name) {
  const match = new RegExp('(?:^#?|&)' + name + '=([^&]*)').exec(hash);
  return match ? decodeURIComponent(match[1]) : null;
}

for (const b of document.querySelectorAll('#presets button')) {
  b.addEventListener('click', () => {
    setPressed(Number(b.dataset.days));
    loadRange('days=' + b.dataset.days);
  });
}

document.getElementById('apply-range').addEventListener('click', () => {
  if (!fromEl.value || !toEl.value) return toast('请选择开始和结束日期');
  if (fromEl.value > toEl.value) return toast('开始日期不能晚于结束日期');
  setPressed(0);
  loadRange('from=' + fromEl.value + '&to=' + toEl.value);
});

// ---- recent requests -------------------------------------------------------
async function loadRequests(query) {
  const host = document.getElementById('recent');
  try {
    const data = await api('GET', '/admin/api/requests?limit=30' + (query ? '&' + query : ''));
    const requests = data.requests;
    if (!requests.length) { host.className = 'empty'; host.textContent = '该时间范围内暂无请求'; return; }
    host.className = '';
    host.innerHTML = '<table><thead><tr><th>caller</th><th>模型</th><th class="num">tokens</th><th>状态</th><th class="num">耗时</th><th>时间</th></tr></thead><tbody>'
      + requests.map((row) =>
          '<tr><td class="who">' + esc(row.key_label) + '</td><td>' + esc(row.model || '—')
          + '</td><td class="num">' + (row.total_tokens || 0) + '</td><td>' + esc(row.status)
          + '</td><td class="num">' + ms(row.ms) + '</td><td class="sub">'
          + new Date(row.ts * 1000).toLocaleString() + '</td></tr>').join('')
      + '</tbody></table>';
  } catch {
    host.className = 'empty';
    host.textContent = '无法加载请求记录';
  }
}

// Initial paint: honour a window carried in the hash after a reload, then flash
// a freshly created row. Both live in one boot path because the key table is
// repainted from the overview response — flashing before that resolves would
// mark a row that is about to be replaced.
(async function boot() {
  const carried = hashPart(location.hash, 'w');
  const created = hashPart(location.hash, 'created');
  const query = carried || 'days=1';

  const days = /days=(\\d+)/.exec(query);
  if (days) setPressed(Number(days[1]));
  if (!carried) rangeLabel.textContent = isoDay(today);

  await loadRange(query);
  if (created) highlightRow(created);

  // Drop the \`created\` marker once consumed, but keep the window: a manual
  // refresh must land on the same range, and a leftover \`#created=\` would flash
  // the same row on every reload. \`loadRange\` has already written \`#w=…\`, so in
  // the common case this rewrite changes nothing.
  history.replaceState(null, '', location.pathname + '#w=' + encodeURIComponent(query));
})();

function highlightRow(label) {
  for (const row of document.querySelectorAll('tbody tr[data-key]')) {
    if (row.dataset.label === label) {
      row.classList.add('flash');
      row.scrollIntoView({ block: 'center' });
      setTimeout(() => row.classList.remove('flash'), 2800);
      break;
    }
  }
}
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
