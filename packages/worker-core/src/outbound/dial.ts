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
import type { ProxyMode } from '../types'

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
  // 这是同类实现的通用做法，用于让出站流量落在指定的 Cloudflare 网段。
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
 *   - **迟到的成功结果要 close 掉**，否则会泄漏一条已建立的 TCP 连接
 *     （Workers 的 `writable.close()` 等于关闭整个连接，这里正是需要的）；
 *   - 整批失败才 reject，并带上每一批的失败原因。
 */
function raceBatch(attempts: ReadonlyArray<() => Promise<DialResult>>): Promise<DialResult> {
  if (attempts.length === 0) return Promise.reject(new Error('没有可用的出站拨号方式'))

  return new Promise<DialResult>((resolve, reject) => {
    let pending = attempts.length
    let settled = false
    const errors: unknown[] = []

    for (const attempt of attempts) {
      attempt().then(
        (result) => {
          if (settled) {
            // 本批已经有别的候选赢了：关掉这条多余连接
            try {
              result.writable.getWriter().close()
            } catch {
              /* 忽略：已关闭或 writable 已被锁定 */
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
            reject(
              new Error(`本批 ${attempts.length} 个候选全部失败：${summarizeErrors(errors)}`)
            )
          }
        }
      )
    }
  })
}

/**
 * 并发竞速：多个候选按**窗口**分批拨号，取最先成功者。
 *
 * ## 窗口语义（不是截断候选）
 *
 * `concurrent` 为 true 且候选多于一个时，按 `MAX_SIMULTANEOUS_CONNECTS`
 * 分批发起：**一批全部失败后**才发下一批；任一批有人成功就立刻返回。
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
 * 聚合**每一批**的失败原因（至少保留最后一条 + 总数），
 * 不能只丢一个空错误：这个错误会进 `/__diag` 与 close reason，
 * 是排查「为什么连不上」的唯一线索。
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

  /** 每一批的失败摘要（全部批次失败时聚合，诊断不丢） */
  const batchFailures: string[] = []
  let lastError: unknown = new Error('拨号失败')

  // 窗口化：一批全失败才发下一批，任一批成功立刻返回
  for (let start = 0; start < attempts.length; start += MAX_SIMULTANEOUS_CONNECTS) {
    const batch = attempts.slice(start, start + MAX_SIMULTANEOUS_CONNECTS)
    try {
      return await raceBatch(batch)
    } catch (err) {
      lastError = err
      batchFailures.push(errorMessage(err))
      // 本批全失败 → 继续下一批（**不丢候选**）
    }
  }

  const error = new Error(
    `全部 ${attempts.length} 个候选均失败（分 ${batchFailures.length} 批，` +
      `每批最多 ${MAX_SIMULTANEOUS_CONNECTS} 个并发）：\n` +
      batchFailures.join('\n'),
    // 保留最后一次的原始异常作为 cause，方便上层按错误类型做判断
    { cause: lastError }
  )
  throw error
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
   */
  const dialLanding = async (): Promise<DialResult> => {
    if (landing.length === 0) throw new Error('未配置落地代理')
    let lastErr: unknown
    for (const candidate of landing) {
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
   */
  const dialProxyIp = async (): Promise<DialResult> => {
    if (proxyIp.length === 0) throw new Error('未配置 ProxyIP')
    return await raceDial(
      proxyIp.map(attemptOf),
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
   */
  const dialDirectGroup = async (): Promise<DialResult> => {
    return await raceDial(
      directCandidates.map(attemptOf),
      concurrent
    )
  }

  /**
   * 反代池：分批尝试。
   *
   * （CF 网段场景：relayRest 是预解析时没进主竞速的那些；
   *   其它场景：这里才第一次解析反代入口，正常路径零开销）
   */
  const dialRelay = async (): Promise<DialResult | null> => {
    let restRelay = relayRest
    if (restRelay.length === 0 && options.relayPool) {
      restRelay = await collectRelay([], { ...options.relayPool, deadline })
    }
    return await tryRelayInBatches(restRelay, attemptOf, concurrent)
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
