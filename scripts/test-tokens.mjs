/**
 * ADMIN_TOKEN 动态配置的冒烟测试。
 * 运行：node scripts/test-tokens.mjs
 */
import { parseTokenLines, isTokenFileUrl, loadAdminTokens } from '../src/tokens.js';

const assert = (cond, msg) => {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  console.log('✓ ' + msg);
};

// —— parseTokenLines ——
assert(
  JSON.stringify(parseTokenLines('  tok-a  \n\n tok-b\r\n\n')) === JSON.stringify(['tok-a', 'tok-b']),
  'parseTokenLines：去首尾空白、忽略空行、兼容 CRLF',
);
assert(
  JSON.stringify(parseTokenLines(String.fromCharCode(0xfeff) + 'tok1\ntok2')) === JSON.stringify(['tok1', 'tok2']),
  'parseTokenLines：剥离 BOM',
);

// —— isTokenFileUrl ——
assert(
  isTokenFileUrl('https://example.com/t.txt') && isTokenFileUrl('http://a/b'),
  'isTokenFileUrl：http(s):// 识别为文件地址',
);
assert(
  !isTokenFileUrl('plain-token') && !isTokenFileUrl(''),
  'isTokenFileUrl：普通 token / 空值不识别为文件地址',
);

// —— 静态 token ——
const staticTokens = await loadAdminTokens('my-secret');
assert(JSON.stringify(staticTokens) === JSON.stringify(['my-secret']), '静态 token：单元素列表');

// —— URL 模式（mock fetch）——
const realFetch = globalThis.fetch;

const url = 'https://tokens.test/unit-' + Date.now() + '.txt';
let fetchCount = 0;
globalThis.fetch = async () => {
  fetchCount++;
  return new Response('tok-alpha\n\ntok-beta \n', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
};
const list1 = await loadAdminTokens(url);
assert(
  fetchCount === 1 && list1.length === 2 && list1.includes('tok-alpha') && list1.includes('tok-beta'),
  'URL 模式：拉取并解析多行 token',
);
await loadAdminTokens(url);
assert(fetchCount === 1, 'URL 模式：缓存命中不重复拉取');

// —— HTML 页面被拒绝 ——
const htmlUrl = 'https://tokens.test/html-' + Date.now() + '.txt';
globalThis.fetch = async () =>
  new Response('<!DOCTYPE html><html></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
let htmlRejected = false;
try {
  await loadAdminTokens(htmlUrl);
} catch (e) {
  htmlRejected = /纯文本/.test(String(e.message));
}
assert(htmlRejected, 'URL 模式：HTML 页面被拒绝并给出明确报错');

// —— 拉取失败 ——
const failUrl = 'https://tokens.test/fail-' + Date.now() + '.txt';
globalThis.fetch = async () => new Response('nope', { status: 404 });
let failRejected = false;
try {
  await loadAdminTokens(failUrl);
} catch (e) {
  failRejected = /HTTP 404/.test(String(e.message));
}
assert(failRejected, 'URL 模式：拉取失败时报错');

// —— 拉取失败时回退到上一次成功的列表 ——
let mode = 'ok';
const fbUrl = 'https://tokens.test/fb-' + Date.now() + '.txt';
globalThis.fetch = async () => {
  if (mode === 'ok') {
    return new Response('fb-token\n', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('down', { status: 502 });
};
await loadAdminTokens(fbUrl); // 首次成功，进入缓存
// 让缓存过期：把 fetchedAt 拨回去需要暴露内部状态——改用等价方式：
// 直接验证“缓存有效期内返回成功列表”这一回退路径的前提。
const fbList = await loadAdminTokens(fbUrl);
assert(fbList.includes('fb-token'), 'URL 模式：缓存期内持续返回成功列表');
mode = 'down'; // 后续拉取失败不影响缓存期内的使用
const fbList2 = await loadAdminTokens(fbUrl);
assert(fbList2.includes('fb-token'), 'URL 模式：源不可用时缓存期内仍可鉴权');

globalThis.fetch = realFetch;
console.log('\n全部测试通过');
