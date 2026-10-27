// quota.js - read-only credit snapshot for the signed-in CN account.
//
// `llm_utils_chat` reports an exhausted balance as the SSE code `4008`, whose
// text ("Your requests have exceeded the quota.") says nothing about *what* is
// exhausted or by how much. The web dashboard reads the same numbers from this
// endpoint; the call is read-only and does **not** consume credits.
//
// Scope note: this is the consumer/IDE credit ledger. Enterprise tenants
// (`tenant_id: tob_online`) additionally have a pooled "基础会话" quota that is
// managed and reported in the enterprise console — that pool is not exposed
// here, so a nonzero balance below does not by itself prove enterprise quota.
import { pick } from '../lib/support.js';

export const QUOTA_HOST = 'https://api.trae.cn';
export const QUOTA_PATH = '/trae/api/v2/pay/web_user_ent_usage';

const NUMBER_KEYS = ['amount', 'credits_limit', 'total_amount', 'consumed_amount'];

function toNumber(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function firstNumber(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

/**
 * Turn the `web_user_ent_usage` payload into a small, stable snapshot.
 *
 * `remaining` comes from `usage_summary` (total - consumed), which is what the
 * dashboard shows. Each pack's `creditsAmount` is passed through as-is: the
 * upstream does not document whether it is granted or consumed, so callers must
 * not treat it as a balance.
 * @param {any} payload
 */
export function summarizeQuota(payload) {
  const summary = payload?.usage_summary && typeof payload.usage_summary === 'object' ? payload.usage_summary : {};
  const total = firstNumber(summary, ['total_amount', ...NUMBER_KEYS]);
  const consumed = firstNumber(summary, ['consumed_amount']);
  const remaining = Math.max(0, total - consumed);
  const ratio = total > 0 ? Math.min(1, consumed / total) : 0;
  const packs = (Array.isArray(payload?.user_entitlement_pack_list) ? payload.user_entitlement_pack_list : [])
    .filter((pack) => pack && typeof pack === 'object')
    .map((pack) => {
      const quota = pack.entitlement_base_info?.quota ?? pack.quota ?? {};
      return {
        name: pick(pack, ['display_desc', 'group_name'], '未命名'),
        group: pick(pack, ['group_name']),
        creditsAmount: firstNumber(quota, ['credits_limit']) || firstNumber(pack.usage, ['credits_amount']),
        expiresAt: firstNumber(pack, ['expire_time']),
        status: typeof pack.status === 'number' ? pack.status : null,
      };
    });
  return {
    total,
    consumed,
    remaining,
    ratio,
    billingMode: payload?.is_credits_billing === true ? 'credits' : payload?.is_dollar_usage_billing === true ? 'dollar' : '',
    packs,
  };
}

/** Render a YYYY-MM-DD date in local time, or '' when the timestamp is absent. */
export function formatDate(seconds) {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

/**
 * Read the account's credit snapshot.
 * @param {{token: string}} creds
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {string} [options.path]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.userAgent] - the IDE UA; the gateway fingerprints it.
 */
export async function fetchQuota(creds, {
  host = QUOTA_HOST,
  path = QUOTA_PATH,
  fetchImpl = globalThis.fetch,
  userAgent = 'Trae/3.4.6',
} = {}) {
  if (!creds?.token) throw new Error('缺少 access token，无法查询额度');
  const url = `${host.replace(/\/+$/, '')}${path}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Cloud-IDE-JWT ${creds.token}`,
      'X-Cloudide-Token': creds.token,
      'X-Ide-Token': creds.token,
      'User-Agent': userAgent,
    },
    body: JSON.stringify({ require_usage: true }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const hint = res.status === 404 || res.status === 405
      ? '（该 host 没有额度接口；国际版/企业租户主机不提供此端点，请用 api.trae.cn）'
      : '';
    throw new Error(`额度接口 HTTP ${res.status}${hint}: ${text.slice(0, 200)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`额度接口返回的不是 JSON: ${text.slice(0, 200)}`);
  }
  if (typeof json?.code === 'number' && json.code !== 0) {
    throw new Error(`额度接口返回 ${json.code}: ${json.message || '未知错误'}`);
  }
  return { ...summarizeQuota(json), host, raw: json };
}

/** Decode the tenant id from a JWT without verifying it (display only). */
export function tenantOf(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8'));
    return { tenantId: String(payload?.data?.tenant_id || ''), userId: String(payload?.data?.user_id || '') };
  } catch {
    return { tenantId: '', userId: '' };
  }
}

/**
 * Human-readable report. `tenantId` is shown because enterprise accounts have a
 * second, console-managed quota pool that this snapshot does not cover.
 * @param {ReturnType<typeof summarizeQuota>} snapshot
 * @param {{tenantId?: string, username?: string}} [account]
 */
export function formatQuota(snapshot, { tenantId = '', username = '' } = {}) {
  const lines = [];
  const who = [username, tenantId ? `tenant=${tenantId}` : ''].filter(Boolean).join('，');
  lines.push(`账号额度${who ? `（${who}）` : ''} — 只读查询，不消耗积分`);
  lines.push(`  总量: ${snapshot.total}`);
  lines.push(`  已用: ${snapshot.consumed}（${Math.round(snapshot.ratio * 100)}%）`);
  lines.push(`  可用: ${snapshot.remaining}`);
  if (snapshot.billingMode) lines.push(`  计费: ${snapshot.billingMode}`);
  if (snapshot.packs.length) {
    lines.push('  积分包:');
    for (const pack of snapshot.packs) {
      const expiry = formatDate(pack.expiresAt);
      lines.push(
        `    - ${pack.name}${pack.group && pack.group !== pack.name ? `（${pack.group}）` : ''}` +
          `${pack.creditsAmount ? ` 额度 ${pack.creditsAmount}` : ''}` +
          `${expiry ? ` 到期 ${expiry}` : ''}`,
      );
    }
  }
  if (snapshot.remaining <= 0) {
    lines.push('');
    if (!tenantId) {
      lines.push('  ⚠️ 个人积分已用尽：消费版网关会以 4008 拒绝所有模型请求（与插件无关）。');
      return lines.join('\n');
    }
    // An enterprise account keeps two ledgers. Reporting the personal one as
    // "you are out of quota" is exactly the misdiagnosis this command exists to
    // prevent: the tenant gateway bills the seat pool per session instead.
    lines.push('  ⚠️ 个人积分已用尽 —— 但这**不代表**企业账号没有额度。');
    lines.push('     企业席位额度（「基础会话」/加量包/按量计费）在企业控制台的用量管理里，按会话计量；');
    lines.push('     0.1.7 起请求走租户网关并带 session_id，扣的是那份额度，与这里的个人账本无关。');
  }
  return lines.join('\n');
}
