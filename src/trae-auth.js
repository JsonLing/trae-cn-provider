// trae-auth.js - 网页登录 OAuth(PKCE) + ECDSA 设备证明刷新
// 全程不使用本机 storage.json 里的加密凭据，用户用浏览器为自己的账号授权。
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseExpiry, CRED_DIR } from './env.js';

const API_HOST = 'https://api.trae.cn';
const AUTHORIZE_URL = 'https://www.trae.cn/authorization';
const CLIENT_ID = 'ono9krqynydwx5';
const EXCHANGE_PATH = '/trae/api/v3/oauth/ExchangeToken';
const SIMPLE_REFRESH_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken';
const USER_INFO_PATH = '/cloudide/api/v3/trae/GetUserInfo';
const DEBUG_LOG = path.join(CRED_DIR, 'login-debug.log');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** 生成设备密钥对与 DeviceInfo（登录与刷新必须用同一对，服务端会校验签名） */
export function createDevice(ideVersion) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const deviceInfo = {
    DeviceID: crypto.randomUUID(),
    MachineID: crypto.createHash('sha512').update(crypto.randomUUID()).digest('hex'),
    PlatformCode: 'IDE_PC',
    DeviceType: 'PC',
    // DeviceName 留 "TraeProxy" 会被上游识别为非真客户端 — 它只回
    // trial 兜底目录（2 条 fast_apply），真实 25+ 模型看不到。
    // Trae 真客户端这里填的是本机短主机名，我们也对齐。
    // 允许 TRAE_PROXY_DEVICE_NAME 覆盖（自定一个跨主机稳定名）。
    DeviceName: process.env.TRAE_PROXY_DEVICE_NAME
      || (os.hostname().split('.')[0] || 'TraeProxy'),
    DeviceModel: '',
    DeviceBrand: '',
    DeviceCPU: '',
    OSInfo: 'macOS',
    OSVersion: os.release(),
    ClientVersion: ideVersion,
    DevicePublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  };
  return {
    deviceInfo,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: deviceInfo.DevicePublicKey,
  };
}

async function postJson(url, body, headers = {}, timeoutMs = 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Carry the status as data, not only inside the message: callers need to
    // tell "this endpoint does not exist here" (404/405) apart from "the
    // upstream refused this credential".
    const err = new Error(`${url} 响应不是合法 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    err.httpStatus = res.status;
    throw err;
  }
  const err = json?.ResponseMetadata?.Error;
  if (err && (err.Code != null || err.Message != null)) {
    throw new Error(`上游拒绝: ${err.Code ?? ''} ${err.Message ?? ''}`.trim());
  }
  if (!res.ok) {
    const err = new Error(`${url} HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.httpStatus = res.status;
    throw err;
  }
  // 两种信封：旧版 {Result:...}，企业版网关 {code, message, Data:...}
  if (typeof json?.code === 'number' && json.code !== 0) {
    throw new Error(`上游拒绝: ${json.code} ${json.message || ''}`.trim());
  }
  const result = json?.Result ?? json?.Data;
  if (!result || typeof result !== 'object') throw new Error(`${url} 未返回 Result/Data 对象`);
  return result;
}

function applyToken(creds, result) {
  const token = result.Token || result.token || result.AccessToken;
  if (!token) throw new Error('未取得有效登录令牌');
  creds.token = token;
  const rt = result.RefreshToken || result.refreshToken;
  if (rt) creds.refreshToken = rt;
  const expiry = result.TokenExpireAt ?? result.tokenExpireAt ?? result.expiredAt;
  creds.expiredRaw = expiry ?? '';
  creds.expiresAt = parseExpiry(expiry);
  const refreshExpiry = result.RefreshExpireAt ?? result.refreshExpireAt;
  if (refreshExpiry !== undefined && refreshExpiry !== null) {
    creds.refreshExpiresAt = parseExpiry(refreshExpiry);
  }
  return creds;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

const CODE_KEYS = ['AuthCode', 'authCode', 'auth_code', 'code'];

function digForCode(node, depth = 0) {
  if (depth > 5) return '';
  if (typeof node === 'string') {
    for (const key of CODE_KEYS) {
      const match = node.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
      if (match) return match[1];
    }
    return '';
  }
  if (node && typeof node === 'object') {
    for (const key of CODE_KEYS) {
      if (typeof node[key] === 'string' && node[key]) return node[key];
    }
    for (const value of Object.values(node)) {
      const hit = digForCode(value, depth + 1);
      if (hit) return hit;
    }
  }
  return '';
}

/**
 * 从回调 query 里取 AuthCode。Trae 把授权码放在 authCodeInfo（URL 编码的 JSON）里，
 * 但实际编码细节未知，所以这里穷举多种解码路径并返回命中的策略名。
 */
export function extractAuthCode(rawQuery) {
  const pairs = [];
  for (const chunk of String(rawQuery || '').split('&')) {
    const eq = chunk.indexOf('=');
    if (eq < 0) {
      pairs.push([safeDecode(chunk) ?? chunk, '']);
      continue;
    }
    pairs.push([
      safeDecode(chunk.slice(0, eq)) ?? chunk.slice(0, eq),
      chunk.slice(eq + 1),
    ]);
  }

  // 1) 直接就是 code / authCode / auth_code 参数
  for (const [key, rawValue] of pairs) {
    if (['code', 'authCode', 'auth_code'].includes(key)) {
      const value = safeDecode(rawValue) ?? rawValue;
      if (value) return { code: value, strategy: `direct:${key}` };
    }
  }

  // 2) authCodeInfo（或任何参数）里嵌 JSON
  const candidates = pairs.filter(([key]) => key === 'authCodeInfo');
  for (const [key, rawValue] of [...candidates, ...pairs]) {
    const variants = [
      ['raw', rawValue],
      ['raw+nospace', rawValue.replace(/\+/g, ' ')],
      ['decoded', safeDecode(rawValue)],
      ['decoded+nospace', safeDecode(rawValue)?.replace(/\+/g, ' ')],
    ];
    for (const [label, value] of variants) {
      if (!value) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(value);
      } catch {
        /* 不是 JSON，继续尝试从字符串里挖 */
      }
      const code = parsed ? digForCode(parsed) : digForCode(value);
      if (code) return { code, strategy: `${key}:${label}` };
    }
  }

  return { code: '', strategy: 'none' };
}

/** 把回调原始信息落盘，便于定位参数形态 */
function dumpCallback(record) {
  try {
    fs.mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(DEBUG_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
  } catch {
    /* 诊断写失败不影响主流程 */
  }
}

// 回调 query 带着 userJwt（内含 Token / RefreshToken）与 userInfo，原样落盘等于
// 把凭据复制到 credentials.json 之外。诊断只需要「参数长什么样」，不需要密码
// 本身 —— 所以敏感键一律替换成 `<redacted N>`，非敏感长值也截断。
const SECRET_KEY = /(token|jwt|secret|password|passwd|code|ticket|session|auth|key|sig|credential|userinfo)/i;

/** Redact an OAuth callback query string before it reaches the debug log. */
export function redactSearch(search) {
  const raw = String(search ?? '');
  if (!raw) return '';
  const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  const parts = [];
  for (const [key, value] of params) {
    if (SECRET_KEY.test(key)) {
      parts.push(`${key}=<redacted ${value.length}>`);
    } else if (value.length > 32) {
      parts.push(`${key}=${value.slice(0, 8)}…(${value.length})`);
    } else {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * 走网页登录拿凭据。
 * @param {object} opts
 * @param {string} opts.ideVersion
 * @param {(url:string)=>void} [opts.onAuthorizeUrl] 拿到授权链接时回调
 * @param {(msg:string)=>void} [opts.onProgress]
 * @param {number} [opts.timeoutMs]
 */
export async function webLogin({ ideVersion, onAuthorizeUrl, onProgress, timeoutMs = 30 * 60 * 1000 } = {}) {
  const device = createDevice(ideVersion);
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const log = (msg) => (onProgress ? onProgress(msg) : console.log(msg));

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const callbackUrl = `http://127.0.0.1:${port}/authorize`;

  const creds = {
    clientId: CLIENT_ID,
    host: API_HOST,
    deviceInfo: device.deviceInfo,
    privateKeyPem: device.privateKeyPem,
    publicKeyPem: device.publicKeyPem,
  };

  const loginPromise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('网页登录超时，请重新登录')), timeoutMs);

    server.on('request', (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const respond = (status, message) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end(`<meta charset="utf-8"><h1>${message}</h1>`);
      };
      if (req.method !== 'GET' || url.pathname !== '/authorize') {
        dumpCallback({ kind: 'unexpected', method: req.method, path: url.pathname, search: redactSearch(url.search) });
        return respond(400, 'Invalid callback');
      }

      const parsed = parseCallback(url.search);
      const keys = [...url.searchParams.keys()];
      dumpCallback({ kind: 'callback', strategy: parsed.strategy ?? parsed.kind, found: parsed.kind !== 'unknown', keys, search: redactSearch(url.search) });

      if (parsed.kind === 'unknown') {
        // 不结束登录：用户可以直接刷新授权页重试
        console.error(`[login] 回调形态无法识别（参数: ${keys.join(', ') || '无'}），原始信息已写入 ${DEBUG_LOG}`);
        respond(400, '未识别到登录凭据，请回终端查看诊断信息后重试');
        return;
      }

      (async () => {
        try {
          if (parsed.kind === 'credentials') {
            Object.assign(creds, parsed.creds);
            if (!creds.refreshToken) throw new Error('回调未携带 refreshToken');
            if (!creds.userId) throw new Error('回调未携带 UserID');
            log('已从回调直接取得登录凭据（无需换码）');
          } else {
            log(`已收到授权码（解析方式: ${parsed.strategy}），正在换取令牌…`);
            applyToken(creds, await postJson(`${API_HOST}${EXCHANGE_PATH}`, {
              ClientID: CLIENT_ID,
              AuthCode: parsed.code,
              CodeVerifier: verifier,
              DeviceInfo: device.deviceInfo,
              IDEVersion: ideVersion,
            }));
            const user = await postJson(
              `${API_HOST}${USER_INFO_PATH}`,
              { ReqSource: 'IDE', IDEVersion: ideVersion },
              { 'x-cloudide-token': creds.token },
            );
            creds.userId = String(user.UserID || '');
            if (!creds.userId) throw new Error('账号查询未通过验证');
            creds.username = String(user.Username || user.Name || '');
          }
          creds.editionId = 'cn';
          respond(200, `登录成功${creds.username ? `（${creds.username}）` : ''}，请返回终端`);
          finish(resolve, creds);
        } catch (err) {
          console.error(`[login] 换取令牌失败: ${err.message}`);
          respond(400, '换取令牌失败，请回终端查看原因并重试');
        }
      })();
    });

    const params = new URLSearchParams({
      login_version: '1',
      auth_from: 'trae',
      login_channel: 'native_ide',
      plugin_version: ideVersion,
      auth_type: 'local',
      client_id: CLIENT_ID,
      redirect: '0',
      login_trace_id: crypto.randomUUID(),
      auth_callback_url: callbackUrl,
      machine_id: device.deviceInfo.MachineID,
      device_id: device.deviceInfo.DeviceID,
      x_app_version: ideVersion,
      x_app_type: 'stable',
      x_device_type: 'macOS',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    params.set('x_device_id', device.deviceInfo.DeviceID);
    params.set('x_machine_id', device.deviceInfo.MachineID);
    const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`;
    if (onAuthorizeUrl) onAuthorizeUrl(authorizeUrl);
    else loginMessage(authorizeUrl);
  });

  function loginMessage(authorizeUrl) {
    console.log(`请在浏览器打开：\n${authorizeUrl}\n`);
  }

  try {
    return await loginPromise;
  } finally {
    server.close();
  }
}

/**
 * 用 refreshToken 换新 access token。
 * 有设备密钥走 ECDSA 设备证明流程（网页登录自建设备身份时使用）；
 * 没有则走简化流程（网页回调直接下发凭据时适用，与社区实现一致）。
 */
export async function refreshToken(creds, ideVersion) {
  if (!creds.refreshToken) throw new Error('无 refreshToken，无法刷新');
  const host = (creds.host || API_HOST).replace(/\/+$/, '');
  const useDeviceProof = Boolean(creds.privateKeyPem && creds.deviceInfo);

  if (useDeviceProof) {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const payload = `POST\n${EXCHANGE_PATH}\n${creds.clientId}\n${creds.refreshToken}\n${timestamp}\n${nonce}`;
    const signature = crypto
      .sign('sha256', Buffer.from(payload, 'utf8'), { key: creds.privateKeyPem, dsaEncoding: 'der' })
      .toString('base64');
    try {
      const result = await postJson(`${host}${EXCHANGE_PATH}`, {
        ClientID: creds.clientId,
        ClientSecret: '',
        RefreshToken: creds.refreshToken,
        DeviceInfo: creds.deviceInfo,
        DeviceProof: { Signature: signature, Timestamp: timestamp, Nonce: nonce },
        IDEVersion: ideVersion,
      });
      return applyToken({ ...creds }, result);
    } catch (err) {
      // Measured on console.enterprise.trae.cn: the device-proof endpoint does
      // not exist on tenant hosts — the gateway answers 404 with an HTML body —
      // while the no-signature `/cloudide/...` endpoint does (PROTOCOL.md).
      // Fall back only when the endpoint is genuinely absent. A proof the
      // server *rejected* is a real authentication failure and must surface
      // unchanged, or a bad device key would silently downgrade to the weaker
      // flow.
      if (err?.httpStatus !== 404 && err?.httpStatus !== 405) throw err;
    }
  }

  const result = await postJson(`${host}${SIMPLE_REFRESH_PATH}`, {
    ClientID: creds.clientId || CLIENT_ID,
    RefreshToken: creds.refreshToken,
    ClientSecret: '-',
    UserID: creds.userId,
  });
  return applyToken({ ...creds }, result);
}

/**
 * 解析网页回调。实测 Trae 的回调**不下发授权码**，而是直接给：
 *   userJwt  = {"Token","RefreshToken","TokenExpireAt","RefreshExpireAt","TokenExpireDuration"}
 *   userInfo = {"UserInfo":{"UserID","Name","Account","Email",...}, ...}
 * 同时保留对 authCodeInfo（授权码）形态的兼容。
 */
export function parseCallback(search) {
  const params = new Map();
  for (const [key, rawValue] of new URLSearchParams(String(search || '').replace(/^\?/, ''))) {
    params.set(key, rawValue);
  }
  const asJson = (key) => {
    const raw = params.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const jwt = asJson('userJwt');
  if (jwt?.Token) {
    const info = asJson('userInfo')?.UserInfo ?? {};
    // 企业版账号的刷新必须打到账号自己的 host（回调里会给，例如
    // https://console.enterprise.trae.cn）；写死 api.trae.cn 会报 20101 refresh token is invalid
    const host = String(params.get('host') || '').replace(/\/+$/, '');
    return {
      kind: 'credentials',
      creds: {
        token: jwt.Token,
        refreshToken: jwt.RefreshToken || params.get('refreshToken') || '',
        expiredRaw: jwt.TokenExpireAt ?? '',
        expiresAt: parseExpiry(jwt.TokenExpireAt),
        refreshExpiresAt: parseExpiry(jwt.RefreshExpireAt ?? params.get('refreshExpireAt')),
        userId: String(info.UserID || ''),
        username: String(info.Name || info.Account || ''),
        scope: params.get('scope') || '',
        ...(host ? { host } : {}),
      },
    };
  }

  const { code, strategy } = extractAuthCode(String(search || '').replace(/^\?/, ''));
  if (code) return { kind: 'authCode', code, strategy };
  return { kind: 'unknown', strategy: 'none' };
}

/** 距过期不足 30 分钟就刷新 */
export function needsRefresh(creds, nowSec = Math.floor(Date.now() / 1000)) {
  if (!creds.expiresAt) return false;
  return nowSec >= creds.expiresAt - 1800;
}
