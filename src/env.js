// env.js - 本机 Trae CN 环境探测 + 凭据持久化
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_PATHS = [
  '/Applications/Trae CN.app/Contents/Resources/app',
  path.join(os.homedir(), 'Applications/Trae CN.app/Contents/Resources/app'),
];

// x-ide-version / x-ide-version-code 必须与真实构建一致，
// 用旧固定值会让 get_detail_param 返回旧（残缺）模型目录。
// 注意：上游要求 version code 是**纯数字**，带点的 tronBuildVersion 会直接 400
// （binding: expr_path=app_version_code, cause=parameter type does not match binding data）；
// 且网关按该数值的**大小**做灰度，值太小会返回更少的 function 配置。
// 实测灰度阈值：20260401→42 条、20260701→46 条、>=20260901→57 条（完整目录）。
const MIN_APP_VERSION_CODE = 20260901;
const FALLBACK = { ideVersion: '3.4.1', appVersionCode: MIN_APP_VERSION_CODE };

export function detectEnv() {
  for (const app of APP_PATHS) {
    try {
      const product = JSON.parse(fs.readFileSync(path.join(app, 'product.json'), 'utf8'));
      const ideVersion = String(product.appVersion || product.version || '').trim();
      // 本机 traeVersionCode 可能落后于服务端已发布的 function 配置，只取不比基准旧的
      const raw = String(product.traeVersionCode || '').trim();
      const local = /^\d+$/.test(raw) ? Number(raw) : 0;
      const appVersionCode = local >= FALLBACK.appVersionCode ? local : FALLBACK.appVersionCode;
      if (ideVersion) {
        return {
          ideVersion,
          appVersionCode,
          ideVersionCode: String(appVersionCode),
          source: app,
          appId: product.iCubeApp?.authConfig?.appId || undefined,
        };
      }
    } catch {
      /* 继续找下一个候选路径 */
    }
  }
  return { ...FALLBACK, ideVersionCode: String(FALLBACK.appVersionCode), source: 'fallback' };
}

// Overridable so a test (or an operator with an unusual layout) can keep the
// credential file out of the real home directory without touching $HOME —
// which `lib/llm.js` also uses to locate the host's own packages.
export const CRED_DIR = process.env.TRAE_PROXY_CRED_DIR || path.join(os.homedir(), '.trae-proxy');
export const CRED_FILE = path.join(CRED_DIR, 'credentials.json');

export function loadCredentials() {
  try {
    const raw = fs.readFileSync(CRED_FILE, 'utf8');
    const creds = JSON.parse(raw);
    // 设备密钥/DeviceInfo 只在走 ECDSA 刷新流程时必需；
    // 网页回调直接下发凭据的情况用简单的 refreshToken 流程即可。
    if (!creds.refreshToken) throw new Error('凭据缺少 refreshToken，请重新登录');
    return creds;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`读取凭据失败 (${CRED_FILE}): ${err.message}`);
  }
}

export function saveCredentials(creds) {
  fs.mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CRED_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CRED_FILE);
  fs.chmodSync(CRED_FILE, 0o600);
  return CRED_FILE;
}

// TokenExpireAt 可能是秒/毫秒时间戳，也可能是 ISO 字符串。
export function parseExpiry(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  if (typeof raw === 'number') return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && String(raw).trim() !== '') {
    return asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
  }
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}
