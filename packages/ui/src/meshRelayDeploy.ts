/**
 * 「服务器中继」部署闭环（纯函数，无 DOM / 无 window.cfpilot 依赖，便于单测）。
 *
 * 两个方向：
 *
 *   1. `buildRelayDeployScript()`：面板 → 服务器。生成一段可整段粘贴到服务器
 *      root shell 的安装命令。**令牌由面板先生成再写进命令**，服务器端
 *      `mobihop-relay --init --token` 会原样复用 ⇒ 两端令牌天然一致，不用手抄。
 *
 *   2. `parseRelayInitOutput()`：服务器 → 面板。解析 `--init` 打印的
 *      `MOBIHOP_RELAY_NODE_ID=` / `_ADDR=` / `_TOKEN=` 行并回填表单。
 *
 * 这两条一起构成「填地址 → 生成命令 → 在服务器跑 → 粘回输出」的闭环，
 * 中间不需要用户理解 NodeId 是怎么派生的。
 */

export type RelayAdmissionMode = 'token' | 'blind'

export interface RelayDeployInput {
  mode: RelayAdmissionMode
  /** 服务器公网地址 `IP:端口`（面板里就是「中继地址」字段） */
  addr: string
  /** 令牌中继的准入令牌；blind 模式忽略 */
  token: string
  /** 二进制在服务器上的路径（默认 /usr/local/bin/mobihop-relay） */
  binaryPath?: string
  /** 身份/令牌目录（默认 /var/lib/mobihop-relay） */
  dataDir?: string
}

export const RELAY_DEFAULT_PORT = 51820
const DEFAULT_BINARY = '/usr/local/bin/mobihop-relay'
const DEFAULT_DATA_DIR = '/var/lib/mobihop-relay'
/** 与 mobihop-relay 的 MIN_TOKEN_LEN 对齐。 */
const MIN_TOKEN_LEN = 8

/** `ip:port` / `[v6]:port` / 裸主机 → 端口（解析不出时返回默认 51820）。 */
export function relayPortFromAddr(addr: string): number {
  const s = (addr || '').trim()
  const m = /:(\d{1,5})$/.exec(s)
  if (!m) return RELAY_DEFAULT_PORT
  const port = Number(m[1])
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : RELAY_DEFAULT_PORT
}

/** 去掉端口的主机部分（`[240e::1]:51820` → `240e::1`；裸主机原样返回）。 */
export function relayHostFromAddr(addr: string): string {
  const s = (addr || '').trim()
  if (!s) return ''
  if (s.startsWith('[')) {
    const end = s.indexOf(']')
    return end > 0 ? s.slice(1, end) : s
  }
  const colons = s.split(':').length - 1
  if (colons > 1) return s // 裸 IPv6，没带端口
  const i = s.lastIndexOf(':')
  return i > 0 ? s.slice(0, i) : s
}

/**
 * 生成 24 字节随机令牌（48 hex）。
 *
 * 环境没有安全随机源时**抛错**，绝不退回 `Math.random`：令牌是准入凭据，
 * 弱随机等于没有。
 */
export function randomRelayToken(): string {
  const c = globalThis.crypto
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('当前环境没有安全随机源，无法生成令牌')
  }
  const buf = new Uint8Array(24)
  c.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** POSIX shell 单引号转义。 */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`
}

/**
 * 生成服务器端安装脚本。
 *
 * 与 MobiHop 仓库的 `deploy/install-relay.sh` 等价（同样的 `--init` 参数、
 * 同样的 systemd unit、同样的 `/etc/default/mobihop-relay`），但不需要用户
 * 拿到 MobiHop 仓库：命令自包含，适合从面板直接复制。
 */
export function buildRelayDeployScript(input: RelayDeployInput): string {
  const mode: RelayAdmissionMode = input.mode === 'blind' ? 'blind' : 'token'
  const host = relayHostFromAddr(input.addr)
  const port = relayPortFromAddr(input.addr)
  if (!host) {
    throw new Error('请先填写服务器公网地址（IP:端口），例如 203.0.113.10:51820')
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) {
    throw new Error(`服务器地址里有非法字符：${host}`)
  }
  const token = (input.token || '').trim()
  if (mode === 'token' && token.length < MIN_TOKEN_LEN) {
    throw new Error(`令牌至少 ${MIN_TOKEN_LEN} 个字符（点「生成服务器部署命令」会自动生成）`)
  }
  const bin = input.binaryPath?.trim() || DEFAULT_BINARY
  const dataDir = input.dataDir?.trim() || DEFAULT_DATA_DIR
  const publicAddr = `${host}:${port}`

  // 注意：这里拼的是**目标 shell 脚本**，`$TOKEN` 要原样保留给服务器端展开。
  const initFlags = mode === 'blind' ? '--relay-only' : '--token "$TOKEN"'

  const lines: string[] = [
    '#!/usr/bin/env bash',
    `# CFPilot 生成：在云服务器上安装 MobiHop ${
      mode === 'blind' ? '零知识盲中继' : '令牌中继'
    }（mobihop-relay）`,
    '#',
    '# 1) 先在本机编好并上传二进制（MobiHop 仓库根目录）：',
    '#      cargo build --release -p mobihop-relay',
    `#      scp target/release/mobihop-relay root@${host}:${bin}`,
    '# 2) 把下面整段粘到服务器 root shell 执行（会写 /etc/systemd/system 与 /etc/default）。',
    '# 3) 执行完把输出里的 MOBIHOP_RELAY_NODE_ID=... 整行粘回面板「粘贴部署输出回填」。',
    'set -euo pipefail',
    '',
    `BIN=${shellQuote(bin)}`,
    `DATA=${shellQuote(dataDir)}`,
    `PORT=${shellQuote(String(port))}`,
    `HOST=${shellQuote(host)}`,
  ]
  if (mode === 'token') {
    lines.push(`TOKEN=${shellQuote(token)}`)
  }
  lines.push(
    '',
    '# 初始化：生成（或复用）身份与令牌，并打印 NodeId / 对外地址 / 节点侧 TOML',
    'install -d -m 0700 "$DATA"',
    `"$BIN" --init ${initFlags} --listen "0.0.0.0:$PORT" --public-addr "$HOST:$PORT" --data-dir "$DATA"`,
    ''
  )

  if (mode === 'token') {
    lines.push(
      '# 参数放环境文件（0600），unit 里不出现令牌；进程命令行里的令牌只有 root 能看到',
      'install -m 0600 /dev/null /etc/default/mobihop-relay',
      'cat >/etc/default/mobihop-relay <<ENV',
      'RELAY_ARGS="--listen 0.0.0.0:$PORT --token $TOKEN --data-dir $DATA"',
      'ENV',
      ''
    )
  } else {
    lines.push(
      'install -m 0600 /dev/null /etc/default/mobihop-relay',
      'cat >/etc/default/mobihop-relay <<ENV',
      'RELAY_ARGS="--relay-only --listen 0.0.0.0:$PORT --data-dir $DATA"',
      'ENV',
      ''
    )
  }

  lines.push(
    'cat >/etc/systemd/system/mobihop-relay.service <<UNIT',
    '[Unit]',
    'Description=MobiHop relay (mobihop-relay)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'EnvironmentFile=/etc/default/mobihop-relay',
    'ExecStart=$BIN \\$RELAY_ARGS',
    'Restart=always',
    'RestartSec=3',
    'NoNewPrivileges=yes',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'PrivateTmp=yes',
    'ReadWritePaths=$DATA',
    'LimitNOFILE=65536',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'UNIT',
    '',
    'systemctl daemon-reload',
    // 必须 restart 而不是 enable --now：服务已在跑时 --now 不会重读环境文件，
    // 改端口/改令牌后看起来「装成功」但进程还是旧参数（真机踩到）。
    'systemctl enable mobihop-relay',
    'systemctl restart mobihop-relay',
    'sleep 1',
    'systemctl --no-pager --lines=0 status mobihop-relay || true',
    '',
    'echo',
    'echo "下一步："',
    `echo "  1) 云安全组 + 主机防火墙放行 UDP $PORT（如：ufw allow $PORT/udp）"`,
    'echo "  2) 把上面 MOBIHOP_RELAY_NODE_ID=... 整行粘回 CFPilot「粘贴部署输出回填」"',
    'echo "  3) 排查：journalctl -u mobihop-relay -n 50 --no-pager"',
    ''
  )

  return lines.join('\n')
}

/**
 * 解析 `mobihop-relay --init` 的输出，取出可回填的三项。
 *
 * 宽松匹配：整段粘贴（夹着 systemd 状态、日志、提示语）也能解析；
 * 只认 `MOBIHOP_RELAY_*` 前缀，避免把节点 TOML 里的 `node_id` 误当令牌。
 */
export function parseRelayInitOutput(text: string): {
  nodeId?: string
  addr?: string
  token?: string
} {
  const src = text || ''
  const out: { nodeId?: string; addr?: string; token?: string } = {}
  const node = /\bMOBIHOP_RELAY_NODE_ID\s*=\s*([0-9a-fA-F]{16})\b/.exec(src)
  if (node) out.nodeId = node[1].toLowerCase()
  const addr = /\bMOBIHOP_RELAY_ADDR\s*=\s*([^\s'"`]+:\d{1,5})\b/.exec(src)
  if (addr) out.addr = addr[1]
  const token = /\bMOBIHOP_RELAY_TOKEN\s*=\s*([A-Za-z0-9._~+/=-]{8,256})/.exec(src)
  if (token) out.token = token[1]
  return out
}
