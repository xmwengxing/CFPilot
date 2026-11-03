/**
 * IPv6 环境预检
 *
 * ## 为什么必须先预检
 *
 * IPv6 候选是**字面量地址**，与本机有没有可用的 IPv6 出口完全无关 ——
 * 本机不通 v6 时，成千上万个 v6 候选会**全部超时**，
 * 表现为「候选里一半是废的、阶段一之后所剩无几」，
 * 而且这些失败若被写进网络档案，会把「本机没 v6」学成「v6 网段不可用」，
 * **永久毒化历史**。
 *
 * 2026-11-03 本机实测：有原生 `240e::/64` 地址与默认路由，
 * 但到部分国际目标仍超时 —— 所以**只有地址不等于能用**，
 * 必须再做一次金丝雀连通性探测。
 *
 * ## 三态
 *
 * | status | 含义 | `auto` 模式下的处理 |
 * |---|---|---|
 * | `ok` | 有公网地址 + 有默认路由 + 金丝雀连通 | 正常参与 v6 采样 |
 * | `no-address` | 没有 `2000::/3` 公网地址 | 回退纯 v4，**不写观测** |
 * | `no-route` | 有地址但没有默认 IPv6 路由 | 回退纯 v4，**不写观测** |
 * | `no-internet` | 有地址有路由但金丝雀全失败 | 回退纯 v4，**不写观测** |
 *
 * ⚠️ 显式 `--family v6` / `both` 时**不阻断**，只把结论交给调用方提示 ——
 * 用户明确要扫 v6 就让他扫，静默改成纯 v4 反而无法解释「为什么一条都没有」。
 */
import { networkInterfaces } from 'node:os'
import { execFile } from 'node:child_process'
import net from 'node:net'

export type IPv6EnvStatus = 'ok' | 'no-address' | 'no-route' | 'no-internet'

export interface IPv6EnvResult {
  status: IPv6EnvStatus
  /** 本机选中的公网 IPv6 地址（无则空） */
  address: string
  /** 该地址所在网卡名（无则空） */
  interfaceName: string
  /** 是否存在默认 IPv6 路由；null = 未能判定（平台命令不可用 / 超时） */
  hasDefaultRoute: boolean | null
  /** 金丝雀探测统计 */
  canaryTried: number
  canaryOk: number
  /** 面向用户的结论（含「当前网络环境不具备 IPv6 测速条件」这一固定前缀） */
  message: string
  /** 排查建议，逐条给 */
  advice: string[]
  /** 预检耗时（ms），写进 --json 报告 */
  elapsedMs: number
}

/** 预检可选项：全部可注入，便于单测不碰真实网络、也不依赖本机网卡 */
export interface DetectIPv6EnvOptions {
  /**
   * 金丝雀地址：**必须来自实测活跃 /48**，随便挑公布段地址会 100% 超时，
   * 于是「环境没问题」也会被判成 `no-internet`。
   * 为空时跳过金丝雀，只用「地址 + 路由」判定。
   */
  canary?: readonly string[]
  /** 每个金丝雀的连接超时（ms） */
  timeoutMs?: number
  /** 本机公网地址探测（可注入，单测里替换成假实现） */
  localProbe?: () => { address: string; interfaceName: string } | null
  /** 默认路由探测（可注入，单测里替换成假实现） */
  routeProbe?: () => Promise<boolean | null>
  /** 金丝雀连通性探测（可注入，单测里替换成假实现） */
  canaryProbe?: (address: string) => Promise<boolean>
}

/** 虚拟网卡名里常见的关键词：这些网卡上的「公网地址」不代表本机能上 v6。 */
const LOOPBACK_NAMES = new Set(['lo', 'loopback', 'loopback0'])

/**
 * 是否为公网全局单播 IPv6（`2000::/3`）。
 *
 * 只放行 `2000::/3`（首 3 位 = 001，即首个十六进制位为 2 或 3），
 * 一次性排除：链路本地 `fe80::/10`、唯一本地 `fc00::/7`（虚拟组网常用）、
 * 组播 `ff00::/8`、环回 `::1`、未指定 `::`、IPv4 映射 `::ffff:x`。
 */
export function isGlobalUnicastIPv6(raw: string): boolean {
  const addr = raw.split('%')[0]!.trim().toLowerCase()
  if (!addr.includes(':')) return false
  if (addr === '::' || addr === '::1') return false
  if (addr.startsWith('::ffff:')) return false
  const parts = addr.split(':')
  const first = parts[0]!
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false
  const hextet = parseInt(first, 16)
  // 2000::/3 → 高 3 位为 001
  if ((hextet & 0xe000) !== 0x2000) return false
  // 2001:db8::/32（文档地址）与 2001::/32（Teredo）不是可用的接入地址。
  // ⚠️ `2001::1` 的 split(':') 第二段是空串，parseInt('') 是 NaN 而不是 0，
  //    必须先判空再解析，否则 Teredo 会被当成合法地址放行。
  if (hextet === 0x2001) {
    const secondText = parts[1]
    const second = secondText ? parseInt(secondText, 16) : 0
    if (second === 0x0db8 || second === 0x0000 || Number.isNaN(second)) return false
  }
  return true
}

/** 扫描本机网卡，取第一个公网全局单播 IPv6 地址。 */
export function findGlobalIPv6(): { address: string; interfaceName: string } | null {
  const interfaces = networkInterfaces()
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue
    if (LOOPBACK_NAMES.has(name.toLowerCase())) continue
    for (const entry of addrs) {
      if (entry.internal) continue
      // family 在不同 Node 版本里可能是 'IPv6' 也可能是 6，统一转成字符串再比
      const family = String(entry.family)
      if (family !== 'IPv6' && family !== '6') continue
      if (!isGlobalUnicastIPv6(entry.address)) continue
      return { address: entry.address, interfaceName: name }
    }
  }
  return null
}

/**
 * 探测本机是否有默认 IPv6 路由（**尽力而为**，失败返回 null 而不是抛错）。
 *
 * 路由表没有跨平台的 Node API，只能调各平台自带命令：
 *   - Windows：`route print -6` 里找 `::/0`（与界面语言无关，字面量稳定）
 *   - Linux  ：`ip -6 route show default`
 *   - macOS  ：`netstat -rn -f inet6` 里找 `default`
 *
 * 任何一步失败（命令不存在 / 超时 / 权限）都返回 null ——
 * 路由判定是**加分项**，不能因为它让整个预检崩掉。
 */
export async function probeDefaultRoute(timeoutMs = 800): Promise<boolean | null> {
  const platform = process.platform
  const run = (cmd: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err && !stdout) reject(err)
        else resolve(String(stdout ?? ''))
      })
      child.on('error', reject)
    })

  try {
    if (platform === 'win32') {
      const out = await run('route', ['print', '-6'])
      return out.includes('::/0')
    }
    if (platform === 'darwin') {
      const out = await run('netstat', ['-rn', '-f', 'inet6'])
      return /^default\b/m.test(out)
    }
    const out = await run('ip', ['-6', 'route', 'show', 'default'])
    return /^default\b/m.test(out)
  } catch {
    return null
  }
}

/** 单个金丝雀地址的 TCP 连通性（与扫描阶段一同一口径）。 */
function tcpReachable(address: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* 已销毁 */
      }
      resolve(ok)
    }
    const socket = new net.Socket()
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    // 金丝雀只验「本机 → 该地址的 TCP 是否通」，端口固定 443（CF 的 TLS 端口）
    socket.connect(port, address)
  })
}

/** 面向用户的固定前缀：与界面提示保持同一句话。 */
const NOT_READY = '当前网络环境不具备 IPv6 测速条件'

function buildAdvice(status: IPv6EnvStatus): string[] {
  switch (status) {
    case 'no-address':
      return [
        '网卡上没有 2000::/3 的公网 IPv6 地址（仅有 fe80:: 链路本地或 fc00::/7 虚拟地址不算）',
        '确认光猫/路由器已开启 IPv6，且系统网卡未禁用 IPv6 协议',
        '部分虚拟组网工具会接管 IPv6，可先退出再试',
      ]
    case 'no-route':
      return [
        '有公网 IPv6 地址，但路由表里没有默认 IPv6 路由（::/0）',
        '检查路由器是否下发 RA、系统是否拿到了网关',
        '可先断开 VPN/代理后重试，确认是它吃掉了 v6 路由',
      ]
    case 'no-internet':
      return [
        '有地址也有默认路由，但金丝雀目标全部连不通',
        '常见原因：代理工具的 TUN 模式接管了 IPv6 但没有可用出口',
        '也可能是运营商 IPv6 国际出口异常（国内目标通、国际目标不通）',
        '用 `cfpilot scan --family v6 --json` 可单独复查并看失败分布',
      ]
    default:
      return []
  }
}

/**
 * 执行 IPv6 环境预检。
 *
 * 顺序：**地址 → 路由 → 金丝雀**，任一步失败立即定性返回，
 * 不再往下浪费时间（金丝雀默认 1.5s × N，全失败也要等一轮）。
 */
export async function detectIPv6Env(options: DetectIPv6EnvOptions = {}): Promise<IPv6EnvResult> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? 1500
  const localProbe = options.localProbe ?? findGlobalIPv6
  const routeProbe = options.routeProbe ?? probeDefaultRoute
  const canaryProbe = options.canaryProbe ?? ((ip: string) => tcpReachable(ip, 443, timeoutMs))

  const local = localProbe()
  if (!local) {
    return {
      status: 'no-address',
      address: '',
      interfaceName: '',
      hasDefaultRoute: null,
      canaryTried: 0,
      canaryOk: 0,
      message: `${NOT_READY}：本机没有可用的公网 IPv6 地址`,
      advice: buildAdvice('no-address'),
      elapsedMs: Date.now() - started,
    }
  }

  const hasDefaultRoute = await routeProbe()
  if (hasDefaultRoute === false) {
    return {
      status: 'no-route',
      address: local.address,
      interfaceName: local.interfaceName,
      hasDefaultRoute: false,
      canaryTried: 0,
      canaryOk: 0,
      message: `${NOT_READY}：有 IPv6 地址但没有默认 IPv6 路由`,
      advice: buildAdvice('no-route'),
      elapsedMs: Date.now() - started,
    }
  }

  const canary = options.canary ?? []
  if (canary.length === 0) {
    // 没有可用的金丝雀（活跃前缀池为空）：地址与路由都正常就放行，
    // 由调用方决定是否生成候选 —— 这里不替调用方做「有没有候选」的判断。
    return {
      status: 'ok',
      address: local.address,
      interfaceName: local.interfaceName,
      hasDefaultRoute,
      canaryTried: 0,
      canaryOk: 0,
      message: `IPv6 环境可用（${local.address} @ ${local.interfaceName}，未做金丝雀探测）`,
      advice: [],
      elapsedMs: Date.now() - started,
    }
  }

  const results = await Promise.all(canary.map((ip) => canaryProbe(ip)))
  const canaryOk = results.filter(Boolean).length
  if (canaryOk === 0) {
    return {
      status: 'no-internet',
      address: local.address,
      interfaceName: local.interfaceName,
      hasDefaultRoute,
      canaryTried: canary.length,
      canaryOk,
      message: `${NOT_READY}：金丝雀目标 ${canary.length} 个全部连不通`,
      advice: buildAdvice('no-internet'),
      elapsedMs: Date.now() - started,
    }
  }

  return {
    status: 'ok',
    address: local.address,
    interfaceName: local.interfaceName,
    hasDefaultRoute,
    canaryTried: canary.length,
    canaryOk,
    message: `IPv6 环境可用（${local.address} @ ${local.interfaceName}，金丝雀 ${canaryOk}/${canary.length}）`,
    advice: [],
    elapsedMs: Date.now() - started,
  }
}
