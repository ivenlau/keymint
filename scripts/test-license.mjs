/**
 * 冒烟测试：生成 → 验证 → 篡改检测。
 * 运行：npm test（或 node scripts/test-license.mjs）
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLicenseKey, verifyLicenseKey, resolveProducts, splitKey, randomLicenseId, certSignatureInfo } from '../src/license.js';
import { CONFIG, resolveConfig } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const assert = (cond, msg) => {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  console.log('✓ ' + msg);
};

// 用 WebCrypto 生成一对临时 RSA 密钥（测试用 2048 位即可）
const pair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: CONFIG.signHash },
  true,
  ['sign', 'verify'],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
const toB64 = (b) => Buffer.from(b).toString('base64');

const fakeCertB64 = Buffer.from('FAKE-CERT-FOR-TEST').toString('base64');
const input = { licenseeName: 'Test Licensee', assigneeName: 'Test Group', expiryDate: '2026-12-31' };

// —— 若 scripts/ 下已有真实证书产物，则用它做完整往返测试 ——
const realPkcs8Path = join(here, 'sign.pkcs8.b64');
const realSpkiPath = join(here, 'sign.spki.b64');
const realDerPath = join(here, 'sign.der.b64');
if (existsSync(realPkcs8Path) && existsSync(realSpkiPath) && existsSync(realDerPath)) {
  const key = await generateLicenseKey(input, {
    signingKeyPkcs8B64: readFileSync(realPkcs8Path, 'utf8').trim(),
    certDerB64: readFileSync(realDerPath, 'utf8').trim(),
  });
  const res = await verifyLicenseKey(key, readFileSync(realSpkiPath, 'utf8').trim());
  assert(res.valid, '真实证书产物：签发 + 验签通过');
  assert(res.payload.licenseeName === input.licenseeName, '真实证书产物：licenseeName 一致');
}

// —— 逻辑测试 ——
const key = await generateLicenseKey(input, {
  signingKeyPkcs8B64: toB64(pkcs8),
  certDerB64: fakeCertB64,
});

const seg = splitKey(key);
assert(seg.partCount === 4, 'key 为 4 段');
assert(/^[A-Z0-9]{10}$/.test(seg.licenseId), 'seg0 为 10 位 [A-Z0-9] licenseId');

const ok = await verifyLicenseKey(key, toB64(spki));
assert(ok.valid, '签名验证通过');
assert(ok.payload.licenseId === seg.licenseId, 'licenseId 与 payload 一致');
assert(ok.payload.metadata === CONFIG.metadata, 'metadata 使用配置值');
assert(ok.payload.hash === CONFIG.hash, 'hash 使用配置值');
assert(ok.payload.gracePeriodDays === CONFIG.gracePeriodDays, 'gracePeriodDays 使用配置值');
assert(ok.payload.products.length === CONFIG.productCodes.length, '产品条数 = 配置产品码数');
assert(
  ok.payload.products.every((p) => p.paidUpTo === input.expiryDate && p.fallbackDate === input.expiryDate),
  '全部产品 paidUpTo / fallbackDate = 到期日',
);
assert(
  JSON.stringify(Object.keys(ok.payload)) ===
    JSON.stringify([
      'licenseId', 'licenseeName', 'assigneeName', 'assigneeEmail', 'licenseRestriction',
      'checkConcurrentUse', 'products', 'metadata', 'hash', 'gracePeriodDays',
      'autoProlongated', 'isAutoProlongated',
    ]),
  'payload 字段顺序与 create_key.md 一致',
);

// 指定产品码子集
const subsetKey = await generateLicenseKey(
  { ...input, products: ['G1'] },
  { signingKeyPkcs8B64: toB64(pkcs8), certDerB64: fakeCertB64 },
);
const subsetRes = await verifyLicenseKey(subsetKey, toB64(spki));
assert(subsetRes.valid, '产品子集：签发 + 验签通过');
assert(
  subsetRes.payload.products.length === 1 && subsetRes.payload.products[0].code === 'G1',
  '产品子集：payload 仅含所选产品码',
);

// resolveConfig：环境变量覆盖与默认值
const defCfg = resolveConfig({});
assert(defCfg.productCodes.join() === CONFIG.productCodes.join() && defCfg.signHash === CONFIG.signHash, 'resolveConfig：无环境变量时使用默认值');
const envCfg = resolveConfig({
  PRODUCT_CODES: 'X1, X2',
  METADATA: 'META-ENV',
  PAYLOAD_HASH: 'HASH-ENV',
  SIGN_HASH: 'SHA-256',
  PAGE_TITLE: 'ENV TITLE',
  AUTO_PROLONGATED: 'false',
  CHECK_CONCURRENT_USE: 'true',
  GRACE_PERIOD_DAYS: '0',
  MAX_NAME_LENGTH: '64',
  COMMAND_WINDOWS: 'env-win-command',
  EMPTY_VAR: '',
});
assert(envCfg.productCodes.join() === 'X1,X2', 'resolveConfig：PRODUCT_CODES 逗号列表');
assert(resolveConfig({ PRODUCT_CODES: '["J1","J2"]' }).productCodes.join() === 'J1,J2', 'resolveConfig：PRODUCT_CODES JSON 数组');
assert(envCfg.metadata === 'META-ENV' && envCfg.hash === 'HASH-ENV', 'resolveConfig：METADATA / PAYLOAD_HASH 覆盖');
assert(envCfg.signHash === 'SHA-256' && envCfg.pageTitle === 'ENV TITLE', 'resolveConfig：SIGN_HASH / PAGE_TITLE 覆盖');
assert(envCfg.autoProlongated === false && envCfg.isAutoProlongated === false, 'resolveConfig：AUTO_PROLONGATED=false 同时作用两个字段');
assert(envCfg.checkConcurrentUse === true && envCfg.gracePeriodDays === 0, 'resolveConfig：布尔/数字解析');
assert(envCfg.maxNameLength === 64 && envCfg.commandWindows === 'env-win-command', 'resolveConfig：MAX_NAME_LENGTH / COMMAND_WINDOWS 覆盖');
assert(envCfg.assigneeEmail === CONFIG.assigneeEmail, 'resolveConfig：空字符串视为未设置');

// resolveProducts：目录 + 自定义编码（向后兼容）
const r1 = resolveProducts({});
assert(JSON.stringify(r1.products) === JSON.stringify(CONFIG.productCodes), 'resolveProducts：缺省使用配置目录');
const r2 = resolveProducts({ products: ['G1', 'MY-CUSTOM'] });
assert(r2.products.includes('G1') && r2.products.includes('MY-CUSTOM'), 'resolveProducts：允许自定义编码');
assert(resolveProducts({ products: [] }).error === 'products 需为非空数组', 'resolveProducts：空数组报错');
assert(!!resolveProducts({ products: ['ok', ''] }).error, 'resolveProducts：空产品码报错');
assert(!!resolveProducts({ products: ['x'.repeat(65)] }).error, 'resolveProducts：超长产品码报错');
assert(resolveProducts({ products: ['A', 'A', 'G1'] }).products.length === 2, 'resolveProducts：自动去重');

// 自定义产品码写入 payload
const customKey = await generateLicenseKey(
  { ...input, products: ['MY-CUSTOM'] },
  { signingKeyPkcs8B64: toB64(pkcs8), certDerB64: fakeCertB64 },
);
const customRes = await verifyLicenseKey(customKey, toB64(spki));
assert(customRes.valid && customRes.payload.products[0].code === 'MY-CUSTOM', '自定义产品码写入 payload');

// 篡改 payload 后签名应失效
const parts = key.split('-');
const tamperedPayload = Buffer.from(parts[1], 'base64').toString('utf8').replace('Test Licensee', 'Evil Hacker');
const tampered = [parts[0], Buffer.from(tamperedPayload, 'utf8').toString('base64'), parts[2], parts[3]].join('-');
const bad = await verifyLicenseKey(tampered, toB64(spki));
assert(!bad.valid, '篡改 payload 后验签失败');

// licenseId 不一致应被拒绝
const otherId = randomLicenseId();
const mismatched = [otherId, parts[1], parts[2], parts[3]].join('-');
const bad2 = await verifyLicenseKey(mismatched, toB64(spki));
assert(!bad2.valid, 'licenseId 与 payload 不一致时被拒绝');

// 分段数错误应被拒绝
const bad3 = await verifyLicenseKey(parts.slice(0, 3).join('-'), toB64(spki));
assert(!bad3.valid, '分段数不足 4 时被拒绝');

// 证书签名详情：非法 DER 返回 error 而非抛出
assert(!!(await certSignatureInfo(fakeCertB64)).error, '证书签名详情：非法 DER 返回 error');

// —— 真实证书产物：签名值与 PKCS#1 编码块结构校验 ——
if (existsSync(realDerPath)) {
  const info = await certSignatureInfo(readFileSync(realDerPath, 'utf8').trim());
  assert(!info.error, '证书签名详情：真实证书解析成功');
  assert(/^\d+$/.test(info.signature) && /^\d+$/.test(info.encoded), '证书签名详情：输出为十进制大整数');
  // 转回 hex（左补零到模长）后校验结构：RSA-4096 → 512 B → hex 1024 字符
  const sigHex = BigInt(info.signature).toString(16).padStart(1024, '0');
  const emHex = BigInt(info.encoded).toString(16).padStart(1024, '0');
  assert(sigHex.length === 1024 && emHex.length === 1024, '证书签名详情：签名 / 编码块均为 512 字节（模长）');
  assert(emHex.startsWith('0001ff'), '证书签名详情：EM 前缀 00 01 FF（PKCS#1 v1.5）');
  // DigestInfo(SHA-256) 固定位于 digest（末 32 B）之前，其前一字节为 0x00 分隔符
  assert(emHex.slice(-102, -64) === '3031300d060960864801650304020105000420', '证书签名详情：EM 含 DigestInfo(SHA-256)');
  assert(emHex.slice(-104, -102) === '00', '证书签名详情：0x00 分隔符紧邻 DigestInfo');
}

console.log('\n全部测试通过');
