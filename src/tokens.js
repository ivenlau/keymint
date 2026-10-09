/**
 * ADMIN_TOKEN 动态校验：
 * - 配置为普通字符串 → 该字符串即为唯一有效 token
 * - 配置为 http(s):// 文件地址 → 拉取文本文件，每行一个有效 token
 *   （去首尾空白、忽略空行；文件内容缓存约 60 秒；
 *    拉取失败时回退到上一次成功的列表，全部失败才报错）
 */

const TOKEN_CACHE_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

let cache = { source: null, tokens: null, fetchedAt: 0 };
let inflight = null;

export function isTokenFileUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

/** 文本行 → token 列表：剥离 BOM、去首尾空白、忽略空行 */
export function parseTokenLines(text) {
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // 剥离 BOM
  return s
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function fetchTokenFile(url) {
  const res = await fetch(url, {
    method: 'GET',
    // no-cache：强制回源验证，避免中间 CDN 长缓存拖慢 token 换发生效
    headers: { Accept: 'text/plain', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('拉取 token 文件失败：HTTP ' + res.status);
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    throw new Error('token 文件应为纯文本，当前地址返回的是 HTML 页面：' + url);
  }
  const tokens = parseTokenLines(await res.text());
  if (!tokens.length) throw new Error('token 文件为空：' + url);
  return tokens;
}

/**
 * 解析 ADMIN_TOKEN 配置值，返回有效 token 列表。
 * @param {string} configured  普通 token 或 http(s):// 文件地址
 * @returns {Promise<string[]>}
 */
export async function loadAdminTokens(configured) {
  const value = String(configured || '').trim();
  if (!value) return [];
  if (!isTokenFileUrl(value)) return [value];

  const now = Date.now();
  if (cache.tokens && cache.source === value && now - cache.fetchedAt < TOKEN_CACHE_MS) {
    return cache.tokens;
  }

  // 并发请求共用同一次拉取
  if (!inflight) {
    inflight = fetchTokenFile(value)
      .then((tokens) => {
        cache = { source: value, tokens, fetchedAt: Date.now() };
        return tokens;
      })
      .finally(() => {
        inflight = null;
      });
  }

  try {
    return await inflight;
  } catch (err) {
    // 拉取失败：沿用上一次成功的列表（若有），保证文件源抖动不影响签发
    if (cache.tokens && cache.source === value) return cache.tokens;
    throw err;
  }
}
