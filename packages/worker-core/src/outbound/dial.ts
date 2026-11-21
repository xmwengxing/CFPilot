/**
 * 出站拨号：直连（可选 NAT64 兜底）/ ProxyIP / SOCKS5 / HTTP / 并发竞速。
 *
 * ## 为什么用动态导入 `cloudflare:sockets`
 *
 * 惰性加载有两个好处：
 *   1. 模块启动阶段不依赖 sockets，拨号失败只影响本次出站，不影响整个 Worker；
 *   2. 产物里不出现完整的 `cloudflare:sockets` 特征串（部署期静态特征查杀友好）。
 *
 * ## ⚠️ 更正：曾经的错误归因
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
import { httpConnect, HANDSHAKE_TIMEOUT_MS } from './http-proxy'
import { blockedTarget, TargetBlockedError, IPV6_DIRECT_UNSUPPORTED } from './guard'
import {
  filterHealthy,
  recordProxyFailure,
  recordProxySuccess,
  TargetRejectedError,
} from './proxy-health'
import { isIpv4 } from '../protocols/address'
import { resolveEndpointIps } from './doh'
import { collectRelayEndpoints, RELAY_BATCH_SIZE, stableRelayIndex, type RelayPoolOptions } from './relay'
import {
  clearRelaySuccessMemory,
  confirmRelaySuccess,
  endpointKey,
  isEndpointCooled,
  penalizeRelayEndpoint,
  recordEndpointFailure,
  recordEndpointSuccess,
  relayEntryFromEndpoint,
  relaySuccessFor,
  rememberRelaySuccess,
  sortByEndpointHealth,
} from './endpoint-health'
import {
  buildRouteCandidates,
  classifyDialFailure,
  groupCandidates,
  isCloudflareIpv4,
  type DialFailure,
  type RouteCandidate,
} from './route'
import type { ProxyEndpoint } from './proxy-pool'
import type { ProxyKind } from '../types'
import type { ProxyMode } from '../types'

export type ConnectFn = (
  address: { hostname: string; port: number },
  options?: {
    secureTransport?: 'off' | 'on' | 'starttls'
    allowHalfOpen?: boolean
    /**
     * TLS 期望的主机名（SNI + 证书主机名校验）。
     *
     * ⚠️ 真机复核发现：只把它传给 `startTls()` **不生效** ——
     * 拿「证书签给别的域名」的 IP 实测，握手照样成功，而且对端收不到 SNI、
     * SNI 路由型代理直接 RST。必须同时放进 `connect()` 的 options。
     */
    expectedServerHostname?: string
  }
) => SocketLike

/** sockets 模块只加载一次；失败时缓存异常避免反复尝试 */
let connectPromise: Promise<ConnectFn> | null = null

/**
 * 惰性加载 `cloudflare:sockets`。
 *
 * 用运行时拼接而非字面量：esbuild 的常量折叠会把相邻字面量
 * 还原成明文 `cloudflare:sockets`（已实测），这里必须让它无法被折叠。
 *
 * 导出给**出站体检**（已废弃，由配置层时序参数取代）复用：它同样需要「先 TCP、
 * 再 startTls」这条链路，另写一份必然与这里的坑（惰性加载、startTls 换 socket）漂移。
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
export { getConnect }

export type { ProxyEndpoint } from './proxy-pool'
export type { ProxyKind } from '../types'
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
   * 命中「固定落地 IP」映射时预解析出的候选。
   *
   * 非空表示调用方已为该目标域名写明落地地址：跳过 DoH 轮询与不可控的
   * 域名直连，只连这些地址 —— 落点确定，不再随 DNS 轮询漂移。
   */
  pinnedIps?: Array<{ ip: string; port: number }>
  /**
   * 命中「固定反代入口」映射（`域名=r:IP`）时的反代入口候选。
   *
   * 目标本身在 Cloudflare 网段时直连任何落地 IP 都会被 TCP Loop 拒绝，
   * 只能靠反代按 SNI 转发；这里写明的入口会**优先于反代池的粘性哈希**
   * 被单拨 —— 用于固定实测最快的入口（如 cloudflare.com）。
   */
  pinnedRelays?: Array<{ ip: string; port: number }>
  /**
   * 是否允许自动做 DoH 解析以获得优选 IP 候选。
   *
   * 关闭时只用手工给的 `optimizedIps`（不产生额外 DoH 请求）。
   * 开启时会先解析目标域名，把解析出的 IP 放进候选列表
   * —— Cloudflare 网段的会被降权（Worker 连不回自家 Anycast），
   * 第三方 IP 的排在前面（这正是「优选」的意义）。
   */
  resolvePreferred?: boolean
  /**
   * 是否跳过 TXT 优选库查询（默认 true）。
   *
   * TXT 优选库是 opt-in 的高级功能；主路径默认跳过，避免串行遍历多家
   * 境外 DoH 把首包拖到 9~10 秒。显式传 false 时仍会查（解析能力在 doh.ts）。
   */
  skipTxt?: boolean
  /** NAT64 前缀，例如 64:ff9b:: */
  nat64?: string
  /** 并发竞速拨号 */
  concurrent?: boolean
  /**
   * 代理调度模式（见 `types.ts` 的 ProxyMode）。
   *
   * 决定「配了代理之后，出站流量按什么顺序尝试各条通道」。
   * 默认 `only`（有代理只走代理，绝不静默改走直连）。
   */
  proxyMode?: ProxyMode
  /** 单次连接超时（ms） */
  timeoutMs?: number
  /**
   * DoH 解析的独立短预算（ms）。
   *
   * 由 `buildDialOptions` 从 `config.dohBudgetMs` 注入；未传时回落到
   * `DOH_FAST_BUDGET_MS`(1200)。超时就放弃解析、直接用域名直连候选，
   * 不让整条请求陪着境外 DoH 等 4~10 秒。
   */
  dohBudgetMs?: number
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
   * **单次候选尝试**的绝对截止时间（epoch ms，内部使用）。
   *
   * 早前每阶段（TCP 建连 / TLS 升级 / 代理握手 / NAT64 重试）各自用同一份
   * `timeoutMs`，一个候选最坏能吃掉 2~3 倍剩余预算，多候选累加就会超出
   * `budgetMs`。现在由 `attemptOf` 算出「本次尝试的绝对截止」并贯穿各阶段，
   * 每阶段的有效超时取 `min(阶段上限, 剩余)`。
   */
  deadline?: number
  /**
   * 收集每次失败的详情（用于诊断）。
   *
   * 旧实现把所有异常吞成 null，导致每一层失败都表现为「目标不可达」，
   * 排查时完全没有线索（这正是归档代码陷入死循环的直接原因）。
   */
  onFailure?: (failure: DialFailure) => void
  /**
   * 跳过目标地址策略（SSRF 黑名单）。
   *
   * 只有「拨号的对象不是用户目标」时才置位 —— 反代入口就是这种：
   * 它是我们自己选的落地服务器，不是客户端请求的目的地。
   * 普通目标一律走策略判定（见 `outbound/guard.ts`）。
   */
  skipTargetPolicy?: boolean
}

export interface DialResult {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  via: 'direct' | 'nat64' | 'socks5' | 'http' | 'https'
  /** 实际连接到的落地地址（代理场景为代理地址） */
  endpoint: string
  /** 本次连接是否经过第三方反代入口（用于上层识别 TLS 致命告警 / 假活熔断与成功记忆回写） */
  isRelay?: boolean
  /**
   * 关闭底层 TCP Socket（可读 + 可写一起关）。
   *
   * ## 为什么需要它
   *
   * Cloudflare 的 `connect()` 返回的 Socket 提供 `close()`，语义是**同时**关闭
   * 可读与可写两端，并立即释放这条 TCP 连接占用的并发槽位（单请求上限 6 条）。
   * 而 `writable.close()` 只是「关闭写端」——在 Workers 上确实会连带关闭连接，
   * 但**不会中断另一头已经挂起的 reader.read()**：
   * 客户端提前断开、上游异常、假活重拨这些场景下，读任务会一直等到运行时/超时才回收。
   *
   * 因此把原始 Socket 的关闭能力（而不是只把 readable / writable 两个流）交给上层，
   * 由统一的生命周期清理函数调用一次。代理路径（socks5 / http / https）同样
   * 持有底层 socket，一并透出。
   *
   * 可选：测试桩与部分降级路径可能没有真实 Socket。
   */
  close?: () => void | Promise<void>
}

const DEFAULT_TIMEOUT_MS = 8000

/**
 * 「本次拨号总预算已用尽」——与「候选节点本身不可用」必须分开。
 *
 * 竞速里预算耗尽是**我们自己**的决定（或平台侧限制），把它记进端点健康记忆
 * 会把健康的反代入口 / 优选 IP 误判成宕机并拉入冷却，之后每个请求都少一批候选。
 * 因此用一个专用错误类型，`attemptOf` 的 catch 识别它后**不记账**。
 */
export class DialBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DialBudgetError'
  }
}

/**
 * 单次拨号的默认总预算（ms）。
 *
 * 覆盖 DoH 解析 + 连接竞速全程。正常目标（非 CF 网段）在 1s 内完成，
 * 这个预算只约束 CF 网段目标这类必须走反代解析的慢路径。
 */
const DEFAULT_DIAL_BUDGET_MS = 15_000

/**
 * DoH 解析的**独立**短预算（ms）。
 *
 * ## 为什么需要比总预算更紧
 *
 * 真机量化（2026-11-15）：首次访问一个未缓存的域名，TLS 握手完成要
 * 8.8~10.3 秒；同一域名第二次（DoH 缓存命中）只要 0.8~1.9 秒；
 * 而配了固定落地 IP（`pinnedHosts`，跳过 DoH）的域名首次仅 1.6 秒。
 * 差异只可能来自 DoH —— `resolveEndpointIps()` 串行阻塞在候选构建之前，
 * 其中 TXT 分支串行遍历多家境外 DoH（每家最多 4s），域名直连候选
 * 明明可以立刻开跑却要陪着等。
 *
 * 给 DoH 单独 1.2s 预算：超时就放弃解析、直接用域名直连候选
 * （它本来就在 `buildRouteCandidates` 里）。`doh.ts` 的 queryAll /
 * queryAllA 都按 deadline 夹 perQuery 预算，已在飞的查询也会被 AbortSignal
 * 超时，不会拖到 4s。缓存命中时（50~300ms）仍能拿到多源 A 聚合结果，
 * mixedCdn 防漂移语义不受影响。
 */
const DOH_FAST_BUDGET_MS = 1200

/** IPv4 → NAT64 合成地址 */
export function nat64Address(ipv4: string, prefix: string): string | null {
  if (!isIpv4(ipv4)) return null
  const parts = ipv4.split('.').map((p) => Number(p))
  const high = ((parts[0]! << 8) | parts[1]!).toString(16)
  const low = ((parts[2]! << 8) | parts[3]!).toString(16)
  const clean = prefix.replace(/:+$/, '')
  return `${clean}::${high}:${low}`
}

export interface SocketLike {
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
  expectedServerHostname?: string,
  deadline?: number
): Promise<SocketLike> {
  // 惰性加载：模块启动阶段不触碰 sockets，避免 isolate 启动失败（1101）
  const connect = await getConnect()
  // ⚠️ 第二个参数才是 options —— 见函数注释。
  // ⚠️ expectedServerHostname 必须**同时**放进 connect() 的 options（审计 L1）：
  // 真机复核发现只传给 startTls() 不生效 —— 对端收不到 SNI、SNI 路由型代理直接 RST。
  const socket = connect(
    { hostname, port },
    secureTransport
      ? { secureTransport, ...(expectedServerHostname ? { expectedServerHostname } : {}) }
      : undefined
  ) as unknown as SocketLike

  /**
   * 单阶段超时。
   *
   * ⚠️ 每一阶段都要**重新取**「剩余预算」，而不是共用同一个 `timeoutMs`：
   * `connect()` 与 `startTls()` 各等满一次，一个候选最坏就是 2 倍超时。
   * 传入 `deadline` 时剩余不足直接抛 `DialBudgetError`（预算耗尽 ≠ 节点坏）。
   */
  const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
    const remaining =
      deadline === undefined ? timeoutMs : Math.max(0, Math.min(timeoutMs, deadline - Date.now()))
    if (remaining <= 0) throw new DialBudgetError(`拨号预算已用尽：${hostname}:${port}`)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时：${hostname}:${port}`)), remaining)
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
    // 超时或失败后关闭 socket，避免泄漏。
    // ⚠️ 必须 fire-and-forget（审计 L2）：对**仍在建连**的 socket，close() 会等
    // 对端 TCP 握手走完（实测约 20s，AGENTS §31.1），await 它会把失败上报拖慢整整
    // 一个 close 窗口，竞速批次的失败转移随之卡住。立即 throw，让 close 后台收尾。
    try {
      void Promise.resolve((secure ?? socket).close()).catch(() => {})
    } catch {
      /* 已关闭 */
    }
    throw err
  }
}

/** 直连（含 NAT64 兜底） */
async function dialDirect(options: DialOptions): Promise<DialResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // NAT64 兜底与首次尝试共用同一个绝对截止：原实现每次都用满 timeoutMs，
  // 一次直连最坏能吃掉 2 倍预算（见 DialOptions.deadline 注释）。
  const deadline = options.deadline
  try {
    const socket = await connectWithTimeout(options.hostname, options.port, timeoutMs, undefined, undefined, deadline)
    return {
      readable: socket.readable,
      writable: socket.writable,
      via: 'direct',
      endpoint: `${options.hostname}:${options.port}`,
      close: () => {
        try {
          void socket.close()
        } catch {
          /* 已关闭 */
        }
      },
    }
  } catch (err) {
    if (options.nat64 && isIpv4(options.hostname)) {
      const synthesized = nat64Address(options.hostname, options.nat64)
      if (synthesized) {
        const socket = await connectWithTimeout(synthesized, options.port, timeoutMs, undefined, undefined, deadline)
        return {
          readable: socket.readable,
          writable: socket.writable,
          via: 'nat64',
          endpoint: `${synthesized}:${options.port}`,
      close: () => {
        try {
          void socket.close()
        } catch {
          /* 已关闭 */
        }
      },
        }
      }
    }
    throw err
  }
}

/** 目标是否是 IPv6 字面量（域名与 IPv4 地址都不含冒号）。 */
function isV6Literal(hostname: string): boolean {
  return hostname.includes(':')
}

/**
 * 这个候选能不能把 IPv6 **字面量**目标原样交给对端去连。
 *
 * 只有真正的出站代理（SOCKS5 / HTTP / HTTPS）做得到 —— 它们的握手里
 * 会显式写出目标地址（CONNECT 权威串 / SOCKS5 的 ATYP 字段）。
 *
 * 另外两类做不到，因为目标是靠**域名**表达的：
 *   - ProxyIP（`via.kind === 'direct'`）：复用连接，目标由客户端的 TLS SNI 决定；
 *   - 反代入口：同样按 ClientHello 里的 SNI 转发。
 */
function carriesLiteralTarget(candidate: RouteCandidate): boolean {
  return candidate.source === 'proxy' && candidate.via !== undefined && candidate.via.kind !== 'direct'
}

/** 通过代理池落地 */
async function dialViaProxy(
  options: DialOptions,
  proxy: ProxyEndpoint
): Promise<DialResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // ⚠️ 代理握手不能再用固定的 6s：`attemptOf` 已把 timeoutMs 夹到
  // 「本次拨号总预算的剩余时间」，握手若仍各自等满 6s，单候选最坏
  // 5s(connect) + 6s(handshake) = 11s，多候选顺序累加可直接顶穿预算。
  // 这里让握手超时跟随**本次尝试的绝对截止**（下限 0：已过期就立即失败，
  // 绝不移除超时 —— 铁律 15）。
  const budgetLeft = (): number =>
    options.deadline === undefined ? timeoutMs : options.deadline - Date.now()

  // ProxyIP 语义：连到指定地址，但请求的目标仍是原始 hostname:port。
  // 这是同类实现的通用做法，用于让出站流量落在指定的 Cloudflare 网段。
  if (proxy.kind === 'direct') {
    const socket = await connectWithTimeout(
      proxy.host,
      proxy.port,
      timeoutMs,
      undefined,
      undefined,
      options.deadline
    )
    return {
      readable: socket.readable,
      writable: socket.writable,
      via: 'direct',
      endpoint: `${proxy.host}:${proxy.port}`,
      close: () => {
        try {
          void socket.close()
        } catch {
          /* 已关闭 */
        }
      },
    }
  }

  // HTTPS 代理：代理服务器本身走 TLS，之后在 TLS 之上发明文 CONNECT。
  //
  // ⚠️ 必须用 `starttls` + `startTls()`，**不能**用 `secureTransport: 'on'`。
  //
  // 原因：
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
    proxy.kind === 'https' ? proxy.serverName : undefined,
    options.deadline
  )
  // 握手预算也必须重新取剩余：建连可能已经用掉了大半预算。
  const handshakeNow = Math.min(
    HANDSHAKE_TIMEOUT_MS,
    Math.max(0, Math.min(timeoutMs, budgetLeft()))
  )
  if (handshakeNow <= 0) {
    try {
      void socket.close()
    } catch {
      /* 已关闭 */
    }
    throw new DialBudgetError(`拨号预算已用尽：${proxy.host}:${proxy.port}`)
  }
  try {
    if (proxy.kind === 'http' || proxy.kind === 'https') {
      const readable = await httpConnect(
        socket.readable,
        socket.writable,
        options.hostname,
        options.port,
        { username: proxy.username, password: proxy.password },
        handshakeNow
      )
      return {
        readable,
        writable: socket.writable,
        via: proxy.kind,
        endpoint: `${proxy.host}:${proxy.port}`,
      close: () => {
        try {
          void socket.close()
        } catch {
          /* 已关闭 */
        }
      },
      }
    }
    const readable = await socks5Connect(socket.readable, socket.writable, options.hostname, options.port, {
      username: proxy.username,
      password: proxy.password,
      handshakeTimeoutMs: handshakeNow,
    })
    return {
      readable,
      writable: socket.writable,
      via: 'socks5',
      endpoint: `${proxy.host}:${proxy.port}`,
      close: () => {
        try {
          void socket.close()
        } catch {
          /* 已关闭 */
        }
      },
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

/**
 * 单次拨号竞速允许的**最大同时在飞连接数**。
 *
 * ## 依据：Workers 单请求同时出站 TCP 连接上限 = 6 条
 *
 * Cloudflare Workers 在**一个请求内**同时打开的出站 TCP 连接上限是 6 条。
 * 超出上限的 `connect()` 会立刻失败 —— 这种失败**不代表候选本身不可用**，
 * 它纯粹是平台硬约束：候选被白白浪费、`onFailure` 分级诊断里混进一堆假失败，
 * 用户侧表现为偶发的「明明有可用候选却失败」。
 *
 * 收敛前的最坏情况是 1（目标直连）+ N（DoH 解析出的优选 IP）
 * + 8（反代第一批，原先 `RELAY_BATCH_SIZE = 8`）= 10 条以上同时发起，
 * 必然撞墙。现在所有竞速池共用一个窗口宽度，在飞数不会超过平台上限。
 *
 * ## 为什么恰好取 6、刻意不留「安全余量」
 *
 * 上限是**硬约束**，宽度只要 ≤ 6 就不会触发；真正的安全保证来自
 * 「窗口宽度受限 + 候选全覆盖」的调度，而不是靠少试候选换余量。
 * 取 4 之类的余量只会让每一批少试 2 个候选，而反代入口质量参差 ——
 * 少试直接降低命中概率（实测：只试前 8 个成功率 40%，
 * 分批覆盖全部候选可达 90%+）。所以 6 就是刻意贴着上限取的。
 *
 * ## 为什么不用信号量把全部候选串行化
 *
 * 串行化同样不会超限，但会**牺牲失败转移速度**：每个候选要等满一次
 * 连接超时才轮到下一个，8 个坏候选 × 8s 超时 = 64s，客户端早就断开了。
 * 窗口化（批内并发竞速、批间串行）在「不超限」与「快速失败转移」之间取平衡，
 * 而平台上限本来就是硬约束，没必要退化到一次只连一个。
 *
 * 导出仅为便于测试与上层复用；**不要在下层代码里另定义一份**（会漂移）。
 */
export const MAX_SIMULTANEOUS_CONNECTS = 6

/**
 * 反代入口的连接超时（ms）。
 *
 * 内置表是固定 IP，实测 TLS 握手 168~203ms；失效 IP 则是完全不应答。
 * 让它们等满常规 5s 没有任何收益，反而会挤掉总预算：
 * 24 个入口按 6 个一批要分 4 批，4 × 5s 会顶穿 15s 拨号预算，
 * 后面几批只能因「预算已用尽」被跳过（等于白扩容）。
 * 反代单独压到 2.5s，4 批约 10s，能把全表覆盖完。
 */
export const RELAY_CONNECT_TIMEOUT_MS = 2500

/**
 * 「固定反代入口（pin）」的单独连接超时。
 *
 * 比常规反代更短：pin 是单点，失效时必须**快速回落**到池，把总预算
 * （dialBudgetMs 默认 15s）留给后续批次。早前 pin 共用 2.5s，
 * 配上多条 pin 就能吃掉大半预算，导致兜底池还没被尝试就先超预算。
 */
export const PINNED_RELAY_CONNECT_TIMEOUT_MS = 1200

// 成功记忆与惩罚/确认函数收归 endpoint-health.ts，此处重导出保持既有导出契约不变。
export {
  clearRelaySuccessMemory,
  confirmRelaySuccess,
  penalizeRelayEndpoint,
  relayEntryFromEndpoint,
  rememberRelaySuccess,
}

/**
 * 单条错误信息里最多展开多少条失败原因。
 *
 * 失败证据不能丢（会进 `/__diag`），但也不能无限膨胀 ——
 * 候选再多，诊断里保留**最后若干条 + 总数**就够了。
 */
const MAX_ERRORS_IN_MESSAGE = 8

/** 把未知异常转成可读文案（失败原因最终要进诊断，不能是 "[object Object]"） */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}

/**
 * 汇总一组失败原因：保留**最后若干条 + 总数**。
 *
 * 不做成「只留第一条」：竞速里第一条失败通常是最不具代表性的
 * （比如降权候选先失败），最后一条才最接近真实原因。
 */
function summarizeErrors(errors: readonly unknown[]): string {
  if (errors.length === 0) return '未知原因'
  const messages = errors.map(errorMessage)
  const tail = messages.slice(-MAX_ERRORS_IN_MESSAGE)
  const omitted = messages.length - tail.length
  const prefix = omitted > 0 ? `（共 ${messages.length} 条，省略前 ${omitted} 条）` : ''
  return `${prefix}${tail.join('；')}`
}

/**
 * 一批候选的并发竞速：第一个成功者胜出。
 *
 * 与旧实现的唯一差别是作用域 —— 旧实现一次性把**全部**候选扔进竞速池，
 * 这里只处理「一个窗口」内的候选，由 `raceDial` 决定何时开下一批。
 *
 * 语义保持不变：
 *   - 有人成功 → 立刻 resolve，不等同批其它候选；
 *   - **迟到的成功结果要整条 Socket 关掉**，否则会泄漏一条已建立的 TCP 连接；
 *   - 整批失败才 reject，并带上每一批的失败原因。
 *
 * ## 为什么不去「取消还在连接中的候选」
 *
 * 直觉上，赢家出现后应该把其余**仍在建连**的候选立刻掐掉，
 * 免得它们白占「单请求 6 条并发出站」的槽位。
 *
 * ⚠️ **平台做不到**：`close()` 对**尚未建立连接**的 socket 是一次「干净关闭」，
 * 它会等对端的 TCP 握手走完 —— 实测要 **约 20 秒**，而且**这段时间里 socket
 * 仍然计入出站连接数**。`writable.abort()` + `readable.cancel()` 同样无效
 * （实测仍是 20 秒；`socket.abort()` 这个 API 至今没有）。
 *
 * 也就是说：在途候选**无论如何都要占满自己的超时窗口**，
 * 主动关它并不会更快释放槽位，只会让本进程多等一次 close。
 *
 * ⇒ 现状（迟到成功的立刻关掉、在途的等它自己超时）已经是这个平台上的最优解。
 */
/**
 * 滑动窗口竞速：任时候选 settle 就**立即补发**下一个未试候选，
 * 全程在飞数 ≤ `width`；有人成功即整体 resolve。
 *
 * ## 与旧「屏障批次」的区别（P1 #7）
 *
 * 旧 `raceBatch` 要等本批 6 个**全部** settle 才允许开下一批：批内只要
 * 1 个慢候选（默认 8s 超时），其余 5 个即使 50ms 内全失败也得陪着等满
 * 这个超时窗口；24 个反代入口时尾延迟被逐个 batch 的最慢成员累加。
 * 滑动窗口消除这个队头阻塞，且守住全部既有约束：
 *   - 不增加连接数（全程 ≤6，§1.31）；
 *   - 不截断候选（窗口化 ≠ 截断，全部候选都会被尝试）；
 *   - 不主动取消在途候选（§31.1 平台边界：无 socket.abort()，close()
 *     对未建连 socket 要等约 20s 且仍占连接数）；
 *   - 迟到的成功整条 `DialResult.close()` 关掉，不泄漏 socket（§1.31）。
 *
 * 成功后不再补发新候选（与旧实现「任一批成功即返回」语义一致）；
 * 已在飞的会各自跑完并被关掉。
 */
function raceWindow(
  attempts: ReadonlyArray<() => Promise<DialResult>>,
  width: number
): Promise<DialResult> {
  if (attempts.length === 0) return Promise.reject(new Error('没有可用的出站拨号方式'))

  return new Promise<DialResult>((resolve, reject) => {
    let next = 0
    let inFlight = 0
    let settled = false
    const errors: unknown[] = []

    /** 落败/迟到的连接整条关掉（只关 writable 不够，见 §1.31 注释） */
    const closeLoser = (result: DialResult): void => {
      try {
        const close = result.close
        void Promise.resolve(close ? close() : result.writable.close()).catch(() => {})
      } catch {
        /* 已关闭 */
      }
    }

    const launch = (): void => {
      if (settled) return
      while (inFlight < width && next < attempts.length) {
        const attempt = attempts[next++]!
        inFlight++
        attempt().then(
          (result) => {
            inFlight--
            if (settled) {
              closeLoser(result)
              return
            }
            settled = true
            resolve(result)
          },
          (err) => {
            inFlight--
            errors.push(err)
            if (settled) return
            // 失败即补发，不用等整批的其它候选
            launch()
            if (next >= attempts.length && inFlight === 0) {
              settled = true
              reject(
                new Error(`全部 ${attempts.length} 个候选均失败：${summarizeErrors(errors)}`)
              )
            }
          }
        )
      }
    }
    launch()
  })
}

/**
 * 并发竞速：多个候选按**滑动窗口**拨号，取最先成功者。
 *
 * ## 窗口语义（不是截断候选）
 *
 * `concurrent` 为 true 且候选多于一个时，用 `raceWindow` 保持最多
 * `MAX_SIMULTANEOUS_CONNECTS`(6) 个候选在飞：任一候选失败就立即补发下一个
 * 未试候选；任一批有人成功就立刻返回。旧实现是「屏障批次」——本批 6 个
 * 全部 settle 才发下一批，批内 1 个慢候选就能拖住整批（见 raceWindow 注释）。
 *
 * ⚠️ 语义上**所有候选都会被尝试**，只是同时在飞的宽度受限。
 * 绝不能改成「只取前 6 个」—— 那会直接丢掉候选与失败证据：
 * 反代入口质量参差（同一域名下有的通有的不通），少试几个候选
 * 会让命中概率从 90%+ 掉到 40%，而且诊断里看不到后面的候选为什么没试。
 *
 * ⚠️ `concurrent === false` 或只有一个候选时**保持原有顺序语义**，
 * 不做窗口化 —— 顺序模式本来就是「一次一个」，
 * 再套窗口只会改变既有行为而没有任何收益。
 *
 * ## 全部失败时的错误
 *
 * 聚合全部失败原因（会进 `/__diag` 与 close reason），
 * 不能只丢一个空错误：这是排查「为什么连不上」的唯一线索。
 */
async function raceDial(
  attempts: Array<() => Promise<DialResult>>,
  concurrent: boolean
): Promise<DialResult> {
  if (attempts.length === 0) throw new Error('没有可用的出站拨号方式')

  // 顺序故障转移：保持原行为不变（concurrent=false 或只有一个候选）
  if (!concurrent || attempts.length <= 1) {
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

  // 滑动窗口：任时候选 settle 立即补发下一个，全程 ≤6 在飞。
  // 旧实现按固定步长切片、一批全失败才发下一批，队头阻塞见 raceWindow 注释。
  try {
    return await raceWindow(attempts, MAX_SIMULTANEOUS_CONNECTS)
  } catch (err) {
    // 聚合失败原因（会进 /__diag 与 close reason，排查「为什么连不上」的唯一线索）
    throw new Error(
      `全部 ${attempts.length} 个候选均失败（滑动窗口，最多 ${MAX_SIMULTANEOUS_CONNECTS} 个并发）：\n` +
        errorMessage(err),
      { cause: err }
    )
  }
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
 * 滑动窗口尝试全部反代入口。
 *
 * 反代入口质量参差（同一域名下有的通有的不通），所以不能只取少数几个：
 * 实测 53 个候选一次性并发 → 70%；只取前 8 个 → 40%。
 *
 * 旧实现自己按 RELAY_BATCH_SIZE 切片、批间串行（前一批全失败才发下一批），
 * 与 raceDial 的内部窗口形成双层屏障。现在一次把全部候选交给 raceDial，
 * 由 raceWindow 统一维持「≤6 在飞、失败即补发」，既覆盖全部入口、
 * 又不会被某个慢入口卡住整批。
 */
async function tryRelayWithWindow(
  relay: Array<{ ip: string; port: number; label: string }>,
  attemptOf: (candidate: RouteCandidate) => () => Promise<DialResult>,
  concurrent: boolean
): Promise<DialResult | null> {
  if (relay.length === 0) return null
  const attempts = relay.map((item) =>
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
    return null
  }
}

/** 统一拨号入口 */
export async function dial(options: DialOptions): Promise<DialResult> {
  const proxies = options.proxies ?? []
  const concurrent = options.concurrent ?? true

  // 目标地址策略：命中且完全没有代理时**立即失败**。
  //
  // 不这样做就要先花一次 DoH 解析 + 一轮 5s 超时才得到「连不上」——
  // 而这类目标在 Worker 上永远连不上（见 outbound/guard.ts 的边界说明）。
  // 配了代理则继续：局域网目标需要由代理侧建连，拦在这里会让功能直接不可用。
  if (!options.skipTargetPolicy && proxies.length === 0) {
    const blocked = blockedTarget(options.hostname)
    if (blocked) throw new TargetBlockedError(options.hostname, blocked)
  }

  // 总预算：DoH 解析与连接竞速共用同一个截止时间
  const budgetMs = options.budgetMs ?? DEFAULT_DIAL_BUDGET_MS
  const deadline = Date.now() + budgetMs

  // 优选 IP 候选：手工配置的 +（可选）DoH 解析得到的。
  //
  // ⚠️ 解析结果里可能混入 Cloudflare 网段（Worker 连不回自家 Anycast），
  // 降权由 buildRouteCandidates 统一处理 —— 这里不做过滤，避免丢信息。
  // 命中「固定落地 IP」映射：用户已写明落地地址，不再轮询 DoH、不再把域名
  // 丢给运行时解析 —— 那两种做法都会让落点随 DNS 轮询漂移（真机表现：
  // 同一页面刷新时好时坏）。此时只用这批明确 IP。
  const pinned = options.pinnedIps ?? []
  const pinnedActive = pinned.length > 0
  const optimized = pinnedActive ? [...pinned] : [...(options.optimizedIps ?? [])]
  // 固定落地 IP 若**全部处于冷却**（连续失败过），说明已知失效：
  // 此时不能再「只用这批 IP」——否则每次请求都先失败一轮。改为正常做 DoH
  // 拿真实落点追加在后面（pinned 仍排最前，冷却到期后会自动回到首选）。
  const pinnedAllCooled =
    pinnedActive &&
    pinned.every((p) => isEndpointCooled(endpointKey('direct', p.ip, p.port), Date.now()))
  /** 是否成功解析出目标域名（用于判断「域名直连」是否值得优先） */
  let resolvedTarget = pinnedActive
  if (options.resolvePreferred && (!pinnedActive || pinnedAllCooled)) {
    try {
      // ⚠️ 两个关键约束（首包延迟治理，见 DOH_FAST_BUDGET_MS 注释）：
      //  1. 独立短预算：超时就放弃解析，直接用域名直连候选，不让整条
      //     请求陪着境外 DoH 等到 4~10s。
      //  2. 主路径跳过 TXT：TXT 优选库是 opt-in 的高级功能，绝大多数
      //     域名的 TXT 是 SPF / 域名验证记录；`queryAll('TXT')` 串行遍历
      //     多家 provider 是实测首包延迟的最大来源。需要它的调用方可显式
      //     传 skipTxt:false（解析能力本身仍保留在 doh.ts）。
      const dohDeadline = Math.min(
        deadline,
        Date.now() + (options.dohBudgetMs ?? DOH_FAST_BUDGET_MS)
      )
      const resolved = await resolveEndpointIps(options.hostname, options.port, {
        deadline: dohDeadline,
        skipTxt: options.skipTxt ?? true,
      })
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
  // ⚠️ **域名直连的降权**
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
  //   - 已知目标是 CF 网段 → 预解析备用（直连/优选全失败后分批试反代，见 dialRelay）
  //   - 否则 → 完全不解析，等 primary 全失败后再分批解析（正常路径零开销）
  //
  // 反代与 CF 网段目标的竞速策略见下面注释。
  let relay = [...(options.relay ?? [])]
  const relayNeeded = resolvedAllCf || targetIsCfIp
  if (relayNeeded && options.relayPool) {
    relay = await collectRelay(relay, { ...options.relayPool, deadline })
  }
  // 反代**永不参与主竞速**：全部进 relayRest 作兜底（见 dialRelay）。
  // 原因（2026-11-08 真机实测）：内置反代入口对大上传有 ~64 KiB 转发上限，
  // ≤64 KiB 必通、>64 KiB 必断（连接被入口直接掐掉，目标都等不来响应）；
  // 直连路径 256 KiB 可完整完成。若把反代放进主竞速池，它会先于直连被选中，
  // 大流量在反代上必然中途断流且无从恢复（redial 护栏要求零下行）。
  const relayRest = relay

  const candidates = buildRouteCandidates({
    targetHost: options.hostname,
    targetPort: options.port,
    optimizedIps: optimized,
    proxies,
    // 域名直连**不再以「解析结果全是 CF 网段」为由降权**（2026-11-08 改）：
    // 从前 `resolvedAllCf` 会同时把直连降权、把反代第一批放进主竞速，
    // 大流量在反代入口上必断。改为：直连（域名 + 优选）永远先跑，
    // 失败后分批走反代兜底（见 dialRelay）。CF 目标上域名直连的失败
    // 是快速拒绝（TCP Loop detected），不是挂起等待，代价可控。
    // 降权只留给**字面量 CF 网段目标**（那种连域名都没有，必然被拒），
    // 以及**命中固定落地 IP 映射**时（域名直连由运行时解析，落点会漂移，
    // 必须让位给用户明确写明的那批 IP）。
    deprioritizeDirect: targetIsCfIp || pinnedActive,
    relay: [],
  })

  if (candidates.length === 0) {
    throw new Error('没有可用的出站拨号方式')
  }

  /** 执行单个候选 */
  const attemptOf = (candidate: RouteCandidate) => async (): Promise<DialResult> => {
    // P2 #14：所有类型的候选统一记健康（不只是代理）。
    const healthKey = endpointKey(candidate.source, candidate.host, candidate.port)
    // 总预算约束：剩余时间不足时不再发起连接，超了则截断本次连接超时
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new DialBudgetError(`拨号预算已用尽（${budgetMs}ms）：${options.hostname}:${options.port}`)
    }
    // 反代入口失效时应快速失败，把总预算留给后续批次；只缩短、不放大用户设置。
    const baseTimeout =
      candidate.source === 'relay'
        ? Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, RELAY_CONNECT_TIMEOUT_MS)
        : options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // 候选级上限（固定 pin 用更短超时）：同样只缩短不放宽。
    const cappedTimeout = candidate.timeoutMs ? Math.min(baseTimeout, candidate.timeoutMs) : baseTimeout
    const connectTimeout = Math.max(200, Math.min(cappedTimeout, remaining))
    // 本次尝试的绝对截止：连接 / TLS / 代理握手 / NAT64 重试共用它，
    // 避免一个候选把「剩余预算」按阶段重复吃掉（见 DialOptions.deadline）。
    const attemptOptions: DialOptions = {
      ...options,
      timeoutMs: connectTimeout,
      deadline: Date.now() + connectTimeout,
    }
    try {
      // IPv6 字面量目标 + 非出站代理候选 → 立刻失败，不发任何 socket。
      //
      // 依据是通道能力上限（详见 guard.ts 的 IPV6_DIRECT_UNSUPPORTED）：
      // `connect()` 出站不支持 IPv6、反代只能按 SNI 转发域名、
      // ProxyIP 是「复用连接 + 客户端 TLS SNI 决定目标」—— 后两者同样需要域名。
      // 不提前失败的代价是：白等一次建连超时，再收到一条与真因无关的文案。
      //
      // ⚠️ 只有**真正的出站代理**（SOCKS5 / HTTP / HTTPS，`via.kind !== 'direct'`）
      // 能把字面量交给对端去连 —— 那条路径照常放行，不受此限。
      // ⚠️ 刻意不看 `skipTargetPolicy`：那个开关是给反代放行内网目标用的，
      // 对「这个通道根本搬不动字面量」不起作用。
      if (!carriesLiteralTarget(candidate) && isV6Literal(options.hostname)) {
        throw new TargetBlockedError(options.hostname, IPV6_DIRECT_UNSUPPORTED)
      }
      // 目标地址策略：只拦直连 / 优选 IP。代理与反代入口不受影响 ——
      // 「用落地代理回家里的 NAS」是合法用法，拦掉就等于功能不可用。
      if (!options.skipTargetPolicy && candidate.source !== 'proxy' && candidate.source !== 'relay') {
        const blocked = blockedTarget(candidate.host)
        if (blocked) throw new TargetBlockedError(candidate.host, blocked)
      }
      if (candidate.source === 'proxy' && candidate.via) {
        // 代理候选：连代理，由代理转发到**原始目标**
        try {
          const result = await dialViaProxy(attemptOptions, {
            host: candidate.via.host,
            port: candidate.via.port,
            kind: candidate.via.kind,
            username: candidate.via.username,
            password: candidate.via.password,
            serverName: candidate.via.serverName,
          })
          recordProxySuccess(candidate.via)
          recordEndpointSuccess(healthKey)
          return result
        } catch (err) {
          // ⚠️ 「目标站拒绝」不计入失败统计 —— 那说明代理是活的
          // （`TargetRejectedError`），把它记成坏节点会误伤。
          if (!(err instanceof TargetRejectedError)) {
            recordProxyFailure(candidate.via, Date.now())
          }
          throw err
        }
      }
      // 直连 / 优选 IP：换入口地址，但目标（TLS SNI 等）仍是原目标
      const result = await dialDirect({ ...attemptOptions, hostname: candidate.host, port: candidate.port })
      if (candidate.source === 'relay') result.isRelay = true
      recordEndpointSuccess(healthKey)
      return result
    } catch (err) {
      // 「本次尝试预算耗尽 / 平台并发限制」是我们自己的决定，不是节点故障：
      // 记进健康记忆会让健康的反代入口 / 优选 IP 被拉入冷却，之后每个请求都少一批候选
      // （见 DialBudgetError 注释）。其余失败照常记账；目标站拒绝说明节点是活的。
      if (!(err instanceof DialBudgetError)) {
        recordEndpointFailure(healthKey, Date.now(), err instanceof TargetRejectedError)
      }
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
  // 语义约定（`proxyMode` 决定，详见 types.ts 的 ProxyMode）：
  //   only（默认）→ 有代理只走代理；代理全失败 → 试反代池 → 抛错（**绝不直连**）
  //   global       → 代理优先 → 直连/优选 → 反代池
  //   fallback     → 直连/优选优先 → 代理 → 反代池
  //   smart        → 目标是 CF 网段时走代理（直连必败）；否则直连优先
  const groups = groupCandidates(candidates)
  const { landing, proxyIp, direct: directCandidates, fallback } = groups
  const hasProxy = landing.length > 0 || proxyIp.length > 0

  // ----------------------------------------------------------------
  // 三个「通道组」拨号器
  // ----------------------------------------------------------------

  /**
   * 落地代理组（SOCKS5 / HTTP / HTTPS）：**顺序故障转移**。
   *
   * ## 为什么不用并发竞速
   *
   * 多个 SOCKS5 并发竞速会让**所有**代理服务器同时向目标站建连，
   * 然后因为「已经有更好的候选」而被强行断开 ——
   * 白白消耗代理服务器的连接数与配额（有些代理按并发连接计费）。
   *
   * 顺序故障转移只占用**一个**代理连接，失败才换下一个。
   *
   * 代价：第一个代理慢时会多等 —— 但代理握手本来就有超时兜底。
   *
   * ## 健康记忆
   *
   * 顺序转移的代价在「第一个代理已经宕机」时会变成**每个请求都白等一次
   * 完整的代理超时**。健康记忆让连续失败的节点进入冷却，冷却期内直接跳过
   * （见 `proxy-health.ts`）；成败的记录在 `attemptOf` 里统一做。
   */
  const dialLanding = async (): Promise<DialResult> => {
    if (landing.length === 0) throw new Error('未配置落地代理')
    let lastErr: unknown
    const candidates = filterHealthy(landing, (c) => c.via, Date.now())
    for (const candidate of candidates) {
      try {
        return await attemptOf(candidate)()
      } catch (err) {
        lastErr = err
        // 继续试下一个落地代理
      }
    }
    throw lastErr ?? new Error('落地代理全部失败')
  }

  /**
   * ProxyIP 组：**并发竞速**。
   *
   * ProxyIP 只要 TCP 连上就算成功（1 RTT），并发无害且更快。
   * （落地代理是 2~3 RTT，两类混池会让 ProxyIP 永远赢 —— 见 CandidateGroups 注释。）
   *
   * 同样套一层健康记忆：坏掉的 ProxyIP 不必每次都参与竞速
   * （它不会拖慢赢家，但会白占「单请求 6 条并发出站」里的一个槽位）。
   */
  const dialProxyIp = async (): Promise<DialResult> => {
    if (proxyIp.length === 0) throw new Error('未配置 ProxyIP')
    const now = Date.now()
    const candidates = filterHealthy(proxyIp, (c) => c.via, now)
    return await raceDial(
      candidates.map(attemptOf),
      true
    )
  }

  /**
   * 「代理链」：落地代理优先，失败再试 ProxyIP。
   *
   * 顺序的理由：落地代理（SOCKS5/HTTP）是**真正的出口代理** ——
   * 用户配它通常是为了指定出口 IP。
   * 而 ProxyIP 本质是「固定的反代入口」（与 relayPool 同一类机制），
   * 让它排在落地代理之后，就不会再出现
   * 「配了 SOCKS5 却总是从 ProxyIP 出去」这种静默不符预期的行为。
   */
  const dialProxyChain = async (): Promise<DialResult> => {
    let lastErr: unknown
    if (landing.length > 0) {
      try {
        return await dialLanding()
      } catch (err) {
        lastErr = err
      }
    }
    if (proxyIp.length > 0) {
      try {
        return await dialProxyIp()
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr ?? new Error('没有可用的代理')
  }

  /**
   * 直连 / 优选组：并发竞速。
   *
   * 命名加 `Group` 后缀是为了不和模块级的 `dialDirect(options)` 撞名 ——
   * 后者是「连到某个 hostname:port」的底层实现。
   *
   * ⚠️ 必须先按端点健康做**稳定排序**：`attemptOf` 给所有类型（含 direct /
   * optimized）都记了成败，但早前这里直接 `directCandidates.map(attemptOf)`，
   * 冷却中的坏优选 IP 每次仍排在前面，白白抢占「单请求 6 条并发出站」的槽位。
   * 排序**不删除**任何候选（窗口化 ≠ 截断，§1.31）。
   */
  const dialDirectGroup = async (): Promise<DialResult> => {
    const sorted = sortByEndpointHealth(
      directCandidates,
      (c) => endpointKey(c.source, c.host, c.port),
      Date.now()
    )
    return await raceDial(sorted.map(attemptOf), concurrent)
  }

  /**
   * 反代池：分批尝试。
   *
   * （CF 网段场景：relayRest 是预解析时没进主竞速的那些；
   *   其它场景：这里才第一次解析反代入口，正常路径零开销）
   */
  const dialRelay = async (): Promise<DialResult | null> => {
    // 固定反代入口（`域名=r:IP`）优先于一切：用户为该域名实测后写死的入口，
    // 不参与粘性哈希与分批竞速；全部失败才回退到常规反代池。
    //
    // ⚠️ pin 必须参与健康记忆（P2 #14 的 endpoint-health）：
    // 早前这里无条件逐条尝试，坏掉的 pin 会在**每个请求**上白等一次完整反代超时
    // 且永不冷却 —— 用户侧表现为「app 一直转圈」，即使兜底池其实是好的。
    // 现在：冷却中直接跳过（用池），冷却到期后自动重试（半开），恢复即回到 pin。
    const pinnedRelays = options.pinnedRelays ?? []
    for (const p of pinnedRelays) {
      if (isEndpointCooled(endpointKey('relay', p.ip, p.port), Date.now())) continue
      try {
        const res = await attemptOf({
          source: 'relay',
          host: p.ip,
          port: p.port,
          label: `固定反代 ${p.ip}:${p.port}`,
          timeoutMs: PINNED_RELAY_CONNECT_TIMEOUT_MS,
        })()
        res.isRelay = true
        rememberRelaySuccess(options.hostname, p.ip, p.port)
        return res
      } catch {
        /* 固定入口失败 → 试下一个固定入口，再回退常规池 */
      }
    }

    let restRelay = relayRest
    if (restRelay.length === 0 && options.relayPool) {
      restRelay = await collectRelay([], { ...options.relayPool, deadline })
    }
    if (restRelay.length === 0) return null

    // 「上次成功的入口」优先：哈希选路可能为这个域名选到一个对它无效的入口，
    // 复用真正成功过的那个，升级后就不会「突然打不开」。
    // 记忆的入口这次失败则走常规选路（health 已记录失败，冷却后自然换一个）。
    const remembered = relaySuccessFor(options.hostname)
    if (remembered) {
      const rememberedKey = endpointKey('relay', remembered.ip, remembered.port)
      const inPool = restRelay.some(
        (r) => r.ip === remembered.ip && r.port === remembered.port
      )
      if (inPool && !isEndpointCooled(rememberedKey, Date.now())) {
        try {
          const res = await attemptOf({
            source: 'relay',
            host: remembered.ip,
            port: remembered.port,
            label: `反代 ${remembered.ip}:${remembered.port}`,
          })()
          res.isRelay = true
          rememberRelaySuccess(options.hostname, remembered.ip, remembered.port)
          return res
        } catch {
          /* 记忆失效 → 继续常规选路 */
        }
      }
    }

    // 粘性首选：同一目标在全球任意 isolate 都落到同一个反代入口，
    // 避免「竞速挑最快」让同一会话的请求从不同出口 IP 出去被目标站风控。
    // 先单拨这一个；它失效才回退到全表滑动窗口（不丢冗余）。
    const stickyIndex = stableRelayIndex(options.hostname, restRelay.length)
    let sticky = restRelay[stickyIndex]!
    const now = Date.now()
    // P2 #14： sticky 若在本 isolate 已连续失败并处于冷却，顺延到第一个
    // 未冷却的入口。冷却是 isolate 级内存，**只有确认失败过才偏置** ——
    // 正常请求仍走确定性的 sticky，不会额外引入出口漂移。
    if (isEndpointCooled(endpointKey('relay', sticky.ip, sticky.port), now)) {
      const alt = restRelay.find(
        (r) => !isEndpointCooled(endpointKey('relay', r.ip, r.port), now)
      )
      if (alt) sticky = alt
    }
    try {
      const res = await attemptOf({
        source: 'relay',
        host: sticky.ip,
        port: sticky.port,
        label: `反代 ${sticky.label}`,
      })()
      res.isRelay = true
      rememberRelaySuccess(options.hostname, sticky.ip, sticky.port)
      return res
    } catch {
      // 兜底列表按健康做**稳定排序**：冷却中的排后，但不删任何候选
      // （窗口化 ≠ 截断，§1.31）。
      const rest = sortByEndpointHealth(
        restRelay.filter((r) => r !== sticky),
        (r) => endpointKey('relay', r.ip, r.port),
        Date.now()
      )
      const res = await tryRelayWithWindow(rest, attemptOf, concurrent)
      if (res) {
        res.isRelay = true
        const entry = relayEntryFromEndpoint(res.endpoint)
        if (entry) rememberRelaySuccess(options.hostname, entry.ip, entry.port)
      }
      return res
    }
  }

  /** 降权候选（CF 网段）：顺序尝试 */
  const dialFallback = async (): Promise<DialResult | null> => {
    for (const candidate of fallback) {
      try {
        return await attemptOf(candidate)()
      } catch {
        /* 继续尝试下一个降权候选 */
      }
    }
    return null
  }

  // ----------------------------------------------------------------
  // 按模式选路
  // ----------------------------------------------------------------

  // 没有代理：走直连 / 优选 → 反代池 → 降权候选（原有路径）
  if (!hasProxy) {
    try {
      return await dialDirectGroup()
    } catch (err) {
      const viaRelay = await dialRelay()
      if (viaRelay) return viaRelay
      const viaFallback = await dialFallback()
      if (viaFallback) return viaFallback
      throw err
    }
  }

  const mode: ProxyMode = options.proxyMode ?? 'only'

  // 目标是 Cloudflare 网段 → 直连必然被拒（TCP Loop）→ 代理优先。
  //
  // 这也是 `smart` 模式的核心判断：CF 网段目标用直连是**确定失败**，
  // 没有必要先白等一次超时。
  const cfTarget = targetIsCfIp || resolvedAllCf

  // ----------------------------------------------------------------
  // only（默认）：有代理只走代理
  // ----------------------------------------------------------------
  //
  // ⚠️ **绝不回退直连** —— 直连会暴露 Cloudflare 原生出口 IP，
  // 与用户「配置代理是为了指定出口」的意图相悖（AGENTS.md §1.11）。
  //
  // 但**反代池可以试**：它同样是第三方出口（不是 CF 原生 IP），
  // 而且是本项目默认就会用的通道 —— 代理全挂时用它兜底，
  // 比整条请求失败要好。
  if (mode === 'only') {
    try {
      return await dialProxyChain()
    } catch (err) {
      const viaRelay = await dialRelay()
      if (viaRelay) return viaRelay
      const viaFallback = await dialFallback()
      if (viaFallback) return viaFallback
      throw err
    }
  }

  // ----------------------------------------------------------------
  // global / smart(CF 目标)：代理优先
  // ----------------------------------------------------------------
  if (mode === 'global' || (mode === 'smart' && cfTarget)) {
    try {
      return await dialProxyChain()
    } catch (proxyErr) {
      // smart + CF 目标：直连必然被拒，不浪费一次超时
      if (mode === 'global') {
        try {
          return await dialDirectGroup()
        } catch {
          /* 继续往下 */
        }
      }
      const viaRelay = await dialRelay()
      if (viaRelay) return viaRelay
      const viaFallback = await dialFallback()
      if (viaFallback) return viaFallback
      throw proxyErr
    }
  }

  // ----------------------------------------------------------------
  // fallback / smart(非 CF 目标)：直连优先
  // ----------------------------------------------------------------
  try {
    return await dialDirectGroup()
  } catch (directErr) {
    try {
      return await dialProxyChain()
    } catch {
      /* 继续往下 */
    }
    const viaRelay = await dialRelay()
    if (viaRelay) return viaRelay
    const viaFallback = await dialFallback()
    if (viaFallback) return viaFallback
    throw directErr
  }
}


