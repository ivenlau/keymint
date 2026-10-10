/**
 * 四段式 license key 的生成与验证（纯函数，Worker / Node 通用）。
 *
 * 格式（以 '-' 分段，各段均为标准 Base64，不含 '-' 字符）：
 *   seg0  licenseId           10 位 [A-Z0-9]
 *   seg1  payload JSON        UTF-8 字节的 Base64
 *   seg2  签名                Base64（RSA-4096 → 512 B → 684 字符）
 *   seg3  X.509 证书          DER 的 Base64
 *
 * 签名内容 = seg1 解码后的 payload JSON 原始 UTF-8 字节，
 * 签名算法 = RSA（默认 SHA-1，见 config.signHash），
 * 验签公钥 = seg3 证书内公钥。
 */
import { CONFIG } from './config.js';

/* ---------------- Base64（标准字母表，可安全用 '-' 分段） ---------------- */

export function bytesToB64(bytes) {
  let bin = '';
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- 工具 ---------------- */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomLicenseId(cfg = CONFIG) {
  const { length, charset } = cfg.licenseId;
  const out = [];
  while (out.length < length) {
    const buf = new Uint8Array(length * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      // 拒绝采样，保证字符均匀
      if (b >= 256 - (256 % charset.length)) continue;
      out.push(charset[b % charset.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

/**
 * 构造 payload 对象。字段顺序固定，与 create_key.md 一致：
 * JSON.stringify 按插入顺序输出，保证待签数字节稳定。
 * @param {object} input  { licenseId, licenseeName, assigneeName, expiryDate, products? }
 *                        products 为产品码数组；缺省时使用配置中的全部产品码
 */
export function buildPayload(
  { licenseId, licenseeName, assigneeName, expiryDate, products },
  cfg = CONFIG,
) {
  const codes = products && products.length ? products : cfg.productCodes;
  return {
    licenseId,
    licenseeName,
    assigneeName,
    assigneeEmail: cfg.assigneeEmail,
    licenseRestriction: cfg.licenseRestriction,
    checkConcurrentUse: cfg.checkConcurrentUse,
    products: codes.map((code) => ({
      code,
      fallbackDate: expiryDate,
      paidUpTo: expiryDate,
    })),
    metadata: cfg.metadata,
    hash: cfg.hash,
    gracePeriodDays: cfg.gracePeriodDays,
    autoProlongated: cfg.autoProlongated,
    isAutoProlongated: cfg.isAutoProlongated,
  };
}

async function importSigningKey(pkcs8B64, cfg) {
  return crypto.subtle.importKey(
    'pkcs8',
    b64ToBytes(pkcs8B64),
    { name: 'RSASSA-PKCS1-v1_5', hash: cfg.signHash },
    false,
    ['sign'],
  );
}

async function importVerifyKey(spkiB64, cfg) {
  return crypto.subtle.importKey(
    'spki',
    b64ToBytes(spkiB64),
    { name: 'RSASSA-PKCS1-v1_5', hash: cfg.signHash },
    false,
    ['verify'],
  );
}

/* ---------------- 生成 ---------------- */

/**
 * 生成完整 key 字符串。
 * @param {object} input  { licenseeName, assigneeName, expiryDate }
 * @param {object} keys   { signingKeyPkcs8B64, certDerB64 }
 * @returns {Promise<string>}
 */
export async function generateLicenseKey(input, keys, cfg = CONFIG) {
  const licenseId = randomLicenseId(cfg);
  const payload = buildPayload({ ...input, licenseId }, cfg);
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = encoder.encode(payloadJson);

  const signingKey = await importSigningKey(keys.signingKeyPkcs8B64, cfg);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, payloadBytes);

  return [
    licenseId,
    bytesToB64(payloadBytes),
    bytesToB64(new Uint8Array(signature)),
    keys.certDerB64,
  ].join('-');
}

/* ---------------- 验证 ---------------- */

export function splitKey(key) {
  const parts = String(key || '').trim().split('-');
  return {
    licenseId: parts[0] || '',
    payloadB64: parts[1] || '',
    signatureB64: parts[2] || '',
    certDerB64: parts[3] || '',
    partCount: parts.length,
    segLengths: parts.map((p) => p.length),
  };
}

/**
 * 校验并归一化请求中的产品码。
 * config.productCodes 为默认目录；目录之外允许自定义编码
 * （向后兼容：目录内编码与省略 products 的行为完全不变）。
 * @returns {{products: string[]}|{error: string}}
 */
export function resolveProducts(input, cfg = CONFIG) {
  const requested = input && input.products;
  if (requested === undefined || requested === null) {
    return { products: [...cfg.productCodes] };
  }
  if (!Array.isArray(requested) || requested.length === 0) {
    return { error: 'products 需为非空数组' };
  }
  const codes = requested.map((c) => String(c).trim());
  if (codes.some((c) => !c || c.length > 64)) {
    return { error: '产品码不能为空且长度不超过 64 字符' };
  }
  return { products: [...new Set(codes)] };
}

/**
 * 验证 key：结构、licenseId 一致性、RSA 签名。
 * @returns {Promise<{valid: boolean, payload?: object, error?: string, segLengths?: number[]}>}
 */
export async function verifyLicenseKey(key, publicKeySpkiB64, cfg = CONFIG) {
  const seg = splitKey(key);

  if (seg.partCount !== 4) {
    return { valid: false, error: `分段数应为 4，实际 ${seg.partCount}` };
  }
  const idPattern = new RegExp(`^[A-Z0-9]{${cfg.licenseId.length}}$`);
  if (!idPattern.test(seg.licenseId)) {
    return { valid: false, error: 'seg0 不是合法的 licenseId' };
  }

  let payloadBytes;
  let payload;
  try {
    payloadBytes = b64ToBytes(seg.payloadB64);
    payload = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return { valid: false, error: 'seg1 不是合法的 payload JSON' };
  }
  if (payload.licenseId !== seg.licenseId) {
    return { valid: false, error: 'licenseId 与 payload 不一致' };
  }

  let signature;
  try {
    signature = b64ToBytes(seg.signatureB64);
  } catch {
    return { valid: false, error: 'seg2 不是合法的 Base64' };
  }

  let publicKey;
  try {
    publicKey = await importVerifyKey(publicKeySpkiB64, cfg);
  } catch {
    return { valid: false, error: '公钥（SPKI）解析失败' };
  }

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    signature,
    payloadBytes,
  );
  if (!ok) {
    return { valid: false, error: '签名验证失败' };
  }

  return { valid: true, payload, segLengths: seg.segLengths };
}

/* ---------------- 证书签名详情 ---------------- */

export function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** 最小 DER TLV 读取：返回标签与内容边界（足够解析 X.509 顶层结构） */
function derReadTlv(buf, pos) {
  const tag = buf[pos];
  let length = buf[pos + 1];
  let headerLen = 2;
  if (length & 0x80) {
    const numBytes = length & 0x7f;
    length = 0;
    for (let i = 0; i < numBytes; i++) length = length * 256 + buf[pos + 2 + i];
    headerLen = 2 + numBytes;
  }
  return { tag, start: pos, contentStart: pos + headerLen, contentEnd: pos + headerLen + length };
}

// DigestInfo(SHA-256) 的 DER 前缀：SEQUENCE { SEQ { OID 2.16.840.1.101.3.4.2.1, NULL }, OCTET STRING }
const SHA256_DIGEST_INFO = new Uint8Array([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65,
  0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20,
]);

/**
 * 证书签名详情（页面「/cert 签名」弹窗的数据源）：
 * - signatureHex：证书 signatureValue（CA 对 TBS 的 RSA 签名值），hex 编码
 * - encodedHex：PKCS#1(SHA256(TBS))，即 EMSA-PKCS1-v1_5 编码块，hex 编码。
 *   EM = 0x00 0x01 PS 0x00 DigestInfo(SHA-256) SHA256(TBS)，总长 = 模长；
 *   用 CA 公钥对签名做还原运算即得此块。
 * @param {string} certDerB64  X.509 证书（DER 的 Base64）
 * @returns {Promise<{signatureHex: string, encodedHex: string} | {error: string}>}
 */
export async function certSignatureInfo(certDerB64) {
  let der;
  try {
    der = b64ToBytes(certDerB64);
  } catch {
    return { error: '证书不是合法的 Base64' };
  }

  // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
  const cert = derReadTlv(der, 0);
  if (cert.tag !== 0x30) return { error: '证书不是合法的 DER SEQUENCE' };
  const tbs = derReadTlv(der, cert.contentStart);
  const tbsBytes = der.subarray(tbs.start, tbs.contentEnd); // 含头部的完整 DER 编码
  const alg = derReadTlv(der, tbs.contentEnd);
  const sigBits = derReadTlv(der, alg.contentEnd);
  if (sigBits.tag !== 0x03) return { error: '未找到 signatureValue（BIT STRING）' };
  const signature = der.subarray(sigBits.contentStart + 1, sigBits.contentEnd); // 首字节为 unused-bits

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', tbsBytes));

  const k = signature.length;
  const psLen = k - 3 - SHA256_DIGEST_INFO.length - digest.length;
  if (psLen < 8) return { error: '签名长度异常，无法构造 PKCS#1 编码块' };
  const em = new Uint8Array(k);
  em[0] = 0x00;
  em[1] = 0x01;
  em.fill(0xff, 2, 2 + psLen);
  em[2 + psLen] = 0x00;
  em.set(SHA256_DIGEST_INFO, 3 + psLen);
  em.set(digest, 3 + psLen + SHA256_DIGEST_INFO.length);

  return { signatureHex: toHex(signature), encodedHex: toHex(em) };
}

/* ---------------- PEM 辅助 ---------------- */

export function derToPem(derB64, label) {
  const body = derB64.replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
