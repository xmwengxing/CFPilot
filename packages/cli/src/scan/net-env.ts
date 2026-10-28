/**
 * 本机网络环境检测：识别会干扰「真连接优选」的代理接管。
 *
 * ## 为什么需要这个模块
 *
 * 扫描器要测的是「本机直连某个 Cloudflare IP 的真实质量」。
 * 但只要本机有代理工具在接管流量（TUN 模式、系统代理，或代理规则把待测
 * IP 走了代理节点），测出来的就是**到代理的延迟**，而不是到目标 IP 的延迟。
 *
 * 后果具有欺骗性：扫描本身不报错，结果看起来「正常」，
 * 但所有候选 IP 成绩趋于一致，导入客户端后大量 `-1` —— 因为从未真正直连验证过。
 *
 * 因此这里做多重探测，把结论交给调用方去提示用户，
 * CLI 与 GUI 共用同一套判定，避免两边口径不一致。
 */
import * as net from 'node:net'
import { execFile } from 'node:child_process'

/** 常见的本地代理监听端口 */
export const PROXY_PORTS: Array<{ port: number; name: string }> = [
  { port: 7890, name: 'Clash / Mihomo（HTTP）' },
  { port: 7891, name: 'Clash / Mihomo（SOCKS）' },
  { port: 7897, name: 'Clash Verge' },
  { port: 1080, name: '通用 SOCKS' },
  { port: 10808, name: 'v2rayN（SOCKS）' },
  { port: 10809, name: 'v2rayN（HTTP）' },
  { port: 2080, name: 'Nekoray / sing-box' },
  { port: 2081, name: 'Nekoray / sing-box' },
  { port: 8889, name: 'Surge' },
  { port: 6152, name: 'Surge（HTTP）' },
]

export interface ProxyFinding {
  /** 简短结论，用于日志行 */
  message: string
  /** 建议动作 */
  advice: string
}

export interface NetEnvResult {
  /** 是否未检测到干扰 */
  clean: boolean
  findings: ProxyFinding[]
}

/** 探测某个本地端口是否有进程在监听 */
export function isPortListening(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const done = (open: boolean): void => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
      resolve(open)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    try {
      socket.connect(port, '127.0.0.1')
    } catch {
      done(false)
    }
  })
}

/** 读取 Windows 系统代理设置（注册表）；非 Windows 返回空串 */
export async function readSystemProxy(): Promise<string> {
  if (process.platform !== 'win32') return ''
  const query = (key: string): Promise<string> =>
    new Promise((resolve) => {
      execFile(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', key],
        { timeout: 3000, windowsHide: true },
        (err, stdout) => resolve(err ? '' : String(stdout))
      )
    })

  try {
    const enabled = await query('ProxyEnable')
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled)) return ''
    const server = await query('ProxyServer')
    const m = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(server)
    return m ? m[1]! : '(已启用，但未读到地址)'
  } catch {
    return ''
  }
}

/** 判断一个 IP 是否落在 TUN / fake-ip 常用的保留段（198.18.0.0/15、198.19.0.0/15） */
export function isFakeIp(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  const [a, b] = parts
  return a === 198 && (b === 18 || b === 19)
}

/**
 * 判断是否为**公网可路由**地址（与社区通用 `isPublicAddress` 一致）。
 *
 * ## 为什么需要
 *
 * 优选器要测的是「本机直连某个公网 IP 的真实质量」。
 * 若候选里混进私网/保留地址（`127.0.0.1`、`192.168.x`、`10.x`、`100.64.x` …），
 * 连接会以不同方式失败（拒绝 / 超时 / 连到自己的路由器），
 * 表现为「这个 IP 不可用」—— 但结论毫无意义，白白浪费一次探测。
 *
 * 用户粘贴的列表、远程 API 返回的列表都可能含这类地址。
 *
 * ## 覆盖的保留段
 *
 * IPv4：
 *   - `0.0.0.0/8`      本网络
 *   - `10.0.0.0/8`     私网
 *   - `127.0.0.0/8`    环回
 *   - `169.254.0.0/16` 链路本地
 *   - `172.16.0.0/12`  私网
 *   - `192.168.0.0/16` 私网
 *   - `100.64.0.0/10`  CGNAT（运营商级 NAT）
 *   - `198.18.0.0/15`  基准测试（含 Clash/Mihomo 的 fake-ip）
 *   - `224.0.0.0/4`    组播
 *   - `240.0.0.0/4`    保留
 *
 * IPv6：只放行全局单播 `2000::/3`（排除文档段 `2001:db8::/32` 等）。
 *
 * @param ip 点分十进制 IPv4 或冒号分隔 IPv6
 */
export function isPublicAddress(ip: string): boolean {
  const value = ip.trim()
  if (!value) return false

  // IPv4
  if (!value.includes(':')) {
    const parts = value.split('.')
    if (parts.length !== 4) return false
    const nums: number[] = []
    for (const p of parts) {
      if (!/^\d{1,3}$/.test(p)) return false
      const n = Number(p)
      if (n > 255) return false
      nums.push(n)
    }
    const [a, b] = nums as [number, number, number, number]
    if (a === 0) return false // 0.0.0.0/8 本网络
    if (a === 10) return false // 10.0.0.0/8 私网
    if (a === 127) return false // 127.0.0.0/8 环回
    if (a >= 224) return false // 224.0.0.0/4 组播 + 240.0.0.0/4 保留
    if (a === 169 && b === 254) return false // 链路本地
    if (a === 172 && b >= 16 && b <= 31) return false // 172.16.0.0/12
    if (a === 192 && b === 168) return false // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return false // 100.64.0.0/10 CGNAT
    if (a === 198 && (b === 18 || b === 19)) return false // 198.18.0.0/15 fake-ip
    return true
  }

  // IPv4-mapped IPv6（::ffff:1.2.3.4）
  const lower = value.toLowerCase()
  if (lower.startsWith('::ffff:') && lower.includes('.')) {
    return isPublicAddress(lower.slice(7))
  }

  // IPv6：只放行全局单播 2000::/3（即首字节 0x20~0x3f）
  const groups = lower.split(':')
  if (groups.length < 3) return false
  const first = groups[0]!
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false
  const firstByte = Number.parseInt(first.slice(0, 2).padEnd(2, '0'), 16)
  if (firstByte < 0x20 || firstByte > 0x3f) return false
  // 文档 / 基准测试段
  if (lower.startsWith('2001:db8:')) return false
  return true
}

/**
 * 检测本机网络环境。
 *
 * @param host 可选：待测域名。给了就顺带做 fake-ip 解析检查。
 */
export async function detectProxyInterference(host?: string): Promise<NetEnvResult> {
  const findings: ProxyFinding[] = []

  // 1) 本地代理端口
  const listening: string[] = []
  await Promise.all(
    PROXY_PORTS.map(async ({ port, name }) => {
      if (await isPortListening(port)) listening.push(`${name} → 127.0.0.1:${port}`)
    })
  )
  if (listening.length > 0) {
    findings.push({
      message: '本机有代理程序在监听：\n     ' + listening.join('\n     '),
      advice: '关闭这些代理程序，或在其中把本程序加入直连/绕过名单',
    })
  }

  // 2) 系统代理
  const sysProxy = await readSystemProxy()
  if (sysProxy) {
    findings.push({
      message: `系统代理已启用：${sysProxy}`,
      advice: '在「设置 → 网络和 Internet → 代理」中关闭系统代理',
    })
  }

  // 3) fake-ip / TUN
  const probeHost = host?.trim() || 'www.cloudflare.com'
  try {
    const { resolve4 } = await import('node:dns/promises')
    const ips = await resolve4(probeHost).catch(() => [] as string[])
    const fake = ips.find((ip) => isFakeIp(ip))
    if (fake) {
      findings.push({
        message: `DNS 把 ${probeHost} 解析到 ${fake}（198.18/15 保留段），TUN / fake-ip 正在生效`,
        advice: '关闭代理工具的 TUN 模式与 fake-ip DNS',
      })
    }
  } catch {
    /* DNS 不可用不阻断 */
  }

  return { clean: findings.length === 0, findings }
}

/**
 * 判断一个 WS 路径参数是否被 MSYS（Git-Bash）污染。
 *
 * 抽成纯函数便于测试 —— 这类「静默失败」的坑值得有回归测试守住。
 * 放在 net-env 而不是 cli.ts：测试 import cli.ts 会触发其模块级 main()，
 * 导致 vitest 进程被 process.exit 掉。
 */
export function isMsysPollutedPath(value: string): boolean {
  const looksWindows = /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')
  const hasMsysHint = /node_modules|bash-win32|@dsh-ops|msys/i.test(value)
  return looksWindows || hasMsysHint
}
