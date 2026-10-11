# 自定义 Key 签发台（Cloudflare Worker）

按 `create_key.md` 实现的服务端 key 生成系统：一个部署在 Cloudflare 的网页 + API，
输入 **被许可人 / 被分配人 / 到期日**，生成四段式授权 key。

```
POST /getKey   { licenseeName, assigneeName, expiryDate }  →  纯文本 key
```

## Key 格式（四段解剖）

以 `-` 分段，各段均为**标准 Base64**（字母表不含 `-`，可安全按 `-` 切分）：

| 段 | 内容 | 说明 |
|---|---|---|
| seg0 | `licenseId` | 10 位 `[A-Z0-9]` 随机，与 payload 内一致 |
| seg1 | payload JSON | UTF-8 字节的 Base64 |
| seg2 | 签名 | 对 seg1 **解码后原始字节**做 RSA 签名（RSA-4096 → 512 B） |
| seg3 | X.509 证书 | DER 的 Base64，验签公钥取自本证书 |

签名算法默认 **RSA-SHA1**（`config.js` 的 `signHash`，若产品侧未定型建议改 `SHA-256`）。

payload 字段顺序固定（即为待签内容，不做二次序列化）：

```json
{
  "licenseId": "...",
  "licenseeName": "...",
  "assigneeName": "...",
  "assigneeEmail": "",
  "licenseRestriction": "",
  "checkConcurrentUse": false,
  "products": [ { "code": "G1", "fallbackDate": "2026-12-31", "paidUpTo": "2026-12-31" } ],
  "metadata": "0120230102PPAA013009",
  "hash": "41472961/0:1563609451",
  "gracePeriodDays": 7,
  "autoProlongated": true,
  "isAutoProlongated": true
}
```

产品码模板、`metadata`、`hash` 等常量全部集中在 **`src/config.js`**，按你的产品定义修改。
签发时所有产品的 `paidUpTo` / `fallbackDate` 取用户输入的到期日。

页面文案同样在 `src/config.js` 自定义：

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `pageTitle` | 报头主标题（也用于浏览器标签页标题） | `自定义 Key` |
| `pageTitleAccent` | 报头标题的高亮后缀 | `签发` |
| `commandWindows` | 顶部命令行（Windows 访问者可见） | `irm keymint.com\|iex` |
| `commandUnix` | 顶部命令行（Linux / macOS 访问者可见） | `curl -L -o km keymint.com && bash km` |

## 快速开始

### 0. 依赖

- Node.js ≥ 18
- openssl（Git Bash / macOS / Linux 自带）
- Cloudflare 账号（部署时需要，`wrangler login`）

### 1. 生成自有 CA 与签名证书

```bash
npm run gen-keys        # 即 bash scripts/gen-keys.sh
```

先编辑 `scripts/gen-keys.sh` 顶部的 `CA_CN` / `SUBJECT_CN` 为你自己的名称。
脚本会生成 CA、签发证书，并导出三个 Base64 产物，同时自动写好本地 `.dev.vars`。

> `ca.key` / `sign.key` 是授权体系的根，**离线妥善保管，绝不入库**（`.gitignore` 已排除）。

### 2. 本地运行

```bash
npm install
npm test                # 冒烟测试：生成/验签/篡改检测
npm run dev             # http://localhost:8080
```

浏览器打开 `http://localhost:8080` 即为签发网页。

### 3. 部署到 Cloudflare

#### 方式 A：GitHub 集成（推荐，push 即部署）

1. 把本仓库推到 GitHub（**推送前确认 `.dev.vars` 与 `scripts/*.key|*.b64` 不在仓库里**，`.gitignore` 已排除）；
2. [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Import repository**，选择本仓库（自动识别 `wrangler.toml`）；
3. 在 Worker 的 **Settings → Variables and Secrets** 配置变量（见下方对照表），保存后**立即生效、无需重新部署**；
4. Deploy 后得到 `https://create-key.<你的子域>.workers.dev`。此后每次 push 自动发布。

#### 方式 B：wrangler 命令行

```bash
npx wrangler login
cat scripts/sign.pkcs8.b64 | npx wrangler secret put SIGNING_KEY_PKCS8_B64
cat scripts/sign.der.b64   | npx wrangler secret put CERT_DER_B64
cat scripts/sign.spki.b64  | npx wrangler secret put PUBLIC_KEY_SPKI_B64
npx wrangler secret put ADMIN_TOKEN        # 可选但强烈建议（单个 token 或 token 文件地址，见下）
npm run deploy
```

### 环境变量 / Secret 对照表

所有配置都可放在 Dashboard「Variables and Secrets」（本地开发写 `.dev.vars`）。
**留空或不设置 = 使用 `src/config.js` 中的默认值**。

| 名称 | 类型 | 说明 | 默认值 |
|---|---|---|---|
| `SIGNING_KEY_PKCS8_B64` | Secret | 签名私钥（PKCS#8 DER 的 Base64） | — 必配 |
| `CERT_DER_B64` | Secret | X.509 证书（DER 的 Base64，嵌入 key） | — 必配 |
| `PUBLIC_KEY_SPKI_B64` | Secret | 证书公钥（SPKI DER，供 /verify） | — 必配 |
| `ADMIN_TOKEN` | Secret | 访问令牌：单个 token 或 token 文件地址（每行一个） | 空 = 不鉴权 |
| `PRODUCT_CODES` | Variable | 产品码目录，JSON `["G1","S2"]` 或逗号 `G1,S2` | `G1,S2,B3` |
| `METADATA` | Variable | payload.metadata | `0120230102PPAA013009` |
| `PAYLOAD_HASH` | Variable | payload.hash | `41472961/0:1563609451` |
| `GRACE_PERIOD_DAYS` | Variable | payload.gracePeriodDays | `7` |
| `AUTO_PROLONGATED` | Variable | payload.autoProlongated / isAutoProlongated | `true` |
| `CHECK_CONCURRENT_USE` | Variable | payload.checkConcurrentUse | `false` |
| `ASSIGNEE_EMAIL` | Variable | payload.assigneeEmail | 空 |
| `LICENSE_RESTRICTION` | Variable | payload.licenseRestriction | 空 |
| `SIGN_HASH` | Variable | 签名哈希（`SHA-1` / `SHA-256`…） | `SHA-1` |
| `PAGE_TITLE` | Variable | 页面主标题（也用于浏览器标签页） | `SECMAG` |
| `PAGE_TITLE_ACCENT` | Variable | 标题高亮后缀 | `签发` |
| `COMMAND_WINDOWS` | Variable | 顶部命令行（Windows） | `irm secmag.com\|iex` |
| `COMMAND_UNIX` | Variable | 顶部命令行（Linux / macOS） | `curl -L -o km secmag.com && bash km` |
| `MAX_NAME_LENGTH` | Variable | 名称最大长度 | `128` |
| `LICENSE_ID_LENGTH` | Variable | licenseId 位数 | `10` |
| `UPLOAD_CERT_MODE` | Variable | 开启「自定义证书」签发模式（页脚模式 switch，用户上传证书+私钥，当次请求内使用、不存储） | `false` |
| `CORS_ORIGIN` | Variable | 跨域来源 | `*` |
| `PS_SCRIPT` | Secret | PowerShell 安装脚本的 http(s) 文件地址（未配置时用内置兜底脚本 `assets/install.ps1`） | 空 = 内置脚本 |
| `SH_SCRIPT` | Secret | bash 安装脚本的 http(s) 文件地址（未配置时用内置兜底脚本 `assets/install.sh`） | 空 = 内置脚本 |

> 注意：修改 `SIGN_HASH` 后，用旧算法签发的 key 将无法通过 `/verify`（签名与算法绑定）。

## API

### `POST /getKey` — 签发

```js
const API_URL = 'https://create-key.<你的子域>.workers.dev/getKey';

const response = await fetch(API_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    // 配置了 ADMIN_TOKEN 时必填：
    // 'Authorization': 'Bearer <ADMIN_TOKEN>',
  },
  body: JSON.stringify({
    licenseeName,
    assigneeName,
    expiryDate,          // 'YYYY-MM-DD'
    products,            // 可选：产品码数组；省略时使用 config.js 目录中的全部产品码。
                         // 目录之外允许自定义编码（非空、≤64 字符，自动去重），
                         // 网页端下拉支持全选与自定义编码输入
  })
});
const authCode = await response.text();   // 四段式 key
```

错误时返回 4xx/5xx，body 为 JSON `{"error": "..."}`。

成功时响应头额外携带**证书签名详情**（十进制大整数，网页「查看签名」弹窗的数据源，
随签发一同受 `ADMIN_TOKEN` 保护）：

| 响应头 | 内容 |
|---|---|
| `X-Cert-Signature` | 签名：证书 CA 签名值（signatureValue） |
| `X-Cert-Encoded` | 密文：PKCS#1(SHA256(TBS))，CA 公钥还原签名所得的 PKCS#1 编码块 |

跨域读取需带上这两个 `Access-Control-Expose-Headers`（服务端已默认返回）。

#### 自定义证书模式（`UPLOAD_CERT_MODE=true` 时开放，默认开启）

开启后页面右上角出现证书来源徽标，点击弹窗管理：

- 切换「服务器证书 / 自定义证书」；自定义模式上传 **X.509 证书 + PKCS#8 私钥**
  （PEM 或 DER），两样都选后即缓存在页面会话内存中并切换（**不落任何存储，刷新即失效**）
- 自定义模式下：签发用上传材料（`seg2` 上传私钥签名、`seg3` 为上传证书），
  页面「签名校验」改为**浏览器本地**用 key 内嵌证书（seg3）的公钥验签；
  签出的 key 需用**该证书**验证（而非 `GET /cert` 的服务器证书）
- 可随时切回服务器证书（缓存保留），或在弹窗**清除证书**（清除/未上传时回退服务器模式）
- 服务端校验证书可解析且**证书公钥与私钥配对**，不配对返回 400
- 配置了 `ADMIN_TOKEN` 时，该模式同样需要令牌；强烈建议开启此模式时同时配置 `ADMIN_TOKEN`
- 未开启 `UPLOAD_CERT_MODE` 时携带上传参数返回 403

### `POST /verify` — 校验

请求体 JSON `{"key": "..."}`（或直接以纯文本放 key）。
返回 `{ valid, payload?, error?, segLengths? }`。

### `GET /cert` — 签发证书

返回 seg3 证书的 PEM，供你的产品侧内置/信任。

### `GET /` — 按 User-Agent 协商（安装命令的分发端点）

同一个根地址，按客户端返回不同内容，串起页面顶部的安装命令：

| 客户端 | 识别依据（User-Agent） | 返回 |
|---|---|---|
| PowerShell（`irm secmag.com\|iex`） | `WindowsPowerShell/…`、`PowerShell/…`（含 Linux/mac 的 pwsh） | PowerShell 脚本（UTF-8 BOM，`text/plain; charset=utf-8`） |
| curl / wget / httpie 等（`curl -L -o km secmag.com && bash km`） | `curl/…`、`Wget/…` 等 | bash 脚本（强制无 BOM，`text/x-shellscript; charset=utf-8`） |
| 浏览器 / 其他 | — | 签发网页（现有行为） |

也可以用显式路径绕过协商，直接取指定脚本：**`GET /install.ps1`**、**`GET /install.sh`**。

脚本来源（`PS_SCRIPT` / `SH_SCRIPT`，配置方式同 `ADMIN_TOKEN` 的文件地址模式）：

- **必须是 `http(s)://` 文件地址**，指向真正的脚本文件；修改文件内容即更新脚本，无需重新部署
  （内容缓存约 **60 秒**；拉取失败沿用上一次成功内容，再不行回退内置脚本）；
- 未配置 / 地址无效 / 拉取彻底失败时，使用**内置兜底脚本** `assets/install.ps1` / `assets/install.sh`
  （随 Worker 一起部署，改内容需重新部署）——保证安装命令在任何情况下都可用；
- 远端文件须为脚本纯文本，返回 HTML 页面的地址会被拒绝（防误配）。

## 产品侧验签示意

```js
import crypto from 'node:crypto';

const [licenseId, payloadB64, sigB64, certB64] = key.split('-');
const payloadBytes = Buffer.from(payloadB64, 'base64');

const cert = new crypto.X509Certificate(Buffer.from(certB64, 'base64'));
// 需要时：校验 cert 链到你内置信任的 CA（cert.verify(caPublicKey)）

const valid = crypto.verify(
  'sha1',            // 与 config.js 的 signHash 一致（SHA-256 时用 'sha256'）
  payloadBytes,      // seg1 解码后的原始字节
  cert.publicKey,
  Buffer.from(sigB64, 'base64'),
);
```

或用 openssl（与 create_key.md 的验证方式一致）：

```bash
# 从 key 中取出 seg1 / seg2 / seg3 后：
base64 -d payload.b64 > payload.json
base64 -d cert.b64 | openssl x509 -inform DER -out cert.pem
base64 -d sig.b64 > sig.bin
openssl dgst -sha1 -verify <(openssl x509 -in cert.pem -pubkey -noout) \
  -signature sig.bin payload.json
# → Verified OK
```

## 安全建议

- **ADMIN_TOKEN 必配**：否则任何访问网页/API 的人都能签发 key。支持两种配置：
  - **普通字符串**：该字符串即为唯一有效 token（用长随机串）；
  - **`http(s)://` 文件地址**：服务端拉取该文本文件作为令牌列表，**每行一个有效 token**
    （自动去首尾空白、忽略空行，须为纯文本——返回 HTML 页面会被拒绝）。
    修改文件内容即可换发/吊销 token，无需重新部署；内容缓存约 **60 秒**后生效，
    拉取失败时沿用上一次成功的列表。请求带 `Cache-Control: no-cache`，尽量穿透中间 CDN 缓存。
    该地址须保持私密——能访问/编辑该文件的人即可签发 key。
- `ca.key` / `sign.key` 离线保存；线上 Worker 只持有签名私钥的 secret。
- 轮换密钥 = 重跑 `gen-keys.sh` + 更新三个 secret；旧 key 的信任策略由你的产品决定（证书有效期 / 吊销列表）。
- 需要机器绑定时，在 `buildPayload`（`src/license.js`）中加入机器指纹字段并在产品侧校验。

## 目录结构

```
├── src/
│   ├── config.js          # 产品码模板、metadata/hash 等常量、签名算法
│   ├── license.js         # 纯逻辑：payload 构造 / 签名 / 验签（Node 与 Worker 通用）
│   ├── installer.js       # 安装脚本：UA 协商 + PS_SCRIPT/SH_SCRIPT 拉取缓存
│   └── index.js           # Worker：页面 + 安装脚本 + /getKey + /verify + /cert
├── assets/
│   ├── install.ps1        # 内置兜底 PowerShell 安装脚本
│   └── install.sh         # 内置兜底 bash 安装脚本
├── scripts/
│   ├── gen-keys.sh        # openssl 生成 CA + 签名证书 + 导出 secret 产物
│   └── test-license.mjs   # 冒烟测试
├── wrangler.toml
├── package.json
└── create_key.md          # 需求文档
```
