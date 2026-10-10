/**
 * Cloudflare Worker：自定义 Key 签发台
 *
 * 路由：
 *   GET  /        签发网页
 *   POST /getKey  签发 key（create_key.md 契约：JSON 入参，纯文本返回）
 *   POST /verify  校验 key（JSON 或纯文本入参，JSON 返回）
 *   GET  /cert    返回签发证书 PEM
 *   GET  /cert/signature  证书签名详情：CA 签名值 + PKCS#1(SHA256(TBS))（十进制）
 *
 * Secrets（wrangler secret put 或本地 .dev.vars）：
 *   SIGNING_KEY_PKCS8_B64   签名私钥（PKCS#8 DER 的 Base64）
 *   CERT_DER_B64            X.509 证书（DER 的 Base64，嵌入每个 key 的 seg3）
 *   PUBLIC_KEY_SPKI_B64     证书公钥（SPKI DER 的 Base64，供 /verify 使用）
 *   ADMIN_TOKEN             可选；配置后 /getKey 需携带访问令牌
 */
import { resolveConfig } from './config.js';
import {
  generateLicenseKey,
  verifyLicenseKey,
  resolveProducts,
  certSignatureInfo,
  derToPem,
} from './license.js';
import { loadAdminTokens } from './tokens.js';

/* ------------------------------ HTTP 辅助 ------------------------------ */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const TEXT_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8' };

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200, env) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(env) },
  });
}

function text(body, status = 200, env, headers = TEXT_HEADERS) {
  return new Response(body, { status, headers: { ...headers, ...corsHeaders(env) } });
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/**
 * ADMIN_TOKEN 支持两种配置（见 src/tokens.js）：
 * - 普通字符串：即为唯一有效 token
 * - http(s):// 文件地址：文本文件每行一个有效 token（缓存约 60 秒）
 */
async function checkAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return true;
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const headerToken = request.headers.get('x-admin-token') || '';
  const presented = [bearer, headerToken].filter(Boolean);
  if (!presented.length) return false;
  const tokens = await loadAdminTokens(env.ADMIN_TOKEN);
  return presented.some((t) => tokens.includes(t));
}

function requireKeys(env) {
  if (!env.SIGNING_KEY_PKCS8_B64 || !env.CERT_DER_B64) {
    throw new Error(
      '服务端未配置 SIGNING_KEY_PKCS8_B64 / CERT_DER_B64，请先运行 scripts/gen-keys.sh 并写入 secrets',
    );
  }
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/* ------------------------------ 路由处理 ------------------------------ */

async function handleGetKey(request, env) {
  if (!(await checkAdmin(request, env))) {
    return json({ error: '未授权：ADMIN_TOKEN 不匹配' }, 401, env);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体需为 JSON' }, 400, env);
  }

  const licenseeName = String(body.licenseeName || '').trim();
  const assigneeName = String(body.assigneeName || '').trim();
  const expiryDate = String(body.expiryDate || '').trim();
  const cfg = resolveConfig(env);

  if (!licenseeName || !assigneeName) {
    return json({ error: 'licenseeName / assigneeName 不能为空' }, 400, env);
  }
  if (licenseeName.length > cfg.maxNameLength || assigneeName.length > cfg.maxNameLength) {
    return json({ error: '名称过长（最多 ' + cfg.maxNameLength + ' 字符）' }, 400, env);
  }
  if (!isValidDate(expiryDate)) {
    return json({ error: 'expiryDate 需为合法的 YYYY-MM-DD' }, 400, env);
  }

  const resolved = resolveProducts(body, cfg);
  if (resolved.error) return json({ error: resolved.error }, 400, env);

  requireKeys(env);

  const key = await generateLicenseKey(
    { licenseeName, assigneeName, expiryDate, products: resolved.products },
    {
      signingKeyPkcs8B64: env.SIGNING_KEY_PKCS8_B64,
      certDerB64: env.CERT_DER_B64,
    },
    cfg,
  );

  // create_key.md 契约：const authCode = await response.text();
  return text(key, 200, env);
}

async function handleVerify(request, env) {
  let key = '';
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: '请求体需为 JSON' }, 400, env);
    }
    key = String(body.key || '');
  } else {
    key = await request.text();
  }

  if (!key.trim()) return json({ valid: false, error: '缺少 key' }, 400, env);
  if (!env.PUBLIC_KEY_SPKI_B64) {
    return json({ error: '服务端未配置 PUBLIC_KEY_SPKI_B64' }, 500, env);
  }

  const result = await verifyLicenseKey(key, env.PUBLIC_KEY_SPKI_B64, resolveConfig(env));
  return json(result, result.valid ? 200 : 422, env);
}

function handleCert(env) {
  if (!env.CERT_DER_B64) return text('未配置 CERT_DER_B64', 500, env);
  return text(derToPem(env.CERT_DER_B64, 'CERTIFICATE'), 200, env);
}

async function handleCertSignature(env) {
  if (!env.CERT_DER_B64) return json({ error: '服务端未配置 CERT_DER_B64' }, 500, env);
  const info = await certSignatureInfo(env.CERT_DER_B64);
  if (info.error) return json({ error: info.error }, 500, env);
  // 签名：证书 CA 签名值；密文：PKCS#1(SHA256(TBS))。均为十进制大整数字符串
  return json(info, 200, env);
}

/* 浏览器标签页图标：报头印章的 favicon 版（描边加粗，16px 下依然清晰） */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
  <rect width="120" height="120" rx="24" fill="#100d0a"/>
  <circle cx="60" cy="60" r="52" fill="none" stroke="#e3a44b" stroke-opacity="0.5" stroke-width="3"/>
  <circle cx="60" cy="60" r="42" fill="none" stroke="#e3a44b" stroke-opacity="0.3" stroke-width="2.5" stroke-dasharray="4 7"/>
  <circle cx="60" cy="60" r="31" fill="none" stroke="#e3a44b" stroke-opacity="0.75" stroke-width="4"/>
  <g stroke="#e3a44b" stroke-opacity="0.8" stroke-width="4" stroke-linecap="round">
    <line x1="60" y1="10" x2="60" y2="20"/>
    <line x1="60" y1="100" x2="60" y2="110"/>
    <line x1="10" y1="60" x2="20" y2="60"/>
    <line x1="100" y1="60" x2="110" y2="60"/>
  </g>
  <text x="60" y="57" text-anchor="middle" fill="#e3a44b" font-family="monospace" font-size="15" font-weight="600" letter-spacing="1">RSA</text>
  <text x="60" y="74" text-anchor="middle" fill="#f0e7d4" fill-opacity="0.85" font-family="monospace" font-size="11" letter-spacing="2">4096</text>
</svg>`;

function handleIcon() {
  return new Response(FAVICON_SVG, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

function handlePage(env) {
  const cfg = resolveConfig(env);
  const spec = {
    signHash: cfg.signHash,
    authRequired: Boolean(env.ADMIN_TOKEN),
    productCodes: cfg.productCodes,
    commandWindows: cfg.commandWindows,
    commandUnix: cfg.commandUnix,
  };
  const html = HTML_PAGE
    .replace(/__UI_TITLE__/g, escapeHtml(cfg.pageTitle))
    .replace(/__UI_ACCENT__/g, escapeHtml(cfg.pageTitleAccent))
    // 将小于号转义为 \\u003c（JSON 转义序列），防止配置文本意外闭合 script 标签
    .replace('/*__SPEC__*/{}', JSON.stringify(spec).replace(/</g, '\\u003c'));
  return text(html, 200, env, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

/* ------------------------------ Worker 入口 ------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      if (url.pathname === '/' && request.method === 'GET') return handlePage(env);
      if (url.pathname === '/favicon.svg') return handleIcon();
      if (url.pathname === '/getKey' && request.method === 'POST') return handleGetKey(request, env);
      if (url.pathname === '/verify' && request.method === 'POST') return handleVerify(request, env);
      if (url.pathname === '/cert' && request.method === 'GET') return handleCert(env);
      if (url.pathname === '/cert/signature' && request.method === 'GET') {
        return handleCertSignature(env);
      }
      return json({ error: 'not found' }, 404, env);
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500, env);
    }
  },
};

/* ------------------------------ 页面 ------------------------------ */
/* 注：页面脚本内避免使用模板字符串/`${`，以免与此模板字面量冲突。 */

const HTML_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__UI_TITLE__ 签发台 · KEY MINT</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #100d0a;
  --panel: #191410;
  --panel-2: #0b0906;
  --ink: #f0e7d4;
  --muted: #a2947b;
  --faint: #6f6552;
  --amber: #e3a44b;
  --amber-2: #f2c27a;
  --green: #86b878;
  --red: #c6574b;
  --line: rgba(240, 231, 212, 0.14);
  --line-2: rgba(240, 231, 212, 0.28);
  --mono: "IBM Plex Mono", "Noto Sans SC", ui-monospace, monospace;
  --display: "Syne", "Noto Sans SC", sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { background: var(--bg); }
body {
  font-family: var(--mono);
  color: var(--ink);
  min-height: 100vh;
  background:
    radial-gradient(1100px 520px at 88% -12%, rgba(227, 164, 75, 0.10), transparent 60%),
    radial-gradient(900px 620px at -12% 112%, rgba(134, 184, 120, 0.05), transparent 55%),
    var(--bg);
  -webkit-font-smoothing: antialiased;
}
.grain::after {
  content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 50; opacity: 0.055;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 52px 28px 72px; }

/* ---------- 滚动条（适配页面风格） ---------- */
.keybox, .multi-panel, .cmdline-text, .modal-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgba(240, 231, 212, 0.25) transparent;
}
.keybox::-webkit-scrollbar, .multi-panel::-webkit-scrollbar, .cmdline-text::-webkit-scrollbar, .modal-scroll::-webkit-scrollbar {
  width: 10px; height: 8px;
}
.keybox::-webkit-scrollbar-track, .multi-panel::-webkit-scrollbar-track, .cmdline-text::-webkit-scrollbar-track, .modal-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.keybox::-webkit-scrollbar-thumb, .multi-panel::-webkit-scrollbar-thumb, .cmdline-text::-webkit-scrollbar-thumb, .modal-scroll::-webkit-scrollbar-thumb {
  background: rgba(240, 231, 212, 0.22); border: 2px solid transparent; background-clip: padding-box;
}
.keybox::-webkit-scrollbar-thumb:hover, .multi-panel::-webkit-scrollbar-thumb:hover, .cmdline-text::-webkit-scrollbar-thumb:hover, .modal-scroll::-webkit-scrollbar-thumb:hover {
  background: rgba(227, 164, 75, 0.55); background-clip: padding-box;
}

/* ---------- 报头 ---------- */
.masthead { border-bottom: 1px solid var(--line); padding-bottom: 30px; }
.mast-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 28px; }
.kicker { color: var(--amber); font-size: 11px; letter-spacing: 0.38em; margin-bottom: 14px; }
h1 {
  font-family: var(--display); font-weight: 800;
  font-size: clamp(36px, 5.4vw, 62px); line-height: 1.02; letter-spacing: -0.01em;
}
h1 em { font-style: normal; color: var(--amber); }
.mast-meta {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
  margin-top: 22px; font-size: 11px; letter-spacing: 0.22em; color: var(--muted);
}
.mast-meta .dot { color: var(--amber); font-size: 8px; }
.seal { width: 108px; height: 108px; flex: none; }
.seal .ring { transform-origin: 60px 60px; animation: spin 48s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- 顶部命令行 ---------- */
.cmdline { display: flex; justify-content: center; margin-top: 32px; }
.cmdline-box {
  display: flex; align-items: center; gap: 14px;
  width: min(780px, 100%);
  background: var(--panel-2); border: 1px solid var(--line); border-left: 1px solid var(--amber);
  padding: 12px 12px 12px 16px;
}
.cmdline-idx {
  color: var(--amber); font-size: 10px; letter-spacing: 0.3em; flex: none;
  padding-right: 14px; border-right: 1px solid var(--line-2);
}
.cmdline-prompt { color: var(--amber); font: 500 13px/1.4 var(--mono); flex: none; }
.cmdline-text {
  font: 500 13px/1.4 var(--mono); color: var(--ink);
  white-space: nowrap; overflow-x: auto;
}
.cmdline-actions { display: flex; align-items: center; gap: 12px; flex: none; margin-left: auto; }
.os-switch { display: flex; border: 1px solid var(--line-2); }
.os-btn {
  background: transparent; border: 0; color: var(--muted);
  font: 500 10px/1 var(--mono); letter-spacing: 0.12em; padding: 8px 10px;
  cursor: pointer; transition: color 0.15s, background 0.15s;
}
.os-btn + .os-btn { border-left: 1px solid var(--line-2); }
.os-btn:hover { color: var(--amber); }
.os-btn.active { background: var(--amber); color: #14100a; }
.cmdline-copy { padding: 9px 13px; flex: none; }

/* ---------- 面板 ---------- */
.layout {
  display: grid; grid-template-columns: minmax(320px, 5fr) minmax(360px, 7fr);
  gap: 28px; margin-top: 34px; align-items: stretch;
}
.panel {
  position: relative;
  background: linear-gradient(180deg, rgba(25, 20, 16, 0.94), rgba(18, 14, 10, 0.94));
  border: 1px solid var(--line);
  padding: 30px;
}
.panel::before, .panel::after {
  content: ""; position: absolute; width: 12px; height: 12px; pointer-events: none;
}
.panel::before { top: -1px; left: -1px; border-top: 1px solid var(--amber); border-left: 1px solid var(--amber); }
.panel::after { bottom: -1px; right: -1px; border-bottom: 1px solid var(--amber); border-right: 1px solid var(--amber); }
.panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
.panel-head h2 { font-family: var(--display); font-weight: 700; font-size: 22px; letter-spacing: 0.02em; }
.idx { color: var(--amber); font-size: 10px; letter-spacing: 0.3em; }

/* ---------- 表单 ---------- */
.form-panel { display: flex; flex-direction: column; }
.form-panel form { display: flex; flex-direction: column; flex: 1; }
.field { display: block; margin-top: 24px; }
.field-top { display: flex; align-items: baseline; gap: 10px; margin-bottom: 9px; }
.num { color: var(--amber); font-size: 11px; letter-spacing: 0.15em; }
.field-name { font-size: 11px; letter-spacing: 0.22em; color: var(--muted); }
.opt {
  margin-left: auto; font-size: 10px; color: var(--faint);
  border: 1px solid var(--line); padding: 2px 8px; letter-spacing: 0.15em;
}
input {
  width: 100%; background: rgba(240, 231, 212, 0.03); border: 1px solid var(--line);
  color: var(--ink); font: 500 15px/1.4 var(--mono); padding: 13px 14px;
  outline: none; transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
}
input:focus {
  border-color: var(--amber); box-shadow: 0 0 0 3px rgba(227, 164, 75, 0.14);
  background: rgba(227, 164, 75, 0.05);
}
input::placeholder { color: var(--faint); }
input[type="date"] { color-scheme: dark; }

/* ---------- 产品多选下拉 ---------- */
.multi { position: relative; }
.multi-trigger {
  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 10px;
  background: rgba(240, 231, 212, 0.03); border: 1px solid var(--line); color: var(--ink);
  font: 500 15px/1.4 var(--mono); padding: 13px 14px; cursor: pointer; text-align: left;
  transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
}
.multi-trigger:hover, .multi.open .multi-trigger {
  border-color: var(--amber); box-shadow: 0 0 0 3px rgba(227, 164, 75, 0.14);
  background: rgba(227, 164, 75, 0.05);
}
.multi-caret { color: var(--amber); font-size: 11px; transition: transform 0.2s; flex: none; }
.multi.open .multi-caret { transform: rotate(180deg); }
.multi-panel {
  position: absolute; z-index: 30; top: calc(100% + 6px); left: 0; right: 0;
  background: var(--panel-2); border: 1px solid var(--line-2);
  max-height: 216px; overflow-y: auto; padding: 6px;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
}
.multi-opt {
  display: flex; align-items: center; gap: 11px; padding: 9px 10px; cursor: pointer;
  font-size: 13px; color: var(--muted); letter-spacing: 0.06em;
  transition: background 0.15s, color 0.15s;
}
.multi-opt:hover { background: rgba(227, 164, 75, 0.08); color: var(--ink); }
.multi-opt input[type="checkbox"] {
  appearance: none; -webkit-appearance: none;
  width: 15px; height: 15px; flex: none; padding: 0; margin: 0;
  background: transparent; border: 1px solid var(--line-2); cursor: pointer;
  position: relative; transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.multi-opt input[type="checkbox"]:hover { border-color: var(--amber); }
.multi-opt input[type="checkbox"]:checked {
  background: var(--amber); border-color: var(--amber); box-shadow: none;
}
.multi-opt input[type="checkbox"]:checked::after {
  content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px;
  border: solid #14100a; border-width: 0 2px 2px 0; transform: rotate(45deg);
}
.multi-opt input[type="checkbox"]:focus-visible {
  outline: none; box-shadow: 0 0 0 3px rgba(227, 164, 75, 0.14);
}
.multi-all { color: var(--ink); font-size: 12px; letter-spacing: 0.12em; }
.multi-divider { height: 1px; background: var(--line); margin: 4px 6px; }
.multi-opt-main { display: flex; align-items: center; gap: 11px; flex: 1; min-width: 0; cursor: pointer; }
.multi-opt-custom { padding-right: 4px; }
.multi-tag {
  font-size: 9px; letter-spacing: 0.12em; color: var(--amber);
  border: 1px solid rgba(227, 164, 75, 0.45); padding: 1px 6px; margin-left: auto; flex: none;
}
.multi-del {
  background: transparent; border: 0; color: var(--faint); flex: none;
  font-size: 15px; line-height: 1; padding: 4px 6px; cursor: pointer; transition: color 0.15s;
}
.multi-del:hover { color: var(--red); }
.multi-add { display: flex; gap: 8px; padding: 6px 4px 4px; }
.multi-add input { flex: 1; width: auto; padding: 8px 10px; font-size: 12px; }
.multi-add .btn-ghost { padding: 8px 12px; letter-spacing: 0.1em; flex: none; }

.form-foot { margin-top: auto; padding-top: 30px; }
.btn-mint {
  width: 100%; padding: 17px 20px;
  background: var(--amber); color: #14100a; border: 0;
  font: 600 14px/1 var(--mono); letter-spacing: 0.35em; text-indent: 0.35em;
  cursor: pointer; position: relative; overflow: hidden;
  transition: transform 0.15s, box-shadow 0.2s, background 0.2s;
}
.btn-mint:hover { background: var(--amber-2); transform: translateY(-2px); box-shadow: 0 12px 32px rgba(227, 164, 75, 0.28); }
.btn-mint:active { transform: translateY(0); }
.btn-mint:disabled { opacity: 0.5; cursor: wait; transform: none; box-shadow: none; }
.btn-mint::after {
  content: ""; position: absolute; top: 0; left: -80%; width: 40%; height: 100%;
  background: linear-gradient(100deg, transparent, rgba(255, 255, 255, 0.4), transparent);
  transform: skewX(-20deg); transition: left 0.55s;
}
.btn-mint:hover::after { left: 130%; }

.status { margin-top: 15px; min-height: 18px; font-size: 12px; letter-spacing: 0.06em; color: var(--muted); }
.status.ok { color: var(--green); }
.status.err { color: var(--red); }

/* ---------- 分段详情 ---------- */
.anatomy { margin-top: 12px; }
.seg-row {
  display: grid; grid-template-columns: 64px 132px 1fr 92px;
  align-items: center; gap: 14px;
  padding: 13px 2px; border-bottom: 1px solid var(--line); font-size: 12px;
}
.seg-badge {
  border: 1px solid var(--line-2); color: var(--muted); text-align: center;
  padding: 4px 0; font-size: 10px; letter-spacing: 0.12em;
}
.seg-row[data-seg="0"] .seg-badge { color: var(--amber); border-color: rgba(227, 164, 75, 0.55); }
.seg-row[data-seg="2"] .seg-badge { color: var(--green); border-color: rgba(134, 184, 120, 0.55); }
.seg-row[data-seg="3"] .seg-badge { color: var(--red); border-color: rgba(198, 87, 75, 0.55); }
.seg-role { color: var(--muted); letter-spacing: 0.08em; }
.seg-val { color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seg-len { text-align: right; color: var(--ink); font-variant-numeric: tabular-nums; }

.keybox-wrap { margin-top: 24px; }
.keybox-head {
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;
  font-size: 10px; letter-spacing: 0.3em; color: var(--faint);
}
.keybox {
  height: 190px;
  background: var(--panel-2); border: 1px solid var(--line); border-left: 3px solid var(--amber);
  padding: 16px 18px; font: 400 11px/1.9 var(--mono); color: var(--ink);
  word-break: break-all; white-space: pre-wrap; overflow: auto;
}
.keybox.empty { color: var(--faint); border-left-color: var(--line-2); }

.btn-ghost {
  background: transparent; border: 1px solid var(--line-2); color: var(--ink);
  font: 500 11px/1 var(--mono); letter-spacing: 0.15em; padding: 10px 14px;
  cursor: pointer; transition: border-color 0.2s, color 0.2s, background 0.2s;
}
.btn-ghost:hover:not(:disabled) { border-color: var(--amber); color: var(--amber); background: rgba(227, 164, 75, 0.07); }
.btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }

/* ---------- 校验 ---------- */
.verify-strip { margin-top: 28px; border-top: 1px solid var(--line); padding-top: 22px; }
.verify-head {
  display: flex; gap: 12px; align-items: baseline;
  font-size: 11px; letter-spacing: 0.22em; color: var(--muted); margin-bottom: 13px;
}
.verify-row { display: flex; gap: 10px; }
.verify-row input { flex: 1; padding: 11px 12px; font-size: 12px; }

/* ---------- /cert 签名弹窗 ---------- */
.modal {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center; padding: 22px;
}
.modal[hidden] { display: none; }
.modal-mask {
  position: absolute; inset: 0;
  background: rgba(11, 9, 6, 0.8); backdrop-filter: blur(5px);
}
.modal-panel {
  position: relative; width: min(840px, 100%); max-height: min(88vh, 800px);
  display: flex; flex-direction: column; padding: 28px 30px 24px;
  background: linear-gradient(180deg, rgba(25, 20, 16, 0.97), rgba(18, 14, 10, 0.97));
  border: 1px solid var(--line);
  box-shadow: 0 30px 90px rgba(0, 0, 0, 0.6);
  animation: rise 0.35s cubic-bezier(0.2, 0.7, 0.2, 1);
}
/* 滚动只发生在这一层：面板本体不设 overflow，避免角标出角 1px 触发面板滚动条 */
.modal-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.modal-panel::before, .modal-panel::after {
  content: ""; position: absolute; width: 12px; height: 12px; pointer-events: none;
}
.modal-panel::before { top: -1px; left: -1px; border-top: 1px solid var(--amber); border-left: 1px solid var(--amber); }
.modal-panel::after { bottom: -1px; right: -1px; border-bottom: 1px solid var(--amber); border-right: 1px solid var(--amber); }
.modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.modal-head .idx { display: block; margin-bottom: 8px; }
.modal-head h2 { font-family: var(--display); font-weight: 700; font-size: 22px; letter-spacing: 0.02em; }
.modal-close {
  background: transparent; border: 1px solid var(--line-2); color: var(--muted);
  width: 32px; height: 32px; flex: none; font: 400 16px/1 var(--mono);
  cursor: pointer; transition: color 0.15s, border-color 0.15s;
}
.modal-close:hover { color: var(--red); border-color: var(--red); }
.modal-sub { margin-top: 8px; font-size: 11px; color: var(--faint); letter-spacing: 0.06em; }
.sig-block .field-top { flex-wrap: wrap; row-gap: 8px; }
.sig-block .opt { letter-spacing: 0.08em; }
.sig-block .btn-ghost { margin-left: 10px; padding: 6px 10px; font-size: 10px; flex: none; }
.sig-box { height: auto; margin-top: 2px; font-size: 10px; line-height: 1.7; overflow: hidden; }
.sig-box.empty { color: var(--faint); border-left-color: var(--line-2); }

/* ---------- 页脚 ---------- */
footer {
  border-top: 1px solid var(--line); margin-top: 52px; padding-top: 22px;
  display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  font-size: 11px; color: var(--faint); letter-spacing: 0.1em;
}
footer a { color: var(--muted); text-decoration: none; border-bottom: 1px dashed var(--line-2); }
footer a:hover { color: var(--amber); }

/* ---------- 入场动画 ---------- */
.reveal { opacity: 0; transform: translateY(16px); animation: rise 0.8s cubic-bezier(0.2, 0.7, 0.2, 1) forwards; }
@keyframes rise { to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .reveal { animation: none; opacity: 1; transform: none; }
  .seal .ring { animation: none; }
  .btn-mint::after { display: none; }
  .modal-panel { animation: none; }
}
@media (max-width: 920px) {
  .layout { grid-template-columns: 1fr; }
  .mast-top { flex-direction: column-reverse; }
}
</style>
</head>
<body class="grain">
<div class="wrap">

  <header class="masthead reveal">
    <div class="mast-top">
      <div>
        <div class="kicker">KEY MINT · 签发台</div>
        <h1>__UI_TITLE__ <em>__UI_ACCENT__</em></h1>
      </div>
      <svg class="seal" viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="56" fill="none" stroke="rgba(227,164,75,0.5)" stroke-width="1"/>
        <circle class="ring" cx="60" cy="60" r="46" fill="none" stroke="rgba(227,164,75,0.3)" stroke-width="1" stroke-dasharray="2 5"/>
        <circle cx="60" cy="60" r="34" fill="none" stroke="rgba(227,164,75,0.55)" stroke-width="1.5"/>
        <g stroke="rgba(227,164,75,0.65)" stroke-width="1.5">
          <line x1="60" y1="6" x2="60" y2="16"/><line x1="60" y1="104" x2="60" y2="114"/>
          <line x1="6" y1="60" x2="16" y2="60"/><line x1="104" y1="60" x2="114" y2="60"/>
        </g>
        <text x="60" y="57" text-anchor="middle" fill="#e3a44b" font-family="IBM Plex Mono, monospace" font-size="13" letter-spacing="1">RSA</text>
        <text x="60" y="73" text-anchor="middle" fill="rgba(240,231,212,0.75)" font-family="IBM Plex Mono, monospace" font-size="10" letter-spacing="2">4096</text>
      </svg>
    </div>
    <div class="mast-meta">
      <span>四段式 KEY</span><span class="dot">◆</span>
      <span>RSA-4096</span><span class="dot">◆</span>
      <span id="mast-alg">RSA-SHA1</span><span class="dot">◆</span>
      <span>X.509</span><span class="dot">◆</span>
      <span>SERVICE-SIDE MINT</span>
    </div>
  </header>

  <div class="cmdline reveal" style="animation-delay:.04s">
    <div class="cmdline-box">
      <span class="cmdline-idx">CMD / 01</span>
      <span class="cmdline-prompt">❯</span>
      <code class="cmdline-text" id="cmd-text"></code>
      <div class="cmdline-actions">
        <div class="os-switch" id="os-switch">
          <button type="button" class="os-btn" data-os="windows">WINDOWS</button>
          <button type="button" class="os-btn" data-os="unix">LINUX · MAC</button>
        </div>
        <button type="button" class="btn-ghost cmdline-copy" id="cmd-copy">复制命令</button>
      </div>
    </div>
  </div>

  <main class="layout">

    <section class="panel form-panel reveal" style="animation-delay:.08s">
      <div class="panel-head"><span class="idx">FORM / 02</span><h2>签发参数</h2></div>
      <form id="issue-form" autocomplete="off">
        <div class="field">
          <div class="field-top"><span class="num">01</span><span class="field-name">产品 / PRODUCTS</span></div>
          <div class="multi" id="product-multi">
            <button type="button" class="multi-trigger" id="product-trigger" aria-expanded="false" aria-haspopup="listbox">
              <span id="product-label">已选全部</span>
              <span class="multi-caret">▼</span>
            </button>
            <div class="multi-panel" id="product-panel" hidden>
              <label class="multi-opt multi-all">
                <input type="checkbox" id="product-all">
                <span>全选 / ALL</span>
              </label>
              <div class="multi-divider"></div>
              <div class="multi-list" id="product-list"></div>
              <div class="multi-divider"></div>
              <div class="multi-add">
                <input id="product-custom-input" maxlength="64" placeholder="自定义产品码，回车添加">
                <button type="button" class="btn-ghost" id="product-add-btn">添加</button>
              </div>
            </div>
          </div>
        </div>
        <label class="field">
          <div class="field-top"><span class="num">02</span><span class="field-name">被许可人 / LICENSEE</span></div>
          <input name="licenseeName" maxlength="128" required placeholder="Licensed To">
        </label>
        <label class="field">
          <div class="field-top"><span class="num">03</span><span class="field-name">被分配人 / ASSIGNEE</span></div>
          <input name="assigneeName" maxlength="128" required placeholder="Assignee Group">
        </label>
        <label class="field">
          <div class="field-top"><span class="num">04</span><span class="field-name">到期日 / EXPIRY</span></div>
          <input name="expiryDate" type="date" required value="2026-12-31">
        </label>
        <label class="field" id="token-field" hidden>
          <div class="field-top"><span class="num">05</span><span class="field-name">访问令牌 / TOKEN</span><span class="opt">ADMIN_TOKEN</span></div>
          <input name="token" type="password" placeholder="本服务已开启访问令牌">
        </label>
        <div class="form-foot">
          <button class="btn-mint" type="submit"><span>签 发 K E Y</span></button>
          <p class="status" id="issue-status" role="status"></p>
        </div>
      </form>
    </section>

    <section class="panel reveal" style="animation-delay:.16s">
      <div class="panel-head"><span class="idx">FORM / 03</span><h2>KEY 分段详情</h2></div>
      <div class="anatomy" id="anatomy">
        <div class="seg-row" data-seg="0"><span class="seg-badge">SEG 0</span><span class="seg-role">licenseId</span><span class="seg-val">等待签发…</span><span class="seg-len">—</span></div>
        <div class="seg-row" data-seg="1"><span class="seg-badge">SEG 1</span><span class="seg-role">payload JSON</span><span class="seg-val">等待签发…</span><span class="seg-len">—</span></div>
        <div class="seg-row" data-seg="2"><span class="seg-badge">SEG 2</span><span class="seg-role">RSA 签名</span><span class="seg-val">等待签发…</span><span class="seg-len">—</span></div>
        <div class="seg-row" data-seg="3"><span class="seg-badge">SEG 3</span><span class="seg-role">X.509 证书</span><span class="seg-val">等待签发…</span><span class="seg-len">—</span></div>
      </div>

      <div class="keybox-wrap">
        <div class="keybox-head">
          <span>ISSUED KEY</span>
          <button type="button" class="btn-ghost" id="copy-btn" disabled>复制完整 KEY</button>
        </div>
        <pre class="keybox empty" id="key-output">等待签发…</pre>
      </div>

      <div class="verify-strip">
        <div class="verify-head"><span class="idx">CHECK / 04</span><span>签名校验 / VERIFY</span></div>
        <div class="verify-row">
          <input id="verify-input" placeholder="粘贴 KEY 以校验签名与 payload">
          <button type="button" class="btn-ghost" id="verify-btn">校验</button>
        </div>
        <p class="status" id="verify-status" role="status"></p>
      </div>
    </section>

  </main>

  <footer>
    <span>KEY MINT · <a href="/cert/signature" id="cert-sig-link">/cert 签名</a></span>
    <span id="foot-note">步骤：命令安装 · 签发KEY · 复制KEY · 使用KEY</span>
  </footer>

</div>

<div class="modal" id="cert-modal" hidden>
  <div class="modal-mask" data-close></div>
  <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="cert-modal-title">
    <div class="modal-head">
      <div>
        <span class="idx">CERT / 05</span>
        <h2 id="cert-modal-title">/cert 签名</h2>
      </div>
      <button type="button" class="modal-close" data-close aria-label="关闭">×</button>
    </div>
    <p class="modal-sub">来源：seg3 证书 · RSA 公钥还原签名值即得密文（PKCS#1 编码块）</p>

    <div class="modal-scroll">
    <div class="field sig-block">
      <div class="field-top">
        <span class="num">01</span>
        <span class="field-name">签名 / SIGNATURE</span>
        <span class="opt">证书CA签名值 · 十进制</span>
        <button type="button" class="btn-ghost sig-copy" data-target="sig-value">复制</button>
      </div>
      <pre class="keybox sig-box empty" id="sig-value">加载中…</pre>
    </div>

    <div class="field sig-block">
      <div class="field-top">
        <span class="num">02</span>
        <span class="field-name">密文 / CIPHERTEXT</span>
        <span class="opt">PKCS#1(SHA256(TBS))</span>
        <button type="button" class="btn-ghost sig-copy" data-target="enc-value">复制</button>
      </div>
      <pre class="keybox sig-box empty" id="enc-value">加载中…</pre>
    </div>

    <p class="status" id="cert-status" role="status"></p>
    </div>
  </div>
</div>

<script>
(function () {
  "use strict";
  var SPEC = /*__SPEC__*/{};

  var form = document.getElementById("issue-form");
  var statusEl = document.getElementById("issue-status");
  var keyOut = document.getElementById("key-output");
  var copyBtn = document.getElementById("copy-btn");
  var verifyInput = document.getElementById("verify-input");
  var verifyBtn = document.getElementById("verify-btn");
  var verifyStatus = document.getElementById("verify-status");
  var lastKey = "";

  if (SPEC) {
    document.getElementById("mast-alg").textContent = "RSA-" + SPEC.signHash;
    if (SPEC.authRequired) document.getElementById("token-field").hidden = false;
  }

  /* ---- 顶部命令行：默认显示当前系统，可手动切换 ---- */
  var CMD_BY_OS = {
    windows: SPEC.commandWindows || "",
    unix: SPEC.commandUnix || ""
  };
  var isWindows = /Win/i.test(navigator.platform || "") ||
    /Windows/i.test(navigator.userAgent) ||
    (navigator.userAgentData && navigator.userAgentData.platform === "Windows");
  var cmd = "";

  var osBtns = document.querySelectorAll(".os-btn");
  function setCmdOs(os) {
    cmd = CMD_BY_OS[os] || "";
    document.getElementById("cmd-text").textContent = cmd;
    for (var i = 0; i < osBtns.length; i++) {
      osBtns[i].classList.toggle("active", osBtns[i].getAttribute("data-os") === os);
    }
  }
  setCmdOs(isWindows ? "windows" : "unix");
  for (var i = 0; i < osBtns.length; i++) {
    (function (btn) {
      btn.addEventListener("click", function () { setCmdOs(btn.getAttribute("data-os")); });
    })(osBtns[i]);
  }

  /* ---- 产品多选下拉（配置目录 + 全选 + 自定义编码） ---- */
  var multi = document.getElementById("product-multi");
  var multiTrigger = document.getElementById("product-trigger");
  var multiPanel = document.getElementById("product-panel");
  var productList = document.getElementById("product-list");
  var productAll = document.getElementById("product-all");
  var customInput = document.getElementById("product-custom-input");

  (SPEC.productCodes || []).forEach(function (code) {
    var opt = document.createElement("label");
    opt.className = "multi-opt";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.name = "products";
    cb.value = code;
    cb.checked = true;
    var span = document.createElement("span");
    span.textContent = code;
    opt.appendChild(cb);
    opt.appendChild(span);
    productList.appendChild(opt);
  });

  function productCheckboxes() {
    return productList.querySelectorAll("input[name='products']");
  }

  function selectedProducts() {
    var boxes = productCheckboxes();
    var out = [];
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) out.push(boxes[i].value);
    return out;
  }

  function updateProductLabel() {
    var sel = selectedProducts();
    var label = document.getElementById("product-label");
    if (sel.length === 0) label.textContent = "未选择产品";
    else if (sel.length <= 3) label.textContent = sel.join(" / ");
    else label.textContent = "已选 " + sel.length + " 项";

    // 全选框三态：全选 / 半选 / 全不选
    var boxes = productCheckboxes();
    var checkedCount = 0;
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) checkedCount++;
    productAll.checked = boxes.length > 0 && checkedCount === boxes.length;
    productAll.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
  }
  updateProductLabel();

  productAll.addEventListener("change", function () {
    var boxes = productCheckboxes();
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = productAll.checked;
    updateProductLabel();
  });

  /** 添加自定义产品码（目录外）；重复则直接勾选已有项 */
  function addCustomProduct(rawCode) {
    var code = String(rawCode || "").trim();
    if (!code || code.length > 64) return false;
    var boxes = productCheckboxes();
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].value === code) {
        boxes[i].checked = true;
        updateProductLabel();
        return true;
      }
    }
    var opt = document.createElement("div");
    opt.className = "multi-opt multi-opt-custom";
    var main = document.createElement("label");
    main.className = "multi-opt-main";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.name = "products";
    cb.value = code;
    cb.checked = true;
    var span = document.createElement("span");
    span.textContent = code;
    var tag = document.createElement("span");
    tag.className = "multi-tag";
    tag.textContent = "自定义";
    main.appendChild(cb);
    main.appendChild(span);
    main.appendChild(tag);
    var del = document.createElement("button");
    del.type = "button";
    del.className = "multi-del";
    del.textContent = "×";
    del.addEventListener("click", function (e) {
      e.preventDefault();
      opt.parentNode.removeChild(opt);
      updateProductLabel();
    });
    opt.appendChild(main);
    opt.appendChild(del);
    productList.appendChild(opt);
    updateProductLabel();
    return true;
  }

  function tryAddCustom() {
    if (addCustomProduct(customInput.value)) customInput.value = "";
  }
  document.getElementById("product-add-btn").addEventListener("click", tryAddCustom);
  customInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); tryAddCustom(); }
  });

  multiTrigger.addEventListener("click", function () {
    var open = multi.classList.toggle("open");
    multiPanel.hidden = !open;
    multiTrigger.setAttribute("aria-expanded", String(open));
  });
  multiPanel.addEventListener("change", function (e) {
    if (e.target && e.target.id === "product-all") return; // 全选已单独处理
    updateProductLabel();
  });
  document.addEventListener("click", function (e) {
    if (!multi.contains(e.target)) {
      multi.classList.remove("open");
      multiPanel.hidden = true;
      multiTrigger.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && multi.classList.contains("open")) {
      multi.classList.remove("open");
      multiPanel.hidden = true;
      multiTrigger.setAttribute("aria-expanded", "false");
      multiTrigger.focus();
    }
  });

  function setStatus(el, msg, kind) {
    el.textContent = msg;
    el.className = "status" + (kind ? " " + kind : "");
  }

  function copyText(textToCopy, btn, label) {
    var done = function () {
      btn.textContent = "已复制 ✓";
      setTimeout(function () { btn.textContent = label; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(textToCopy).then(done, done);
    } else {
      var ta = document.createElement("textarea");
      ta.value = textToCopy;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta);
      done();
    }
  }

  document.getElementById("cmd-copy").addEventListener("click", function () {
    if (cmd) copyText(cmd, this, "复制命令");
  });

  function renderKey(key) {
    lastKey = key;
    var segs = key.split("-");
    var rows = document.querySelectorAll(".seg-row");
    for (var i = 0; i < rows.length; i++) {
      var val = segs[i] || "";
      rows[i].querySelector(".seg-val").textContent = val ? val.slice(0, 28) + (val.length > 28 ? "…" : "") : "—";
      rows[i].querySelector(".seg-len").textContent = val ? val.length.toLocaleString("en-US") + " 字符" : "—";
    }
    keyOut.textContent = key;
    keyOut.classList.remove("empty");
    copyBtn.disabled = false;
  }

  copyBtn.addEventListener("click", function () {
    if (lastKey) copyText(lastKey, copyBtn, "复制完整 KEY");
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var fd = new FormData(form);
    var products = fd.getAll("products");
    if (products.length === 0) {
      setStatus(statusEl, "请至少选择一个产品", "err");
      return;
    }
    var payload = {
      licenseeName: String(fd.get("licenseeName") || "").trim(),
      assigneeName: String(fd.get("assigneeName") || "").trim(),
      expiryDate: String(fd.get("expiryDate") || "").trim(),
      products: products
    };
    var token = String(fd.get("token") || "").trim();
    var headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = "Bearer " + token;

    var btn = form.querySelector(".btn-mint");
    btn.disabled = true;
    setStatus(statusEl, "签发中…", "");

    fetch("/getKey", { method: "POST", headers: headers, body: JSON.stringify(payload) })
      .then(function (res) {
        return res.text().then(function (t) {
          if (!res.ok) throw new Error(t || ("HTTP " + res.status));
          return t;
        });
      })
      .then(function (key) {
        renderKey(key);
        verifyInput.value = key;
        setStatus(statusEl, "签发成功 · " + payload.licenseeName + " → " + payload.expiryDate, "ok");
      })
      .catch(function (err) {
        setStatus(statusEl, "签发失败：" + err.message, "err");
      })
      .then(function () { btn.disabled = false; });
  });

  verifyBtn.addEventListener("click", function () {
    var key = verifyInput.value.trim();
    if (!key) { setStatus(verifyStatus, "请先粘贴 KEY", "err"); return; }
    verifyBtn.disabled = true;
    setStatus(verifyStatus, "校验中…", "");
    fetch("/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.valid && data.payload) {
          var p = data.payload;
          var expiry = (p.products && p.products[0]) ? p.products[0].paidUpTo : "—";
          setStatus(verifyStatus, "签名有效 · " + p.licenseId + " · " + p.licenseeName + " · 到期 " + expiry, "ok");
        } else {
          setStatus(verifyStatus, "无效：" + (data.error || "未知原因"), "err");
        }
      })
      .catch(function (err) { setStatus(verifyStatus, "校验失败：" + err.message, "err"); })
      .then(function () { verifyBtn.disabled = false; });
  });

  /* ---- /cert 签名弹窗 ---- */
  var certModal = document.getElementById("cert-modal");
  var certStatus = document.getElementById("cert-status");
  var certSigBox = document.getElementById("sig-value");
  var certEncBox = document.getElementById("enc-value");
  var certLoaded = false;

  function setCertBoxes(sig, enc, failed) {
    certSigBox.textContent = sig;
    certEncBox.textContent = enc;
    certSigBox.classList.toggle("empty", !!failed);
    certEncBox.classList.toggle("empty", !!failed);
  }

  function loadCertSignature() {
    setStatus(certStatus, "加载中…", "");
    fetch("/cert/signature")
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (r) {
        if (!r.ok || r.data.error) throw new Error(r.data.error || "HTTP " + r.status);
        setCertBoxes(r.data.signature, r.data.encoded, false);
        certLoaded = true;
        setStatus(certStatus, "已从 /cert 证书提取 · RSA-4096 · PKCS#1 v1.5 / SHA-256", "ok");
      })
      .catch(function (err) {
        setCertBoxes("加载失败", "加载失败", true);
        setStatus(certStatus, "加载失败：" + err.message, "err");
      });
  }

  function openCertModal() {
    certModal.hidden = false;
    document.body.style.overflow = "hidden";
    if (!certLoaded) loadCertSignature();
  }
  function closeCertModal() {
    certModal.hidden = true;
    document.body.style.overflow = "";
  }

  document.getElementById("cert-sig-link").addEventListener("click", function (e) {
    e.preventDefault();
    openCertModal();
  });
  certModal.addEventListener("click", function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute("data-close") !== null) {
      closeCertModal();
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !certModal.hidden) closeCertModal();
  });

  var sigCopyBtns = document.querySelectorAll(".sig-copy");
  for (var j = 0; j < sigCopyBtns.length; j++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var box = document.getElementById(btn.getAttribute("data-target"));
        if (box && !box.classList.contains("empty")) copyText(box.textContent, btn, "复制");
      });
    })(sigCopyBtns[j]);
  }
})();
</script>
</body>
</html>`;
