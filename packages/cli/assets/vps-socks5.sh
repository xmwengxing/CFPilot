#!/usr/bin/env bash
#
# CFPilot —— VPS 落地代理一键部署（SOCKS5，带用户名/密码）
#
# 用途：给 CFPilot 配一个「自己的出口」。
#
#   为什么需要它：Cloudflare Worker 的出口是数据中心的 IP，
#   Netflix / 银行 / Google 登录页对这类 IP 的风控是结构性的 ——
#   任何「检测类」功能都只能告诉你不行，只有换出口才能让它行。
#
#   部署完成后脚本会打印一行：
#       socks5://用户名:口令@你的VPS公网IP:端口
#   把这行粘进 CFPilot 面板「出站与高级」的 SOCKS5 输入框即可。
#
# 用法：
#   bash deploy-socks5.sh                 # 默认端口 1080，随机口令
#   bash deploy-socks5.sh --port 2080     # 自定义端口
#   bash deploy-socks5.sh --print-only    # 只打印已部署实例的连接串
#
# 环境变量：
#   SING_BOX_VERSION   指定 sing-box 版本（默认 1.10.7）
#   GH_MIRROR          GitHub 加速前缀，例如 https://gh-proxy.com/
#
# ⚠️ 安全提示：
#   1. 本脚本开启的是**带认证**的 SOCKS5，但仍是公网端口 ——
#      口令泄露等于把你的 VPS 变成公开代理。请勿把连接串发到公开群组。
#   2. 建议同时在云厂商安全组里限制来源 IP（至少限制到 Cloudflare 出口网段）。
#   3. 仅供自用。用它搭建公开代理服务可能违反 VPS 服务商条款。
#
set -euo pipefail

PORT=1080
SB_VERSION="${SING_BOX_VERSION:-1.10.7}"
CONFIG_DIR=/etc/sing-box
SERVICE=sing-box
PRINT_ONLY=0

log() { printf '\033[36m[cfpilot]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[cfpilot] 错误：%s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --print-only) PRINT_ONLY=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

need_root() {
  [ "$(id -u)" -eq 0 ] || die "需要 root：请用 sudo bash $0 运行"
}

rand() {
  # 32 位十六进制随机串；/dev/urandom 在所有发行版都有
  head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

public_ip() {
  # 依次尝试几个纯文本回显服务（都不在 Cloudflare 网段，避免被墙/被拒）
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip=$(curl -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]') || true
    if [ -n "${ip:-}" ]; then echo "$ip"; return 0; fi
  done
  return 1
}

print_conn() {
  local user pass ip
  user=$(grep -oP '"username":\s*"\K[^"]+' "$CONFIG_DIR/config.json" 2>/dev/null | head -1 || true)
  pass=$(grep -oP '"password":\s*"\K[^"]+' "$CONFIG_DIR/config.json" 2>/dev/null | head -1 || true)
  ip=$(public_ip || echo "<你的VPS公网IP>")
  local p
  p=$(grep -oP '"listen_port":\s*\K[0-9]+' "$CONFIG_DIR/config.json" 2>/dev/null | head -1 || echo "$PORT")
  [ -n "${user:-}" ] || die "未找到已部署的配置，请先不带 --print-only 运行一次"
  echo
  echo "把下面这一行粘进 CFPilot 面板 →「出站与高级」→ SOCKS5："
  echo
  printf '  \033[32msocks5://%s:%s@%s:%s\033[0m\n' "$user" "$pass" "$ip" "$p"
  echo
  echo "（面板里也可以只填 用户名:口令@IP:端口，协议头可省略）"
}

if [ "$PRINT_ONLY" -eq 1 ]; then
  print_conn
  exit 0
fi

need_root

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l) ARCH=armv7 ;;
  *) die "不支持的架构：$(uname -m)" ;;
esac

# ---- 1. 安装 sing-box（已有则跳过） ----
if command -v sing-box >/dev/null 2>&1; then
  log "已检测到 sing-box：$(sing-box version | head -1)"
else
  log "安装 sing-box v${SB_VERSION}（${ARCH}）"
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  PKG="sing-box-${SB_VERSION}-linux-${ARCH}.tar.gz"
  URL="https://github.com/SagerNet/sing-box/releases/download/v${SB_VERSION}/${PKG}"
  if ! curl -fsSL --max-time 120 -o "$TMP/$PKG" "$URL"; then
    if [ -n "${GH_MIRROR:-}" ]; then
      log "直连失败，改用镜像 ${GH_MIRROR}"
      curl -fsSL --max-time 120 -o "$TMP/$PKG" "${GH_MIRROR}${URL}" || die "下载失败"
    else
      die "下载失败。可设置 GH_MIRROR 后重试，例如：GH_MIRROR=https://gh-proxy.com/ bash $0"
    fi
  fi
  tar -xzf "$TMP/$PKG" -C "$TMP"
  install -m 0755 "$TMP/sing-box-${SB_VERSION}-linux-${ARCH}/sing-box" /usr/local/bin/sing-box
fi

# ---- 2. 生成配置（带认证的 SOCKS5） ----
USER_NAME="cfpilot$(rand | cut -c1-6)"
PASS_WORD=$(rand)
mkdir -p "$CONFIG_DIR"

if [ -f "$CONFIG_DIR/config.json" ]; then
  cp "$CONFIG_DIR/config.json" "$CONFIG_DIR/config.json.bak.$(date +%s)"
  log "已备份旧配置"
fi

cat > "$CONFIG_DIR/config.json" <<JSON
{
  "log": { "level": "warn", "timestamp": true },
  "inbounds": [
    {
      "type": "socks",
      "tag": "socks-in",
      "listen": "0.0.0.0",
      "listen_port": ${PORT},
      "users": [
        { "username": "${USER_NAME}", "password": "${PASS_WORD}" }
      ]
    }
  ],
  "outbounds": [
    { "type": "direct", "tag": "direct" }
  ]
}
JSON
chmod 600 "$CONFIG_DIR/config.json"

# ---- 3. systemd ----
if ! command -v systemctl >/dev/null 2>&1; then
  log "没有 systemd：请手动前台运行 —— sing-box run -c $CONFIG_DIR/config.json"
else
  cat > "/etc/systemd/system/${SERVICE}.service" <<UNIT
[Unit]
Description=sing-box SOCKS5 landing proxy (CFPilot)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/sing-box run -c ${CONFIG_DIR}/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now "$SERVICE" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE"
  sleep 1
  if systemctl is-active --quiet "$SERVICE"; then
    log "服务已启动：systemctl status ${SERVICE}"
  else
    journalctl -u "$SERVICE" -n 20 --no-pager || true
    die "服务启动失败，请查看上面的日志"
  fi
fi

# ---- 4. 防火墙提示（不自动改，避免把用户锁在门外） ----
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  log "检测到 ufw 已启用。如需放行：ufw allow ${PORT}/tcp"
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state 2>/dev/null | grep -q running; then
  log "检测到 firewalld 已启用。如需放行：firewall-cmd --add-port=${PORT}/tcp --permanent && firewall-cmd --reload"
fi

print_conn
echo "提示：云厂商安全组同样需要放行 TCP ${PORT}，否则连不上。"
