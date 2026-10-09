### "生成自定义key"的技术实现（**服务端生成**）

```js

const API_URL = 'http://localhost:8080/getKey';

const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ licenseeName, assigneeName, expiryDate })
});
const authCode = await response.text(); 


### key四段解剖

以 `-` 分段（各段均为标准 Base64，不含 `-` 字符）：

| 段 | 内容 | 长度 | 说明 |
|---|---|---|---|
| 0 | `5QYRGC0LDU` | 10 字符 | licenseId（`[A-Z0-9]` 随机） |
| 1 | `eyJsaWNlbnNlSWQi...` | 20,036 字符 | **payload JSON** 的 Base64 |
| 2 | `TpILt+tui+8Q...` | 684 字符 | **签名** Base64（解码 512 B = **RSA-4096**） |
| 3 | `MIIEtTCCAp2g...` | 1,612 字符 | **X.509 证书** DER 的 Base64 |

### 6.2 payload（`decoded_payload.json`）

```json
{
  "licenseId": "5QYRGC0LDU",
  "licenseeName": "Name",              // ← 用户输入 1
  "assigneeName": "Demo Group",        // ← 用户输入 2
  "assigneeEmail": "",
  "licenseRestriction": "",
  "checkConcurrentUse": false,
  "products": [                             // ← 固定模板，共 197 项 + 用户输入 3
    { "code": "II",   "fallbackDate": "2026-12-31", "paidUpTo": "2026-12-31" },
    { "code": "PCWMP","fallbackDate": "2026-12-31", "paidUpTo": "2026-12-31" },
    ...（G1/S2/B3 等共 3 条）
  ],
  "metadata": "0120230102PPAA013009",       // 固定
  "hash": "41472961/0:1563609451",          // 固定（非机器绑定，所有用户相同）
  "gracePeriodDays": 7,                     // 固定
  "autoProlongated": true,
  "isAutoProlongated": true
}
```

要点：
- **3 个产品**全部 `paidUpTo` / `fallbackDate` = `2026-12-31`（即用户输入的到期日）
- `licenseId` 同时出现在首段与 JSON 内，两侧一致
- `metadata`（`0120230102PPAA013009`）与 `hash`（`41472961/0:1563609451`）为**写死**字段，不含机器信息

### 签名（密码学验证通过）

| 项 | 结果 |
|---|---|
| 签名长度 | 512 字节 → **RSA-4096** |
| 验签尝试 | 候选待签内容 × {SHA256, SHA1, SHA384, SHA512, raw} 组合 |
| **命中** | `payload JSON 的 UTF-8 字节` + **RSA-SHA1** + 证书内公钥 → openssl 输出 **`Verified OK`** |
| 其余组合 | 均失败（base64 串、整串、licenseId 等都不是待签内容） |

即：签名是对 **JSON 解码后原始字节** 做 **RSA-SHA1**（旧版 Demo license 常用算法），签名与证书内公钥严格配对。

### 6.4 证书（`sample_cert.pem`）

```
subject  = CN=Novice
issuer   = CN=DemoProfile CA        
notBefore= Sep 29 14:06:12 2023 GMT
notAfter = Sep 27 14:06:12 2033 GMT
serial   = 0F2B9C726CA56DAEF59594004227394C9880870C
公钥      = RSA-4096, e=65537
签名算法  = sha256WithRSAEncryption
```