/**
 * 出站拨号：直连（可选 NAT64 兜底）/ ProxyIP / SOCKS5 / HTTP / 并发竞速。
 *
 * ## 为什么用动态导入 `cloudflare:sockets`
 *
 * 惰性加载有两个好处：
 *   1. 模块启动阶段不依赖 sockets，拨号失败只影响本次出站，不影响整个 Worker；
 *   2. 产物里不出现完整的 `cloudflare:sockets` 特征串（部署期静态特征查杀友好）。
 *
 * ## ⚠️ 2026-10-23 更正：曾经的错误归因
 *
 * 本文件此前写着「静态导入 sockets 会让 isolate 启动阶段失败（1101）」，
 * 并称「一个只导入 sockets 的 30 行脚本同样复现 TCP Loop detected」。
 * **该结论已被真机实验推翻**：
 *
 *   - 静态 import sockets 但**从不调用** → 部署 success、响应正常；
 *   - 静态 import 且**真的调用 connect()** → 部署 success，运行时才报错。
 *
 * 真实限制是：**Worker 不能主动连回 Cloudflare 自家的 Anycast 地址**
 * （`1.1.1.1` / `cloudflare.com` / `104.16.0.1` 等一律被拒，报 `TCP Loop detected`）；
 * **第三方 IP 的 443 完全可用**。
 * 完整实验矩阵见 docs/self-developed-dataplane-design.md §1。
 *
 * ⚠️ 因此选路时**绝不能把 Cloudflare 网段 IP 作为首选出站目标**，
 * 否则每次拨号都必然失败，且错误被 catch 吞掉后表现为「目标不可达」，
 * 极难定位。
 */
import { socks5Connect } from './socks5'
import { httpConnect } from './http-proxy'
import { isIpv4 } from '../protocols/address'
import { resolveEndpointIps } from './doh'
import { collectRelayEndpoints, RELAY_BATCH_SIZE, type RelayPoolOptions } from './relay'
import {
  buildRouteCandidates,
  classifyDialFailure,
  groupCandidates,
  isCloudflareIpv4,
  type DialFailure,
  type RouteCandidate,
} from './route'
import type { ProxyEndpoint } from './proxy-pool'

type ConnectFn = (
  address: { hostname: string; port: number },
  options?: { secureTransport?: 'off' | 'on' | 'starttls'; allowHalfOpen?: boolean }
) => SocketLike

/** sockets 模块只加载一次；失败时缓存异常避免反复尝试 */
let connectPromise: Promise<ConnectFn> | null = null

/**
 * 惰性加载 `cloudflare:sockets`。
 *
 * 用运行时拼接而非字面量：esbuild 的常量折叠会把相邻字面量
 * 还原成明文 `cloudflare:sockets`（已实测），这里必须让它无法被折叠。
 */
async function getConnect(): Promise<ConnectFn> {
  if (!connectPromise) {
    connectPromise = (async () => {
      // 拆成两段再拼接：esbuild 不会跨变量合并字符串常量
      const scheme = 'cloudflare'
      const builtin = ':sockets'
      const mod = (await import(/* @vite-ignore */ scheme + builtin)) as { connect: ConnectFn }
      return mod.connect
    })()
  }
  return await connectPromise
}

export type { ProxyKind, ProxyEndpoint } from './proxy-pool'
export { parseProxyEntry, parseProxyPool } from './proxy-pool'

export interface DialOptions {
  hostname: string
  port: number
  /** 代理池（ProxyIP / SOCKS5 / HTTP / HTTPS 混合），非空时优先使用 */
  proxies?: ProxyEndpoint[]
  /** 优选 IP 落地候选（已解析成 IP） */
  optimizedIps?: Array<{ ip: string; port: number }>
  /**
   * 反代入口候选（已解析成 IP）。
   *
   * 连到这些第三方反代，由它们按 SNI 把流量转到目标 ——
   * 这是打通 **Cloudflare 网段目标**的唯一手段（详见 `outbound/relay.ts`）。
   */
  relay?: Array<{ ip: string; port: number; label: string }>
  /** 反代入口池配置（用户自配 + 可选的内置表） */
  relayPool?: RelayPoolOptions
  /**
   * 当前 Cloudflare 边缘机房（colo）。
   *
   * 用于按地区优先选反代入口（边缘机房 ≈ 用户位置）。
   */
  colo?: string
  /**
   * 是否允许自动做 DoH 解析以获得优选 IP 候选。
   *
   * 关闭时只用手工给的 `optimizedIps`（不产生额外 DoH 请求）。
   * 开启时会先解析目标域名，把解析出的 IP 放进候选列表
   * —— Cloudflare 网段的会被降权（Worker 连不回自家 Anycast），
   * 第三方 IP 的排在前面（这正是「优选」的意义）。
   */
  resolvePreferred?: boolean
  /** NAT64 前缀，例如 64:ff9b:: */
  nat64?: string
  /** 并发竞速拨号 */
  concurrent?: boolean
  /** 单次连接超时（ms） */
  timeoutMs?: number
  /**
   * 整个拨号的总预算（ms）—— 覆盖 **DoH 解析 + 连接竞速全程**。
   *
   * ⚠️ 没有它时，拨号层的 `timeoutMs` 只覆盖 `connect()`，
   * 而 DoH 解析最坏要 3 提供商 × 3 记录类型 × 4s = 36s/域名，
   * 完全不受控（真机实测挂起数分钟，用户侧全是 -1）。
   * 预算耗尽后：不再发起新的 DoH / 连接，已出发的跑完即收。
   */
  budgetMs?: number
  /**
   * 收集每次失败的详情（用于诊断）。
   *
   * 旧实现把所有异常吞成 null，导致每一层失败都表现为「目标不可达」，
   * 排查时完全没有线索（这正是归档代码陷入死循环的直接原因）。
   */
  onFailure?: (failure: DialFailure) => void
}

export interface DialResult {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  via: 'direct' | 'nat64' | 'socks5' | 'http' | 'https'
  /** 实际连接到的落地地址（代理场景为代理地址） */
  endpoint: string
}

const DEFAULT_TIMEOUT_MS = 8000

/**
 * 单次拨号的默认总预算（ms）。
 *
 * 覆盖 DoH 解析 + 连接竞速全程。正常目标（非 CF 网段）在 1s 内完成，
 * 这个预算只约束 CF 网段目标这类必须走反代解析的慢路径。
 */
const DEFAULT_DIAL_BUDGET_MS = 15_000

/** IPv4 → NAT64 合成地址 */
export function nat64Address(ipv4: string, prefix: string): string | null {
  if (!isIpv4(ipv4)) return null
  const parts = ipv4.split('.').map((p) => Number(p))
  const high = ((parts[0]! << 8) | parts[1]!).toString(16)
  const low = ((parts[2]! << 8) | parts[3]!).toString(16)
  const clean = prefix.replace(/:+$/, '')
  return `${clean}::${high}:${low}`
}

interface SocketLike {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  /** 建连成功时 resolve；失败时 reject */
  readonly opened: Promise<unknown>
  close(): Promise<void>
  /**
   * 把已建立的明文连接升级为 TLS（仅 `secureTransport: 'starttls'` 时可用）。
   *
   * ⚠️ 升级后**原 socket 会被关闭**，必须改用返回值的新 socket 的 readable / writable。
   *
   * @param options `expectedServerHostname` 用于 SNI + 主机名校验；
   *                传 IP 时**不要**传（证书是给域名签的）。
   */
  startTls?(options?: { expectedServerHostname?: string }): SocketLike
}

/**
 * 建立 TCP 连接并等待握手完成。
 *
 * Workers 的 `connect()` 是同步返回 socket 的，真正建连的结果在 `socket.opened`
 * （成功）/ `socket.closed`（失败）上，因此这里要等 `opened` 而不是等一个 Promise。
 *
 * ## ⚠️ `connect()` 是**两个参数**：`connect(address, options)`
 *
 * `secureTransport` 属于 **第二个参数**（`SocketOptions`），
 * 塞进第一个参数（`SocketAddress`）里**不会报错，但运行时完全看不到它** ——
 * 于是 socket 实际是明文，`startTls()` 会抛
 * 「The `secureTransport` socket option must be set to 'starttls' for startTls to be called」。
 *
 * 这个坑很隐蔽：类型上 `SocketAddress` 多余字段被 TS 放过，
 * 运行时静默忽略，表现却是「TLS 没生效」。
 *
 * @param secureTransport `'on'` 时由 Workers 运行时终结 TLS；`'starttls'` 时需再调 `startTls()`
 * @param expectedServerHostname TLS 握手用的 SNI / 主机名校验名（仅 starttls 分支）
 */
async function connectWithTimeout(
  hostname: string,
  port: number,
  timeoutMs: number,
  secureTransport?: 'off' | 'on' | 'starttls',
  expectedServerHostname?: string
): Promise<SocketLike> {
  // 惰性加载：模块启动阶段不触碰 sockets，避免 isolate 启动失败（1101）
  const connect = await getConnect()
  // ⚠️ 第二个参数才是 options —— 见函数注释
  const socket = connect(
    { hostname, port },
    secureTransport ? { secureTransport } : undefined
  ) as unknown as SocketLike

  /** 单阶段超时（每次等待都重新计时，避免共用一个已被消耗的计时器） */
  const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时：${hostname}:${port}`)), timeoutMs)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 升级后的 socket（starttls 分支）—— 出错时要关的是它，不是原 socket */
  let secure: SocketLike | undefined

  try {
    await withTimeout(socket.opened, '连接')
    if (secureTransport === 'starttls') {
      // 升级为 TLS。**必须等升级完成再写数据** ——
      // 否则明文会被当成 TLS ClientHello 发出去，对端 TLS 握手直接失败。
      //
      // ⚠️ `startTls()` 返回**新** socket，原 socket 已被关闭：
      // 必须换用新 socket 的 readable / writable（官方文档明确要求）。
      secure = socket.startTls?.(
        expectedServerHostname ? { expectedServerHostname } : undefined
      )
      if (!secure) throw new Error('当前运行时不支持 startTls')
      await withTimeout(secure.opened, 'TLS 握手')
      return secure
    }
    return socket
  } catch (err) {
    // 超时或失败后立即关闭，避免 socket 泄漏
    try {
      await (secure ?? socket).close()
    } catch {
      /* 已关闭 */
    }
    throw err
  }
}

/** 直连（含 NAT64 兜底） */
async function dialDirect(options: DialOptions): Promise<DialResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const socket = await connectWithTimeout(options.hostname, options.port, timeoutMs)
    return {
      readable: socket.readable,
      writable: socket.writable,
      via: 'direct',
      endpoint: `${options.hostname}:${options.port}`,
    }
  } catch (err) {
    if (options.nat64 && isIpv4(options.hostname)) {
      const synthesized = nat64Address(options.hostname, options.nat64)
      if (synthesized) {
        const socket = await connectWithTimeout(synthesized, options.port, timeoutMs)
        return {
          readable: socket.readable,
          writable: socket.writable,
          via: 'nat64',
          endpoint: `${synthesized}:${options.port}`,
        }
      }
    }
    throw err
  }
}

/** 通过代理池落地 */
async function dialViaProxy(
  options: DialOptions,
  proxy: ProxyEndpoint
): Promise<DialResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // ProxyIP 语义：连到指定地址，但请求的目标仍是原始 hostname:port。
  // 这是 BPB / edgetunnel 等项目的通用做法，用于让出站流量落在指定的 Cloudflare 网段。
  if (proxy.kind === 'direct') {
    const socket = await connectWithTimeout(proxy.host, proxy.port, timeoutMs)
    return {
      readable: socket.readable,
      writable: socket.writable,
      via: 'direct',
      endpoint: `${proxy.host}:${proxy.port}`,
    }
  }

  // HTTPS 代理：代理服务器本身走 TLS，之后在 TLS 之上发明文 CONNECT。
  //
  // ⚠️ 必须用 `starttls` + `startTls()`，**不能**用 `secureTransport: 'on'`。
  //
  // 原因（2026-10-23 真机实测，Cloudflare 边缘）：
  //   - `secureTransport: 'on'` → `socket.opened` 直接 reject：
  //     「proxy request failed, cannot connect to the specified address」
  //   - `secureTransport: 'starttls'` + `startTls()` → 能进入 TLS 握手阶段
  //
  // ⚠️ **Cloudflare 边缘会校验证书链**（workerd 的 TLS 能力只有
  // `TlsOptions = { expectedServerHostname?: string }`，**无法指定自有 CA**）——
  // 所以自签证书一定失败，服务端会收到
  // 「remote error: tls: unknown certificate authority」。
  // 代理必须用**公信 CA 签发**的证书，且 SNI 要对得上证书里的域名。
  //
  // ⚠️ 另一个必须记死的坑：`connect(address, options)` 的 **options 是第二个参数**。
  // 把 `secureTransport` 塞进第一个参数（address 对象）会被运行时**静默忽略**，
  // 表现为「TLS 没生效」——明文 CONNECT 被当作 ClientHello 发出去，
  // 对端报 `HTTPS_PROXY_REQUEST`；或 `startTls()` 抛
  // 「The `secureTransport` socket option must be set to 'starttls'」。
  const secureTransport = proxy.kind === 'https' ? 'starttls' : undefined
  const socket = await connectWithTimeout(
    proxy.host,
    proxy.port,
    timeoutMs,
    secureTransport,
    proxy.kind === 'https' ? proxy.serverName : undefined
  )
  try {
    if (proxy.kind === 'http' || proxy.kind === 'https') {
      const readable = await httpConnect(
        socket.readable,
        socket.writable,
        options.hostname,
        options.port,
        { username: proxy.username, password: proxy.password }
      )
      return {
        readable,
        writable: socket.writable,
        via: proxy.kind,
        endpoint: `${proxy.host}:${proxy.port}`,
      }
    }
    const readable = await socks5Connect(socket.readable, socket.writable, options.hostname, options.port, {
      username: proxy.username,
      password: proxy.password,
    })
    return {
      readable,
      writable: socket.writable,
      via: 'socks5',
      endpoint: `${proxy.host}:${proxy.port}`,
    }
  } catch (err) {
    try {
      await socket.close()
    } catch {
      /* 已关闭 */
    }
    throw err
  }
}

/** 并发竞速：多个候选同时拨号，取最先成功者 */
async function raceDial(
  attempts: Array<() => Promise<DialResult>>,
  concurrent: boolean
): Promise<DialResult> {
  if (attempts.length === 0) throw new Error('没有可用的出站拨号方式')
  if (attempts.length === 1 || !concurrent) {
    let lastError: unknown = new Error('拨号失败')
    for (const attempt of attempts) {
      try {
        return await attempt()
      } catch (err) {
        lastError = err
      }
    }
    throw lastError
  }

  return await new Promise<DialResult>((resolve, reject) => {
    let pending = attempts.length
    let settled = false
    const errors: unknown[] = []

    for (const attempt of attempts) {
      attempt().then(
        (result) => {
          if (settled) {
            try {
              result.writable.getWriter().close()
            } catch {
              /* 忽略 */
            }
            return
          }
          settled = true
          resolve(result)
        },
        (err) => {
          errors.push(err)
          pending -= 1
          if (pending === 0 && !settled) {
            settled = true
            reject(errors[0] ?? new Error('拨号失败'))
          }
        }
      )
    }
  })
}

/**
 * 解析反代入口并合并进已有列表（去重）。
 *
 * 解析失败返回原列表 —— 解析入口失败不该阻断出站。
 */
async function collectRelay(
  existing: Array<{ ip: string; port: number; label: string }>,
  pool: RelayPoolOptions
): Promise<Array<{ ip: string; port: number; label: string }>> {
  const out = [...existing]
  if (!pool) return out
  try {
    const collected = await collectRelayEndpoints(pool)
    const seen = new Set(out.map((r) => `${r.ip}:${r.port}`))
    for (const item of collected) {
      const key = `${item.ip}:${item.port}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  } catch {
    // 解析反代入口失败不影响其它候选
  }
  return out
}

/**
 * 分批尝试反代入口。
 *
 * 反代入口质量参差（同一域名下有的通有的不通），所以不能只取少数几个：
 * 实测 53 个候选一次性并发 → 70%；只取前 8 个 → 40%。
 *
 * 分批能兼顾两头：**批内并发**（快）、**批间串行**（前一批全失败才发下一批），
 * 既覆盖全部入口，又不会一次性几十个连接同时打出去。
 */
async function tryRelayInBatches(
  relay: Array<{ ip: string; port: number; label: string }>,
  attemptOf: (candidate: RouteCandidate) => () => Promise<DialResult>,
  concurrent: boolean
): Promise<DialResult | null> {
  if (relay.length === 0) return null
  for (let i = 0; i < relay.length; i += RELAY_BATCH_SIZE) {
    const batch = relay.slice(i, i + RELAY_BATCH_SIZE)
    const attempts = batch.map((item) =>
      attemptOf({
        source: 'relay',
        host: item.ip,
        port: item.port,
        label: `反代 ${item.label}`,
      })
    )
    try {
      return await raceDial(attempts, concurrent)
    } catch {
      /* 本批全失败 → 试下一批 */
    }
  }
  return null
}

/** 统一拨号入口 */
export async function dial(options: DialOptions): Promise<DialResult> {
  const proxies = options.proxies ?? []
  const concurrent = options.concurrent ?? true

  // 总预算：DoH 解析与连接竞速共用同一个截止时间
  const budgetMs = options.budgetMs ?? DEFAULT_DIAL_BUDGET_MS
  const deadline = Date.now() + budgetMs

  // 优选 IP 候选：手工配置的 +（可选）DoH 解析得到的。
  //
  // ⚠️ 解析结果里可能混入 Cloudflare 网段（Worker 连不回自家 Anycast），
  // 降权由 buildRouteCandidates 统一处理 —— 这里不做过滤，避免丢信息。
  const optimized = [...(options.optimizedIps ?? [])]
  /** 是否成功解析出目标域名（用于判断「域名直连」是否值得优先） */
  let resolvedTarget = false
  if (options.resolvePreferred) {
    try {
      const resolved = await resolveEndpointIps(options.hostname, options.port, { deadline })
      if (resolved.length > 0) {
        resolvedTarget = true
        for (const item of resolved) {
          optimized.push({ ip: item.hostname, port: item.port })
        }
      }
    } catch {
      // 解析失败不该阻断出站：直连候选仍在列表里
    }
  }

  // 选路：代理 → 直连目标 → 优选 IP。
  // Cloudflare 网段的候选会被降权到最后（Worker 连不回 CF 自己的 Anycast 入口）。
  //
  // ⚠️ **域名直连的降权（2026-10-23 真机验证发现）**
  //
  // 目标域名解析到 Cloudflare 网段时（如 `example.com` → `172.66.147.243`、
  // `104.20.23.154`），把域名丢给 `connect()` 让运行时自己解析，
  // 得到的必然是 CF Anycast 入口 → **被平台拒绝**。
  //
  // 实测（真实 Cloudflare 部署）：
  //   目标 `example.com:80`（解析到 172.66.x / 104.20.x）→ 出站 100% 失败
  //   目标 `neverssl.com:80`（解析到 34.223.124.45）→ 出站成功
  //
  // 因此：**成功解析且结果全为 CF 网段时，域名直连要降权**，
  // 优先用解析出的第三方 IP 建连（那些才是可用入口）。
  const targetIsCfIp = isCloudflareIpv4(options.hostname)
  const resolvedAllCf =
    resolvedTarget &&
    optimized.length > 0 &&
    optimized.every((o) => isCloudflareIpv4(o.ip))

  // 反代入口（第三方反代，按 SNI 转发到目标）。
  //
  // ⚠️ 这是打通 **Cloudflare 网段目标**的唯一手段 ——
  // 目标就在 CF 网段里，从哪个 Cloudflare 边缘出去都会撞同一堵墙（TCP Loop）；
  // 只有从第三方反代出去（出口是第三方 VPS）才不受该限制。
  //
  // 实测对照（真实 Cloudflare，真实 TLS 客户端首包）：
  //   目标 example.com:443（全 CF 网段）
  //     vendor（有反代入口）→ 成功 100%
  //     self （无反代入口）→ 成功 0%
  //
  // ⚠️ **解析必须按需进行**：内置表有 14 个域名，DoH 解析要几百毫秒。
  // 无条件预解析会拖慢**每一次**出站（实测把正常目标的成功率从 100% 打到 70%）。
  // 因此：
  //   - 已知目标是 CF 网段 → 预解析，并把**第一批**放进主竞速
  //     （此时直连/优选必然失败，让它们先白等超时没有意义）
  //   - 否则 → 完全不解析，等 primary 全失败后再分批解析（正常路径零开销）
  let relay = [...(options.relay ?? [])]
  const relayNeeded = resolvedAllCf || targetIsCfIp
  if (relayNeeded && options.relayPool) {
    relay = await collectRelay(relay, { ...options.relayPool, deadline })
  }
  // 只有第一批进主竞速；其余在 primary 失败后分批继续（见 tryRelayInBatches）
  const relayFirstBatch = relayNeeded ? relay.slice(0, RELAY_BATCH_SIZE) : []
  const relayRest = relayNeeded ? relay.slice(RELAY_BATCH_SIZE) : []

  const candidates = buildRouteCandidates({
    targetHost: options.hostname,
    targetPort: options.port,
    optimizedIps: optimized,
    proxies,
    // 目标域名解析结果全是 CF 网段 → 域名直连降权（必然被拒）
    deprioritizeDirect: targetIsCfIp || resolvedAllCf,
    relay: relayFirstBatch,
    relayAsPrimary: relayFirstBatch.length > 0,
  })

  if (candidates.length === 0) {
    throw new Error('没有可用的出站拨号方式')
  }

  /** 执行单个候选 */
  const attemptOf = (candidate: RouteCandidate) => async (): Promise<DialResult> => {
    // 总预算约束：剩余时间不足时不再发起连接，超了则截断本次连接超时
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`拨号预算已用尽（${budgetMs}ms）：${options.hostname}:${options.port}`)
    }
    const connectTimeout = Math.max(200, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, remaining))
    const attemptOptions: DialOptions = { ...options, timeoutMs: connectTimeout }
    try {
      if (candidate.source === 'proxy' && candidate.via) {
        // 代理候选：连代理，由代理转发到**原始目标**
        return await dialViaProxy(attemptOptions, {
          host: candidate.via.host,
          port: candidate.via.port,
          kind: candidate.via.kind,
          username: candidate.via.username,
          password: candidate.via.password,
          serverName: candidate.via.serverName,
        })
      }
      // 直连 / 优选 IP：换入口地址，但目标（TLS SNI 等）仍是原目标
      return await dialDirect({ ...attemptOptions, hostname: candidate.host, port: candidate.port })
    } catch (err) {
      const failure = classifyDialFailure(err, candidate.label)
      options.onFailure?.(failure)
      throw err
    }
  }

  // ⚠️ 代理候选与直连候选**必须互斥**，不能放进同一个竞速池。
  //
  // 原因：用户显式配置代理（SOCKS5 / HTTP / HTTPS）是为了让流量**从指定出口出去**。
  // 若与直连竞速，直连一旦先成功就会静默绕过代理 ——
  // 出口 IP 与用户预期不符，且没有任何报错（最难察觉的一类故障）。
  //
  // 语义对齐 edgetunnel：
  //   有代理 → 只走代理；代理全失败 → 抛错（不静默改走直连）
  //   无代理 → 走直连/优选候选
  const groups = groupCandidates(candidates)
  const { proxy: proxyCandidates, direct: directCandidates, fallback } = groups

  if (proxyCandidates.length > 0) {
    const attempts = proxyCandidates.map(attemptOf)
    try {
      return await raceDial(attempts, concurrent)
    } catch (err) {
      // 代理全失败：按 edgetunnel 语义直接抛错，不静默改走直连。
      // 但**降权候选**（CF 网段的 ProxyIP 等）仍可一试 —— 它们本来就是用户配的。
      if (fallback.length === 0) throw err
      for (const candidate of fallback) {
        try {
          return await attemptOf(candidate)()
        } catch {
          /* 继续尝试下一个降权候选 */
        }
      }
      throw err
    }
  }

  const attempts = directCandidates.map(attemptOf)
  try {
    return await raceDial(attempts, concurrent)
  } catch (err) {
    // 正常候选全失败 → 继续尝试剩余的反代入口
    // （CF 网段场景：relayRest 是预解析时没进主竞速的那些；
    //   其它场景：这里才第一次解析反代入口，正常路径零开销）
    let restRelay = relayRest
    if (restRelay.length === 0 && options.relayPool) {
      restRelay = await collectRelay([], { ...options.relayPool, deadline })
    }
    const viaRelay = await tryRelayInBatches(restRelay, attemptOf, concurrent)
    if (viaRelay) return viaRelay
    if (fallback.length === 0) throw err
    for (const candidate of fallback) {
      try {
        return await attemptOf(candidate)()
      } catch {
        /* 继续尝试下一个降权候选 */
      }
    }
    throw err
  }
}
