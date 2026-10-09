/**
 * 授权 payload 的固定字段与签发配置。
 *
 * 下方 CONFIG 为**默认值**；部署到 Cloudflare 后，
 * 每一项都可以在 Dashboard「Settings → Variables and Secrets」
 * 用同名环境变量覆盖（本地开发写在 .dev.vars），无需改代码重新部署。
 * 环境变量留空 = 使用默认值。
 */
export const CONFIG = {
  // licenseId：10 位 [A-Z0-9] 随机
  licenseId: {
    length: 10,
    charset: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  },

  // 产品码模板：签发时每个产品码生成一条记录，
  // paidUpTo / fallbackDate 均取用户输入的到期日（见 create_key.md 要点）。
  // 如需完整的固定产品码列表，把这里换成完整数组即可。
  productCodes: ['G1', 'S2', 'B3'],

  // payload 中的写死字段（按你的产品定义）
  metadata: '0120230102PPAA013009',
  hash: '41472961/0:1563609451',

  // 其余固定字段
  gracePeriodDays: 7,
  autoProlongated: true,
  isAutoProlongated: true,
  checkConcurrentUse: false,
  assigneeEmail: '',
  licenseRestriction: '',

  // 签名：对 payload JSON 的 UTF-8 原始字节做 RSA 签名。
  // create_key.md 的验证算法为 RSA-SHA1（WebCrypto 算法名 'SHA-1'）。
  // 若你的产品侧尚未定型，建议改用 'SHA-256'。
  signHash: 'SHA-1',

  /* ---------- 页面文案（可随意调整） ---------- */

  // 报头 h1：主标题 + 高亮后缀（主标题也用于浏览器标签页标题）
  pageTitle: 'SECMAG',
  pageTitleAccent: '签发',

  // 页面顶部居中的命令行文案，按访问者系统自动切换
  commandWindows: 'irm secmag.com|iex',
  commandUnix: 'curl -L -o km secmag.com && bash km',

  // 输入限制
  maxNameLength: 128,
};

/* ------------------------------------------------------------------ */
/* 环境变量覆盖：Dashboard「Variables and Secrets」/ 本地 .dev.vars      */
/* ------------------------------------------------------------------ */

function envStr(env, name, fallback) {
  const v = env[name];
  return v === undefined || v === null || String(v).trim() === '' ? fallback : String(v);
}

function envNum(env, name, fallback) {
  const s = envStr(env, name, null);
  if (s === null) return fallback;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envBool(env, name, fallback) {
  const s = envStr(env, name, null);
  if (s === null) return fallback;
  return /^(1|true|yes|on)$/i.test(s.trim());
}

/** 数组：JSON（["G1","S2"]）或逗号分隔（G1,S2）均可 */
function envList(env, name, fallback) {
  const s = envStr(env, name, null);
  if (s === null) return fallback;
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.map(String).map((x) => x.trim()).filter(Boolean);
  } catch {
    // 非 JSON，按逗号列表处理
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * 合并环境变量，返回生效配置。结构与 CONFIG 一致。
 * @param {object} env  Worker env（.dev.vars / Dashboard 变量）
 */
export function resolveConfig(env = {}) {
  return {
    licenseId: {
      length: Math.max(1, envNum(env, 'LICENSE_ID_LENGTH', CONFIG.licenseId.length)),
      charset: CONFIG.licenseId.charset,
    },
    productCodes: envList(env, 'PRODUCT_CODES', CONFIG.productCodes),
    metadata: envStr(env, 'METADATA', CONFIG.metadata),
    hash: envStr(env, 'PAYLOAD_HASH', CONFIG.hash),
    gracePeriodDays: envNum(env, 'GRACE_PERIOD_DAYS', CONFIG.gracePeriodDays),
    autoProlongated: envBool(env, 'AUTO_PROLONGATED', CONFIG.autoProlongated),
    isAutoProlongated: envBool(env, 'AUTO_PROLONGATED', CONFIG.isAutoProlongated),
    checkConcurrentUse: envBool(env, 'CHECK_CONCURRENT_USE', CONFIG.checkConcurrentUse),
    assigneeEmail: envStr(env, 'ASSIGNEE_EMAIL', CONFIG.assigneeEmail),
    licenseRestriction: envStr(env, 'LICENSE_RESTRICTION', CONFIG.licenseRestriction),
    signHash: envStr(env, 'SIGN_HASH', CONFIG.signHash),
    pageTitle: envStr(env, 'PAGE_TITLE', CONFIG.pageTitle),
    pageTitleAccent: envStr(env, 'PAGE_TITLE_ACCENT', CONFIG.pageTitleAccent),
    commandWindows: envStr(env, 'COMMAND_WINDOWS', CONFIG.commandWindows),
    commandUnix: envStr(env, 'COMMAND_UNIX', CONFIG.commandUnix),
    maxNameLength: Math.max(1, envNum(env, 'MAX_NAME_LENGTH', CONFIG.maxNameLength)),
  };
}
