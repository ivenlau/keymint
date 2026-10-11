/**
 * 安装脚本分发：按 User-Agent 协商，命令行客户端返回脚本、浏览器返回网页。
 *
 * 脚本来源（PS_SCRIPT / SH_SCRIPT）：
 * - 未配置 → 使用内置兜底脚本（assets/，随 Worker 一起部署）
 * - http(s):// 文件地址 → 拉取真实脚本（缓存约 60 秒；
 *   拉取失败沿用上一次成功内容，再不行回退内置脚本，保证安装命令始终可用）
 * - 其他值视为配置错误，忽略并使用内置兜底脚本
 */

import INSTALL_SH from '../assets/install.sh';
import INSTALL_PS1 from '../assets/install.ps1';

const SCRIPT_CACHE_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

const KINDS = {
  ps1: { envVar: 'PS_SCRIPT', fallback: INSTALL_PS1 },
  sh: { envVar: 'SH_SCRIPT', fallback: INSTALL_SH },
};

// 每种脚本各自维护一份远端内容缓存（源地址 + 内容 + 拉取时间）
const cache = { ps1: null, sh: null };
const inflight = { ps1: null, sh: null };

/**
 * 识别命令行客户端（只认确凿的 CLI 工具，其余一律按浏览器处理返回网页）：
 * - PowerShell：UA 含 WindowsPowerShell/5.1 或 PowerShell/7.x（含 Linux/mac 的 pwsh）→ ps1
 * - curl / wget / httpie 等命令行下载器 → sh
 * @param {string} userAgent  请求头 User-Agent
 * @returns {'ps1'|'sh'|null} null 表示浏览器 / 未知客户端
 */
export function detectScriptKind(userAgent) {
  const ua = String(userAgent || '');
  if (/powershell/i.test(ua)) return 'ps1'; // 先于 curl 判断：PowerShell 的 UA 同样含 Mozilla 前缀
  if (/(^|[\s(])(curl|wget|httpie|python-requests|python-urllib|go-http-client|libwww-perl)\//i.test(ua)) {
    return 'sh';
  }
  return null;
}

async function fetchScript(url) {
  const res = await fetch(url, {
    method: 'GET',
    // no-cache：强制回源验证，避免中间 CDN 缓存拖慢脚本更新生效
    headers: { Accept: 'text/plain', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) throw new Error('返回的是 HTML 页面而非脚本');
  const body = await res.text();
  if (!body.trim()) throw new Error('文件为空');
  return body;
}

/**
 * 加载指定类型的安装脚本内容。
 * @param {'ps1'|'sh'} kind
 * @param {object} env  Worker env（.dev.vars / Dashboard 变量）
 * @returns {Promise<string>}
 */
export async function loadInstallScript(kind, env) {
  const spec = KINDS[kind];
  const fallback = spec.fallback;
  const url = String(env[spec.envVar] || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return fallback;

  const now = Date.now();
  if (cache[kind] && cache[kind].source === url && now - cache[kind].fetchedAt < SCRIPT_CACHE_MS) {
    return cache[kind].text;
  }

  // 并发请求共用同一次拉取
  if (!inflight[kind]) {
    inflight[kind] = fetchScript(url)
      .then((body) => {
        cache[kind] = { source: url, text: body, fetchedAt: Date.now() };
        return body;
      })
      .catch((err) => {
        console.warn(`[${spec.envVar}] 拉取失败，回退内置脚本：${err.message}`);
        throw err;
      })
      .finally(() => {
        inflight[kind] = null;
      });
  }

  try {
    return await inflight[kind];
  } catch {
    // 拉取失败：沿用上一次成功的内容（若有），否则回退内置兜底脚本
    if (cache[kind] && cache[kind].source === url) return cache[kind].text;
    return fallback;
  }
}

/** PS1：确保 UTF-8 BOM（Windows PowerShell 5.1 无 BOM 时按 ANSI 解码，中文会乱码） */
export function withUtf8Bom(body) {
  return body.charCodeAt(0) === 0xfeff ? body : '\uFEFF' + body;
}

/** SH：确保无 BOM（shebang 前的 BOM 会让 bash 报错） */
export function withoutUtf8Bom(body) {
  return body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
}
