#!/usr/bin/env bash
# 生成自有 CA + 签名证书，并导出 Worker 所需的 Base64 产物。
# 依赖：openssl（Git Bash / macOS / Linux 自带）。
#
# 产物（写入 scripts/ 目录）：
#   ca.key / ca.crt            自有 CA（请离线妥善保管 ca.key）
#   sign.key / sign.crt        签发证书（嵌入 key 的 seg3）
#   sign.pkcs8.b64             签名私钥  → wrangler secret SIGNING_KEY_PKCS8_B64
#   sign.der.b64               证书 DER  → wrangler secret CERT_DER_B64
#   sign.spki.b64              证书公钥  → wrangler secret PUBLIC_KEY_SPKI_B64
#   .dev.vars（项目根目录）      本地 wrangler dev 直接可用
set -euo pipefail

# Git Bash / MSYS 会把 -subj 的 /CN=... 误转换成 Windows 路径，禁用参数路径转换
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")"

# ===== 按你的产品修改（写入证书主题） =====
CA_CN="DemoProfile CA"      # CA 名称（issuer）
SUBJECT_CN="Novice"         # 签发证书主题（subject）
DAYS=3650                   # 有效期 10 年
BITS=4096                   # RSA-4096
# ==========================================

echo "==> 生成 CA（RSA-$BITS）…"
openssl genrsa -out ca.key "$BITS" 2>/dev/null
openssl req -x509 -new -key ca.key -sha256 -days "$DAYS" -out ca.crt \
  -subj "/CN=$CA_CN"

echo "==> 生成签名证书（CN=$SUBJECT_CN，由 CA 签发）…"
openssl genrsa -out sign.key "$BITS" 2>/dev/null
openssl req -new -key sign.key -out sign.csr -subj "/CN=$SUBJECT_CN"
openssl x509 -req -in sign.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -sha256 -days "$DAYS" -out sign.crt

echo "==> 导出 Base64 产物…"
openssl pkcs8 -topk8 -nocrypt -in sign.key -outform DER -out sign.pkcs8.der
openssl x509 -in sign.crt -outform DER -out sign.der
openssl x509 -in sign.crt -pubkey -noout | openssl pkey -pubin -outform DER -out sign.spki.der

b64() { base64 < "$1" | tr -d '\n'; }
b64 sign.pkcs8.der > sign.pkcs8.b64
b64 sign.der       > sign.der.b64
b64 sign.spki.der  > sign.spki.b64

# 写入本地开发环境变量（.dev.vars 已在 .gitignore 中）
ROOT="$(cd .. && pwd)"
{
  echo "SIGNING_KEY_PKCS8_B64=$(cat sign.pkcs8.b64)"
  echo "CERT_DER_B64=$(cat sign.der.b64)"
  echo "PUBLIC_KEY_SPKI_B64=$(cat sign.spki.b64)"
  echo "ADMIN_TOKEN="
} > "$ROOT/.dev.vars"

echo
echo "完成。私钥与证书在 $(pwd)/ 下，请妥善保管 ca.key / sign.key。"
echo
echo "本地开发：  npm run dev        （已自动写入 .dev.vars）"
echo "部署上线：  依次执行"
echo "  cat scripts/sign.pkcs8.b64 | npx wrangler secret put SIGNING_KEY_PKCS8_B64"
echo "  cat scripts/sign.der.b64   | npx wrangler secret put CERT_DER_B64"
echo "  cat scripts/sign.spki.b64  | npx wrangler secret put PUBLIC_KEY_SPKI_B64"
echo "  （可选）npx wrangler secret put ADMIN_TOKEN    # 防止任意人签发"
echo "  npm run deploy"
