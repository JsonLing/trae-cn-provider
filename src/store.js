// store.js - the gateway's persistent state: API keys, usage rows, quota snapshots.
//
// Three tables, one file, no daemon:
//
//   keys            who may call, whether they may still call, and their daily cap
//   usage           one row per request — success, upstream failure, or abort
//   quota_snapshots the upstream credit balance, kept only for reconciliation
//
// Design notes that are load-bearing:
//
//  * Keys are stored as SHA-256 hashes, never plaintext. An API key here is 128
//    bits of randomness, so a salted KDF buys nothing: there is no dictionary
//    to brute-force. The hash means a leaked `gateway.db` cannot be replayed
//    against the gateway, and the admin page can only ever show a masked form
//    (`sk-alice-8f3a…961f`). The full value is printed exactly once, at creation.
//  * `usage.key_label` is denormalised on purpose. Deleting a key must not
//    erase who spent what, or the monthly report silently loses a row.
//  * Every request writes a row, including aborts. A client that disconnects
//    mid-stream still consumed upstream tokens; omitting it makes the heaviest
//    user invisible in the report — exactly the person you need to find.
//  * `quota_snapshots` is not a billing ledger. The upstream reports a balance,
//    not a per-request delta, so it can only be used to spot a drift between
//    local token accounting and the account's own consumption.
import crypto from 'node:crypto';

/** Request outcomes recorded in `usage.status`. */
export const STATUS = {
  ok: 'ok', // stream or non-stream finished normally
  upstreamError: 'upstream_error', // 4008 / 4xx / 5xx from Trae
  aborted: 'aborted', // the client hung up (or DSH cancelled)
  deniedUnauthorized: 'denied_401', // bad or missing key
  deniedDisabled: 'denied_disabled', // key exists but enabled = 0
  deniedQuota: 'denied_429', // daily token cap reached
};

/** How long a failed `node:sqlite` import is allowed to explain itself. */
const SQLITE_HELP =
  'gateway 需要 Node 内置的 node:sqlite（Node ≥ 23.4，或 Node 22.x 加 --experimental-sqlite）。' +
  '插件本身（DSH 内使用）不依赖它。';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

/** Hash an API key for storage. Deterministic, so lookup is a plain index hit. */
export function hashKey(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext), 'utf8').digest('hex');
}

/**
 * Render a key for display: enough to tell two keys apart, not enough to use.
 * @param {string} prefix - leading characters (usually the `sk-<name>-` stem).
 * @param {string} last4
 */
export function maskKey(prefix, last4) {
  return `${prefix || 'sk-'}…${last4 || '????'}`;
}

/** Start of the local calendar day, in epoch seconds. Daily caps use local time. */
export function startOfToday(now = Date.now()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  id                    TEXT PRIMARY KEY,   -- sha256(plaintext key)
  label                 TEXT NOT NULL,      -- human name shown in reports
  note                  TEXT,               -- free-form, e.g. team or purpose
  prefix                TEXT NOT NULL,      -- for the masked display only
  last4                 TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1,
  limit_tokens_per_day  INTEGER,            -- NULL = unlimited
  created_at            INTEGER NOT NULL,
  last_seen             INTEGER
);
CREATE INDEX IF NOT EXISTS idx_keys_label ON keys(label);

CREATE TABLE IF NOT EXISTS usage (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 INTEGER NOT NULL,
  key_id             TEXT NOT NULL,         -- hash, or '' when the key was unknown
  key_label          TEXT NOT NULL,         -- denormalised: survives key deletion
  model              TEXT,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL,
  error              TEXT,                   -- short, never contains a token
  ms                 INTEGER,
  session_id         TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts      ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_key_ts  ON usage(key_id, ts);

CREATE TABLE IF NOT EXISTS quota_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  total        INTEGER NOT NULL DEFAULT 0,
  consumed     INTEGER NOT NULL DEFAULT 0,
  remaining    INTEGER NOT NULL DEFAULT 0,
  billing_mode TEXT,
  source       TEXT
);
CREATE INDEX IF NOT EXISTS idx_quota_ts ON quota_snapshots(ts);
`;

/**
 * The gateway store.
 *
 * One synchronous connection per process. SQLite serialises writers itself, so
 * this needs no mutex of its own: a WAL database with a busy timeout handles
 * concurrent `serve` + `usage-report` processes (`SELECT` never blocks a write).
 */
export class GatewayStore {
  /**
   * @param {string} file - database path, or ':memory:' for tests.
   */
  constructor(file) {
    if (!DatabaseSync) throw new Error(SQLITE_HELP);
    this.file = file;
    this.db = new DatabaseSync(file);
    // WAL: a reader (the admin page, a CLI report) never blocks the request
    // path's single writer. `busy_timeout` covers the brief checkpoint window.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.#prepare();
  }

  #statements = null;

  /** Statement handles, built once. `node:sqlite` does not cache them. */
  #prepare() {
    const db = this.db;
    this.#statements = {
      selectKey: db.prepare('SELECT * FROM keys WHERE id = ?'),
      insertKey: db.prepare(
        `INSERT INTO keys (id, label, note, prefix, last4, enabled, limit_tokens_per_day, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      deleteKey: db.prepare('DELETE FROM keys WHERE id = ?'),
      listKeys: db.prepare('SELECT * FROM keys ORDER BY created_at DESC'),
      setEnabled: db.prepare('UPDATE keys SET enabled = ? WHERE id = ?'),
      setLimit: db.prepare('UPDATE keys SET limit_tokens_per_day = ? WHERE id = ?'),
      touchKey: db.prepare('UPDATE keys SET last_seen = ? WHERE id = ?'),
      insertUsage: db.prepare(
        `INSERT INTO usage (ts, key_id, key_label, model, prompt_tokens, completion_tokens,
                            total_tokens, status, error, ms, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      // Requests that never reached the upstream (`denied_*`) carry no tokens,
      // but counting them as "requests" would make a locked-out user look busy.
      sumToday: db.prepare(
        `SELECT COALESCE(SUM(total_tokens), 0) AS tokens, COUNT(*) AS requests
           FROM usage WHERE key_id = ? AND ts >= ? AND status NOT LIKE 'denied%'`,
      ),
      insertQuota: db.prepare(
        'INSERT INTO quota_snapshots (ts, total, consumed, remaining, billing_mode, source) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      latestQuota: db.prepare('SELECT * FROM quota_snapshots ORDER BY ts DESC, id DESC LIMIT 1'),
    };
  }

  /** Release the connection. Safe to call twice. */
  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  /**
   * Register one API key. The plaintext is hashed before it touches the file.
   * @param {{ key: string, label: string, note?: string, limitTokensPerDay?: number|null, enabled?: boolean }} input
   * @returns {{ id: string, label: string, masked: string }}
   */
  addKey({ key, label, note = null, limitTokensPerDay = null, enabled = true }) {
    const plaintext = String(key || '').trim();
    if (!plaintext) throw new Error('key 不能为空');
    const name = String(label || '').trim();
    if (!name) throw new Error('label 不能为空（报告里要按它分组）');
    const id = hashKey(plaintext);
    if (this.#statements.selectKey.get(id)) throw new Error(`label「${name}」或该 key 已存在`);
    // `sk-alice-8f3a…` — keep the stem so two keys for one person stay legible.
    const dash = plaintext.lastIndexOf('-');
    const prefix = dash > 0 && dash < plaintext.length - 4 ? plaintext.slice(0, dash + 1) : 'sk-';
    this.#statements.insertKey.run(
      id,
      name,
      note === null || note === undefined || note === '' ? null : String(note),
      prefix,
      plaintext.slice(-4),
      enabled ? 1 : 0,
      limitTokensPerDay === null || limitTokensPerDay === undefined ? null : Math.max(0, Number(limitTokensPerDay)),
      nowSeconds(),
    );
    return { id, label: name, masked: maskKey(prefix, plaintext.slice(-4)) };
  }

  /** @returns {object[]} every key, newest first. */
  listKeys() {
    return this.#statements.listKeys.all().map(publicKey);
  }

  /** @param {string} id */
  getKey(id) {
    const row = this.#statements.selectKey.get(id);
    return row ? publicKey(row) : null;
  }

  /** @param {string} id */
  removeKey(id) {
    return this.#statements.deleteKey.run(id).changes > 0;
  }

  /** @param {string} id @param {boolean} enabled */
  setEnabled(id, enabled) {
    return this.#statements.setEnabled.run(enabled ? 1 : 0, id).changes > 0;
  }

  /** @param {string} id @param {number|null} tokensPerDay */
  setLimit(id, tokensPerDay) {
    const value = tokensPerDay === null || tokensPerDay === undefined ? null : Math.max(0, Number(tokensPerDay));
    return this.#statements.setLimit.run(value, id).changes > 0;
  }

  /**
   * Resolve a presented key.
   *
   * The hash is computed unconditionally — including for a wrong key — so the
   * comparison has the same cost either way. Returns a discriminated result
   * rather than a bare row so the caller can distinguish "unknown" from
   * "known but disabled" in both the 401 message and the audit row.
   * @param {string} plaintext
   * @returns {{ ok: true, key: object } | { ok: false, reason: 'unknown'|'disabled', key: object|null }}
   */
  authenticate(plaintext) {
    if (!plaintext) return { ok: false, reason: 'unknown', key: null };
    const id = hashKey(plaintext);
    const row = this.#statements.selectKey.get(id);
    if (!row) return { ok: false, reason: 'unknown', key: null };
    const key = publicKey(row);
    if (!key.enabled) return { ok: false, reason: 'disabled', key };
    // `last_seen` is updated at most once a minute. A model-list poll can hit
    // this path every few seconds, and an unconditional UPDATE would turn each
    // read into a write (plus a WAL frame) for a field only used for display.
    const now = nowSeconds();
    if (!key.lastSeen || now - key.lastSeen >= 60) this.#statements.touchKey.run(now, id);
    return { ok: true, key };
  }

  /**
   * Tokens this key has spent today. Requests refused before reaching the
   * upstream (`denied_*`, which carry no tokens) are excluded: counting them
   * would let a locked-out key keep inflating its own "requests" number.
   * @param {string} id
   * @param {number} now - epoch ms, injectable for tests.
   */
  tokensToday(id, now = Date.now()) {
    const row = this.#statements.sumToday.get(id, startOfToday(now)) ?? {};
    return { tokens: Number(row.tokens ?? 0), requests: Number(row.requests ?? 0) };
  }

  /**
   * Whether this key may start a request right now.
   * @param {object} key - a row from {@link authenticate}.
   */
  checkQuota(key, now = Date.now()) {
    const limit = key.limitTokensPerDay;
    if (limit === null || limit === undefined) return { allowed: true, used: 0, limit: null };
    const { tokens, requests } = this.tokensToday(key.id, now);
    // `>=` not `>`: a cap of N means "N tokens per day", so the request that
    // would start at N is already over budget.
    return { allowed: tokens < limit, used: tokens, limit, requests };
  }

  /**
   * Append one usage row. Never throws: a failed write must not take down a
   * request that already produced an answer, so the caller gets a boolean.
   * @param {object} entry
   */
  record(entry) {
    const {
      keyId = '',
      keyLabel = 'unknown',
      model = null,
      promptTokens = 0,
      completionTokens = 0,
      totalTokens = 0,
      status = STATUS.ok,
      error = null,
      ms = null,
      sessionId = null,
      ts = null,
    } = entry;
    try {
      this.#statements.insertUsage.run(
        ts ?? nowSeconds(),
        String(keyId ?? ''),
        String(keyLabel ?? 'unknown'),
        model === null || model === undefined ? null : String(model),
        Math.max(0, Number(promptTokens) || 0),
        Math.max(0, Number(completionTokens) || 0),
        Math.max(0, Number(totalTokens) || 0),
        String(status),
        error === null || error === undefined ? null : String(error).slice(0, 300),
        ms === null || ms === undefined ? null : Math.max(0, Math.round(Number(ms) || 0)),
        sessionId === null || sessionId === undefined ? null : String(sessionId),
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Keep one upstream balance reading, for reconciliation only. */
  recordQuota({ total = 0, consumed = 0, remaining = 0, billingMode = '', source = '' } = {}) {
    try {
      this.#statements.insertQuota.run(
        nowSeconds(),
        Number(total) || 0,
        Number(consumed) || 0,
        Number(remaining) || 0,
        billingMode ? String(billingMode) : null,
        source ? String(source) : null,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** @returns {object|null} the most recent balance reading. */
  latestQuota() {
    const row = this.#statements.latestQuota.get();
    return row ? { ...row } : null;
  }

  /**
   * Per-key totals over a window.
   * @param {{ since?: number, until?: number }} [window] - epoch seconds.
   * @returns {object[]}
   */
  report({ since = startOfToday(), until = null } = {}) {
    const sql = `
      SELECT key_label                                   AS label,
             COUNT(*)                                    AS requests,
             COALESCE(SUM(prompt_tokens), 0)             AS promptTokens,
             COALESCE(SUM(completion_tokens), 0)         AS completionTokens,
             COALESCE(SUM(total_tokens), 0)              AS totalTokens,
             SUM(CASE WHEN status = '${STATUS.ok}'
                      THEN 1 ELSE 0 END)                 AS okRequests,
             SUM(CASE WHEN status = '${STATUS.aborted}'
                      THEN 1 ELSE 0 END)                 AS abortedRequests,
             SUM(CASE WHEN status = '${STATUS.upstreamError}'
                      THEN 1 ELSE 0 END)                 AS upstreamErrors,
             SUM(CASE WHEN status = '${STATUS.deniedQuota}'
                      THEN 1 ELSE 0 END)                 AS quotaDenied,
             SUM(CASE WHEN status = '${STATUS.deniedUnauthorized}'
                      THEN 1 ELSE 0 END)                 AS unauthorized,
             SUM(CASE WHEN status = '${STATUS.deniedDisabled}'
                      THEN 1 ELSE 0 END)                 AS disabledDenied,
             MAX(ts)                                     AS lastAt
        FROM usage
       WHERE ts >= ? ${until === null ? '' : 'AND ts < ?'}
    GROUP BY key_label
    ORDER BY totalTokens DESC, requests DESC`;
    const rows = until === null ? this.db.prepare(sql).all(since) : this.db.prepare(sql).all(since, until);
    return rows.map(normaliseReportRow);
  }

  /** Totals for one day, per model — the second question the admin page asks. */
  byModel({ since = startOfToday(), until = null } = {}) {
    const sql = `
      SELECT COALESCE(model, '(unknown)') AS model,
             COUNT(*)                     AS requests,
             COALESCE(SUM(total_tokens), 0) AS totalTokens
        FROM usage
       WHERE ts >= ? ${until === null ? '' : 'AND ts < ?'}
    GROUP BY model
    ORDER BY totalTokens DESC`;
    const rows = until === null ? this.db.prepare(sql).all(since) : this.db.prepare(sql).all(since, until);
    return rows.map((row) => ({ ...row, requests: Number(row.requests), totalTokens: Number(row.totalTokens) }));
  }

  /**
   * The most recent requests, newest first.
   * @param {{ limit?: number, keyId?: string, label?: string }} [options]
   */
  recent({ limit = 100, keyId = null, label = null } = {}) {
    const capped = Math.min(1000, Math.max(1, Number(limit) || 100));
    if (keyId) return this.db.prepare('SELECT * FROM usage WHERE key_id = ? ORDER BY ts DESC, id DESC LIMIT ?').all(keyId, capped).map(plainRow);
    if (label) return this.db.prepare('SELECT * FROM usage WHERE key_label = ? ORDER BY ts DESC, id DESC LIMIT ?').all(label, capped).map(plainRow);
    return this.db.prepare('SELECT * FROM usage ORDER BY ts DESC, id DESC LIMIT ?').all(capped).map(plainRow);
  }

  /** Wipe every usage row. Used by tests and by an explicit admin reset. */
  clearUsage() {
    this.db.exec('DELETE FROM usage');
  }
}

/** Copy a `node:sqlite` row (a null-prototype object) into a plain one. */
function plainRow(row) {
  return { ...row };
}

/** Strip internal columns and add the masked form for display. */
function publicKey(row) {  return {
    id: row.id,
    label: row.label,
    note: row.note ?? null,
    masked: maskKey(row.prefix, row.last4),
    enabled: Boolean(row.enabled),
    limitTokensPerDay: row.limit_tokens_per_day === null ? null : Number(row.limit_tokens_per_day),
    createdAt: Number(row.created_at),
    lastSeen: row.last_seen === null ? null : Number(row.last_seen),
  };
}

function normaliseReportRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  for (const key of [
    'requests',
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'okRequests',
    'abortedRequests',
    'upstreamErrors',
    'quotaDenied',
    'unauthorized',
    'disabledDenied',
  ]) {
    out[key] = Number(out[key] ?? 0);
  }
  out.lastAt = out.lastAt === null || out.lastAt === undefined ? null : Number(out.lastAt);
  return out;
}

/**
 * Open (or create) a gateway database.
 * @param {string} file
 * @returns {GatewayStore}
 */
export function openStore(file) {
  return new GatewayStore(file);
}

export { SQLITE_HELP };
