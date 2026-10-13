// trae-local-credentials.js - macOS/Windows 本机 Trae 凭据读取
//
// 支持两种存储格式（运行时嗅探，不按版本硬编码）：
//   1. 明文 JSON（国际版实测如此）
//   2. "tc" 封装：base64 解码后 = 6 字节类型标签 + 32 字节随机数 + AES-128-CBC 密文
//
// tc 的密钥材料完全来自密文自身（不存在外部密钥）：
//   salt = SALT_A XOR SALT_B
//   h1   = SHA512(random32)
//   h2   = SHA512(h1 ‖ salt)
//   key  = h2[0:16]      iv = h2[16:32]
//   plain = AES-128-CBC-Decrypt(key, iv, ciphertext)
//   明文前 64 字节 == SHA512(其余部分)   ← 完整性校验
//
// SALT_A / SALT_B 分别是 AES 逆 S-box 的 [0:64] 与 [192:256]，下面由程序生成而非硬编码。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest();

/** 用标准 Rijndael 构造法生成 AES S-box，再取逆得到逆 S-box */
function buildInverseSbox() {
  const sbox = new Uint8Array(256);
  let p = 1;
  let q = 1;
  do {
    p = (p ^ (p << 1) ^ ((p & 0x80) ? 0x1b : 0)) & 0xff;
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const xformed = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    sbox[p] = (xformed ^ 0x63) & 0xff;
  } while (p !== 1);
  sbox[0] = 0x63;
  const inv = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) inv[sbox[i]] = i;
  return inv;
}

const INV_SBOX = buildInverseSbox();

function xorBytes(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

// AES 类型标签用 SALT_A ^ SALT_B；AES_PRIVATE 用另外两个不透明常量（未取得，暂不支持）
const SALT_AES = xorBytes(Buffer.from(INV_SBOX.subarray(0, 64)), Buffer.from(INV_SBOX.subarray(192, 256)));

const TC_TAG_AES = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
const TC_TAG_AES_PRIVATE = Buffer.from([0x12, 0x39, 0x20, 0x20, 0x02, 0x03]);

/** 导出以便自检：确认派生出的 salt 与已知常量一致 */
export const __internals = { INV_SBOX, SALT_AES };

export class TcDecryptError extends Error {}

/** 解密一个 tc 封装值；失败抛 TcDecryptError（含具体原因） */
export function decryptTcValue(base64Value) {
  const blob = Buffer.from(String(base64Value || '').trim(), 'base64');
  if (blob.length < 38 + 16) throw new TcDecryptError(`tc 数据过短 (${blob.length} 字节)`);
  const tag = blob.subarray(0, 6);
  const random = blob.subarray(6, 38);
  const ciphertext = blob.subarray(38);
  if (ciphertext.length % 16 !== 0) {
    throw new TcDecryptError(`密文长度 ${ciphertext.length} 不是 16 的整数倍`);
  }
  if (tag.equals(TC_TAG_AES_PRIVATE)) {
    throw new TcDecryptError('遇到 AES_PRIVATE 封装的 tc 数据（密钥常量未取得，暂不支持）');
  }
  if (!tag.equals(TC_TAG_AES)) {
    throw new TcDecryptError(`未知 tc 类型标签: ${tag.toString('hex')}`);
  }

  const h1 = sha512(random);
  const h2 = sha512(Buffer.concat([h1, SALT_AES]));
  const key = h2.subarray(0, 16);
  const iv = h2.subarray(16, 32);

  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new TcDecryptError(`AES 解密失败: ${err.message}`);
  }
  if (plain.length < 64) throw new TcDecryptError('解密结果过短，缺少完整性摘要');

  const digest = plain.subarray(0, 64);
  const body = plain.subarray(64);
  const expected = sha512(body);
  if (!crypto.timingSafeEqual(digest, expected)) {
    throw new TcDecryptError('完整性校验失败（SALT 或算法不匹配）');
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (err) {
    throw new TcDecryptError(`解密后不是合法 JSON: ${err.message}`);
  }
}

/** 解析 iCubeAuthInfo 的值：明文 JSON 或 tc 封装 */
export function parseAuthValue(rawValue) {
  const text = String(rawValue ?? '').trim();
  if (!text) throw new TcDecryptError('凭据值为空');
  if (text.startsWith('{')) return JSON.parse(text);
  return decryptTcValue(text);
}

const HOME = os.homedir();
const isMac = process.platform === 'darwin';

// macOS 与 Windows 的用户数据目录。Trae 是 VS Code 衍生，遵循各自平台惯例。
export const EDITIONS = {
  cn: {
    label: 'Trae CN',
    userDir: isMac
      ? path.join(HOME, 'Library/Application Support/Trae CN/User')
      : path.join(process.env.APPDATA || path.join(HOME, 'AppData/Roaming'), 'Trae CN/User'),
    apiHost: 'https://trae-api-cn.mchost.guru',
    refreshHost: 'https://api.trae.cn',
  },
  solo: {
    label: 'TRAE SOLO CN',
    userDir: isMac
      ? path.join(HOME, 'Library/Application Support/TRAE SOLO CN/User')
      : path.join(process.env.APPDATA || path.join(HOME, 'AppData/Roaming'), 'TRAE SOLO CN/User'),
    apiHost: 'https://trae-api-cn.mchost.guru',
    refreshHost: 'https://api.trae.cn',
  },
  sg: {
    label: 'Trae',
    userDir: isMac
      ? path.join(HOME, 'Library/Application Support/Trae/User')
      : path.join(process.env.APPDATA || path.join(HOME, 'AppData/Roaming'), 'Trae/User'),
    apiHost: 'https://a0ai-api-sg.byteintlapi.com',
    refreshHost: 'https://api-sg-central.trae.ai',
  },
  'solo-sg': {
    label: 'TRAE SOLO',
    userDir: isMac
      ? path.join(HOME, 'Library/Application Support/TRAE SOLO/User')
      : path.join(process.env.APPDATA || path.join(HOME, 'AppData/Roaming'), 'TRAE SOLO/User'),
    apiHost: 'https://a0ai-api-sg.byteintlapi.com',
    refreshHost: 'https://api-sg-central.trae.ai',
  },
};

const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';
const MACHINE_ID_KEY = 'telemetry.machineId';

/** 哪些 edition 在本机存在 storage.json */
export function discoverEditions() {
  const found = [];
  for (const [id, edition] of Object.entries(EDITIONS)) {
    const storageFile = path.join(edition.userDir, 'globalStorage/storage.json');
    if (fs.existsSync(storageFile)) found.push({ id, ...edition, storageFile });
  }
  return found;
}

/**
 * 读取某个 edition 的本机凭据。
 * @returns {{edition:string, token:string, refreshToken:string, userId:string, username:string,
 *            expiresAt:number, machineId:string, refreshHost:string, apiHost:string, format:string}}
 */
export function readLocalCredentials(editionId) {
  const edition = EDITIONS[editionId];
  if (!edition) throw new TcDecryptError(`未知 edition: ${editionId}（可选: ${Object.keys(EDITIONS).join(', ')}）`);
  const storageFile = path.join(edition.userDir, 'globalStorage/storage.json');
  if (!fs.existsSync(storageFile)) throw new TcDecryptError(`找不到 storage.json: ${storageFile}`);

  const storage = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
  const rawValue = storage[AUTH_KEY];
  if (!rawValue) throw new TcDecryptError(`storage.json 缺少 ${AUTH_KEY}`);

  const format = String(rawValue).trim().startsWith('{') ? 'plaintext' : 'tc';
  const auth = parseAuthValue(rawValue);
  if (!auth.token || !auth.refreshToken) {
    throw new TcDecryptError('凭据缺少 token 或 refreshToken（可能未登录）');
  }

  const account = auth.account || {};
  const boot = account.saasBootConfig || {};
  // 刷新主机优先级：企业/租户自助配置 > 明文版自带 host > edition 默认。
  // 企业版账号写死 api.trae.cn 会报 20101 refresh token is invalid。
  const refreshHost = String(boot.apiHost || boot.consoleHost || auth.host || edition.refreshHost).replace(/\/+$/, '');
  return {
    edition: editionId,
    format,
    token: auth.token,
    refreshToken: auth.refreshToken,
    userId: String(auth.userId || ''),
    username: String(account.username || account.name || ''),
    expiresAt: Math.floor(new Date(auth.expiredAt).getTime() / 1000) || 0,
    refreshExpiresAt: Math.floor(new Date(auth.refreshExpiredAt).getTime() / 1000) || 0,
    machineId: String(storage[MACHINE_ID_KEY] || ''),
    tenantName: String(account.tenant_name || ''),
    isEnterprise: String(refreshHost).includes('enterprise'),
    refreshHost,
    apiHost: edition.apiHost,
  };
}

/** 自动挑选本机可用凭据（按 cn → solo → sg → solo-sg 顺序） */
export function readAnyLocalCredentials() {
  const errors = [];
  for (const edition of discoverEditions()) {
    try {
      return readLocalCredentials(edition.id);
    } catch (err) {
      errors.push(`${edition.id}: ${err.message}`);
    }
  }
  if (!errors.length) {
    throw new TcDecryptError('本机未发现任何 Trae 安装（已检查 4 个 edition 的 storage.json）');
  }
  throw new TcDecryptError(`本机凭据均不可用：\n  ${errors.join('\n  ')}`);
}
