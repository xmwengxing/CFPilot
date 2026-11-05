/**
 * 出站选路：决定「往哪里连」。
 *
 * ## 核心约束
 *
 * Worker 运行时**不能主动连回 Cloudflare 自家的 Anycast 地址**：
 * `1.1.1.1` / `cloudflare.com` / `104.16.0.1` 等一律被拒，
 * 报错 `proxy request failed, cannot connect to the specified address`
 * （即旧文档所说的 `TCP Loop detected`）。
 *
 * 同一实例内实测矩阵：
 *
 * ```
 * 8.8.8.8:53          → OK        8.8.8.8:443        → OK
 * 9.9.9.9:443         → OK        208.67.222.222:443 → OK
 * 1.1.1.1:443         → BLOCKED   cloudflare.com:443  → BLOCKED
 * 104.16.0.1:443      → BLOCKED
 * ```
 *
 * ⚠️ 旧自研实现（已归档）的死循环根因就在这里：
 * 它的优选 IP 库装的是硬编码的 Cloudflare 网段，
 * 于是**每一次**拨号都必然失败；再加上异常被 catch 吞掉、只返回 null，
 * 每层失败都表现为「目标不可达」，日志里没有任何线索。
 *
 * 因此本模块的第一职责是：**绝不把 Cloudflare 网段 IP 当作首选出站目标**。
 *
 * 完整实验记录见 docs/self-developed-dataplane-design.md §1。
 */

import { isTargetBlockedError } from './guard'

/**
 * Cloudflare 官方公告的 IPv4 网段（15 条）。
 *
 * 判定表与「优选采样池」是两回事：采样池按实测可用率筛段（见
 * `data/pools.ts`），判定表只回答「这个 IP 是不是落在 CF 自家网络里」，
 * 与可用率无关。旧表把两类混在一起，漏了 `173.245.48.0/20` 与
 * `190.93.240.0/20` 两条官方段，还把公共 DNS 误标成 CF 网段。
 */
export const CF_OFFICIAL_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['103.21.244.0', 22],
  ['103.22.200.0', 22],
  ['103.31.4.0', 22],
  ['104.16.0.0', 13],
  ['104.24.0.0', 14],
  ['108.162.192.0', 18],
  ['131.0.72.0', 22],
  ['141.101.64.0', 18],
  ['162.158.0.0', 15],
  ['172.64.0.0', 13],
  ['173.245.48.0', 20],
  ['188.114.96.0', 20],
  ['190.93.240.0', 20],
  ['197.234.240.0', 22],
  ['198.41.128.0', 17],
]

/**
 * 非官方公告、但本项目仍需降权的段。逐条注明来源，不静默保留。
 */
const CF_IPV4_SUPPLEMENT: ReadonlyArray<readonly [string, number]> = [
  ['104.31.0.0', 15], // 历史实测补充：官方公告到 104.27，ARIN 分配块到 104.31
  ['192.0.0.0', 24], // IANA 特殊用途段，历史上被一并降权
  ['192.0.2.0', 24], // TEST-NET-1（文档示例地址）
  ['192.88.99.0', 24], // 已弃用的 6to4 任播段
  ['199.27.128.0', 21], // 历史反代服务段
  ['1.0.0.0', 24], // 自家 Anycast DNS：实测 connect() 被拒
  ['1.1.1.0', 24], // 同上（架构规范里记录的 TCP Loop 结论）
]

/**
 * 公共 DNS 解析器地址 —— **不属于** Cloudflare 网段，不参与 CF 降权。
 *
 * 旧表把 `223.5.5.0/24` 注释成「也在 CF 网络内」，导致访问该解析器的
 * 目标被误判、导向只转发 CF 站点的反代入口。这里单独归类。
 */
export const PUBLIC_DNS_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['223.5.5.0', 24], // 阿里公共 DNS
]

/** 判定用的完整表：官方段 + 本项目补充段 */
const CF_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ...CF_OFFICIAL_IPV4_RANGES,
  ...CF_IPV4_SUPPLEMENT,
]

/** IPv4 → 32 位无符号整数 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value >>> 0
}

/** 把一组 CIDR 表编译成 `[网络号, 掩码]` 整数对，判定降到纯位运算 */
function compileCidrs(
  ranges: ReadonlyArray<readonly [string, number]>
): ReadonlyArray<readonly [number, number]> {
  return ranges.map(([base, prefix]) => {
    const baseValue = ipv4ToInt(base) ?? 0
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return [((baseValue & mask) >>> 0), mask] as const
  })
}

const CF_IPV4_MASKS = compileCidrs(CF_IPV4_RANGES)
const PUBLIC_DNS_MASKS = compileCidrs(PUBLIC_DNS_IPV4_RANGES)

/** 目标是不是公共 DNS 解析器地址（只做归类，不降权、不拦截） */
export function isPublicDnsIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip)
  if (value === null) return false
  for (const [net, mask] of PUBLIC_DNS_MASKS) {
    if (((value & mask) >>> 0) === net) return true
  }
  return false
}

/**
 * 判断一个 IPv4 地址是否属于 Cloudflare 网段。
 *
 * 用于**降权**而不是**拦截**：优选 IP 库里可能混有 CF 网段，
 * 但用户也可能确实想连某个 CF 地址，此时应给出可诊断的错误而不是静默跳过。
 */
export function isCloudflareIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip)
  if (value === null) return false
  for (const [net, mask] of CF_IPV4_MASKS) {
    // 位运算结果可能是有符号负数，两边统一转无符号再比较
    if (((value & mask) >>> 0) === net) return true
  }
  return false
}

/**
 * 出站候选的来源类型。
 *
 * - `direct`  直连目标本身
 * - `optimized` 优选 IP 落地（连到优选 IP，由它转到目标）
 * - `relay` 反代入口落地（连到第三方反代，由它按 SNI 转到目标）
 * - `proxy`  经代理落地（SOCKS5 / HTTP CONNECT / HTTPS）
 */
export type RouteSource = 'direct' | 'optimized' | 'relay' | 'proxy'

/** 一个出站候选 */
export interface RouteCandidate {
  source: RouteSource
  /** 实际要连的地址 */
  host: string
  port: number
  /** 展示用描述 */
  label: string
  /**
   * 是否为「降权候选」。
   *
   * CF 网段 IP 会被标记为降权：它们在 Worker 运行时必然被拒，
   * 放在候选列表末尾（仅当没有别的选择时才试），避免每次拨号都白等一次超时。
   */
  deprioritized?: boolean
  /** 代理候选：目标主机与端口（由代理负责转发） */
  via?: {
    kind: ProxyKind
    host: string
    port: number
    username?: string
    password?: string
    /** TLS 握手用的 SNI（仅 https 代理） */
    serverName?: string
  }
}

/** 选路输入 */
export interface RouteInput {
  /** 目标主机（用户要访问的） */
  targetHost: string
  /** 目标端口 */
  targetPort: number
  /** 优选 IP 列表（已解析成 IP，按优先级排列） */
  optimizedIps?: Array<{ ip: string; port: number }>
  /** 代理池 */
  proxies?: Array<{
    host: string
    port: number
    kind: ProxyKind
    username?: string
    password?: string
    serverName?: string
  }>
  /**
   * 是否把「直连目标」降权。
   *
   * 场景：目标域名解析到的全是 Cloudflare 网段 —— 此时把域名丢给 `connect()`
   * 让运行时自己解析，必然连回 CF 自家 Anycast 并被拒绝。
   * 此时应优先用解析出的第三方 IP 建连（见 `outbound/dial.ts` 的实测记录）。
   */
  deprioritizeDirect?: boolean
  /**
   * 反代入口候选（第三方反代，按 SNI 转发到目标）。
   *
   * 这是打通 Cloudflare 网段目标的唯一手段，详见 `outbound/relay.ts`。
   */
  relay?: Array<{ ip: string; port: number; label: string }>
  /**
   * 反代入口是否参与**主竞速**（而非仅作兜底）。
   *
   * - true  目标解析结果全是 CF 网段时设 true —— 此时直连/优选必然失败，
   *         反代是唯一出路，让它参与竞速可避免先白等两次超时。
   * - false 其它情况 —— 优先走正常线路（直连 / 优选），反代只作最后兜底。
   */
  relayAsPrimary?: boolean
}

/**
 * 代理类型。
 *
 * `https` 的语义：代理服务器本身走 TLS（需要 `connect({secureTransport:'on'})`），
 * 与 HTTP 代理的「明文 CONNECT 到代理、再由代理做 CONNECT」不同。
 * 这是本项目相对通用实现的增强。
 */
export type ProxyKind = 'direct' | 'socks5' | 'http' | 'https'

/**
 * 生成出站候选列表（按优先级排列）。
 *
 * 顺序与 旧版实现的 `Bt()` 对齐：
 *   1. 代理候选（用户明确配了代理 → 优先）
 *   2. 直连目标
 *   3. 优选 IP 落地
 *
 * 差别在于：**CF 网段的优选 IP 会被降权到末尾**，
 * 且直连目标若是 CF 网段同样降权 —— 这是旧实现踩坑的地方。
 */
export function buildRouteCandidates(input: RouteInput): RouteCandidate[] {
  const out: RouteCandidate[] = []
  const seen = new Set<string>()
  const push = (c: RouteCandidate): void => {
    const key = `${c.source}|${c.host}|${c.port}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(c)
  }

  // 1) 代理候选：用户显式配置的代理优先
  for (const p of input.proxies ?? []) {
    if (p.kind === 'direct') {
      // ProxyIP 语义：连到这个地址，由它把流量转到目标。
      // ⚠️ ProxyIP 常常就是 Cloudflare 网段的 IP（它本来就是「反代入口」），
      // 但 ProxyIP 是**用户显式配置**的，不能像自动发现的优选 IP 那样降权 ——
      // 否则用户配的 ProxyIP 会被排到最后，可能永远轮不到。
      push({
        source: 'proxy',
        host: p.host,
        port: p.port,
        label: `ProxyIP ${p.host}:${p.port}`,
        via: { kind: 'direct', host: p.host, port: p.port },
      })
    } else {
      push({
        source: 'proxy',
        host: p.host,
        port: p.port,
        label: `${p.kind.toUpperCase()} ${p.host}:${p.port}`,
        via: {
          kind: p.kind,
          host: p.host,
          port: p.port,
          username: p.username,
          password: p.password,
          serverName: p.serverName,
        },
      })
    }
  }

  // 2) 直连目标
  const targetIsCf = isCloudflareIpv4(input.targetHost)
  // 直连是否降权：
  //   - 目标本身是 CF 网段 IP → 降权（Worker 连不回 CF 自己的 Anycast 入口）
  //   - 调用方告知「解析结果全是 CF 网段」→ 降权（域名直连必然解析到 CF IP）
  const directDowngraded = targetIsCf || input.deprioritizeDirect === true
  push({
    source: 'direct',
    host: input.targetHost,
    port: input.targetPort,
    label: `直连 ${input.targetHost}:${input.targetPort}`,
    deprioritized: directDowngraded,
  })

  // 3) 优选 IP 落地：非 CF 网段的优先，CF 网段的降权
  const optimized = input.optimizedIps ?? []
  const normal = optimized.filter((o) => !isCloudflareIpv4(o.ip))
  const cfOnly = optimized.filter((o) => isCloudflareIpv4(o.ip))
  for (const o of normal) {
    push({
      source: 'optimized',
      host: o.ip,
      port: o.port,
      label: `优选 ${o.ip}:${o.port}`,
    })
  }
  for (const o of cfOnly) {
    push({
      source: 'optimized',
      host: o.ip,
      port: o.port,
      label: `优选 ${o.ip}:${o.port}（Cloudflare 网段，可能不可达）`,
      deprioritized: true,
    })
  }

  // 4) 反代入口落地：连到第三方反代，由它按 SNI 转到目标。
  //
  // 这是**唯一能打通 Cloudflare 网段目标**的手段 ——
  // 目标就在 CF 网段里，从哪个 Cloudflare 边缘出去都会撞同一堵墙；
  // 只有从第三方反代出去（出口是第三方 VPS）才不受 TCP Loop 限制。
  //
  // 何时参与竞速由调用方决定（见 `outbound/dial.ts`）：
  //   - 目标解析结果全是 CF 网段 → 参与竞速（此时直连/优选必然失败）
  //   - 否则 → 进降权组作兜底（优先走正常线路）
  const relay = input.relay ?? []
  for (const r of relay) {
    push({
      source: 'relay',
      host: r.ip,
      port: r.port,
      label: `反代 ${r.label}`,
      deprioritized: !input.relayAsPrimary,
    })
  }

  // 降权候选统一排到末尾。
  // ⚠️ 必须用**稳定排序**：Array.prototype.sort 在 V8 里对长度 > 10
  // 的数组改用 TimSort（非稳定），会让同权重候选的相对顺序变得不确定，
  // 竞速时「谁先试」就随机了 —— 排查问题时完全无法复现。
  return out
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      const w = Number(Boolean(a.candidate.deprioritized)) - Number(Boolean(b.candidate.deprioritized))
      return w !== 0 ? w : a.index - b.index
    })
    .map((entry) => entry.candidate)
}

/**
 * 把候选列表分成「代理组」与「直连/优选组」。
 *
 * ## 为什么必须分组（而不是全部放进一个竞速池）
 *
 * 用户显式配置代理（SOCKS5 / HTTP / HTTPS）是为了让流量**从指定出口出去**。
 * 若代理候选与直连候选同池竞速，直连一旦先成功就会**静默绕过代理** ——
 * 出口 IP 与用户预期不符，而且没有任何报错（最难察觉的一类故障）。
 *
 * 语义约定（参考 `connecttoPry`）：
 *   - 有代理 → 只走代理；代理全失败 → 抛错（不静默改走直连）
 *   - 无代理 → 走直连 / 优选 IP
 *
 * 降权候选（Cloudflare 网段）单独一组：它们在 Worker 运行时必然被拒，
 * 放进竞速只会拖慢整体并制造噪声，只在正常候选全失败后才试。
 */
export interface CandidateGroups {
  /**
   * 落地代理候选（SOCKS5 / HTTP / HTTPS）。
   *
   * ## ⚠️ 为什么必须与 ProxyIP 分开
   *
   * 两者的**握手成本差一个 RTT**：
   *
   *   ProxyIP（kind='direct'）：只要 TCP 连上就算成功 → **1 RTT**
   *   SOCKS5 / HTTP：还要做认证 + CONNECT → **2~3 RTT**
   *
   * 若把两者放进**同一个并发竞速池**，ProxyIP 必然先赢 ——
   * 于是「配了 SOCKS5 也没用」，而且是**静默**的（出口 IP 与预期不符，无任何报错）。
   *
   * 另一个副作用：多个 SOCKS5 并发竞速会让**所有**代理服务器同时向目标站建连
   * 再被强行断开 —— 白白消耗代理服务器的连接数与配额。
   *
   * 所以两类代理**绝不混在一个池子里**：
   *   - 落地代理 → **顺序故障转移**（一个挂了换下一个，不并发轰炸）
   *   - ProxyIP   → **并发竞速**（都是 1 RTT，并发无害且更快）
   */
  landing: RouteCandidate[]
  /**
   * ProxyIP 候选（kind='direct'）。
   *
   * 语义是「连到这个地址，但请求的目标仍是原始 hostname:port」——
   * 本质是**固定的反代入口**（与 `relayPool` 同一类机制）。
   */
  proxyIp: RouteCandidate[]
  /** 直连 / 优选候选 */
  direct: RouteCandidate[]
  /** 降权候选（Cloudflare 网段），最后才试 */
  fallback: RouteCandidate[]
}

export function groupCandidates(candidates: RouteCandidate[]): CandidateGroups {
  const primary = candidates.filter((c) => !c.deprioritized)
  const proxies = primary.filter((c) => c.source === 'proxy')
  return {
    // 落地代理与 ProxyIP **必须分开**（握手成本差一个 RTT，混池会让 ProxyIP 永远赢）
    landing: proxies.filter((c) => c.via?.kind !== 'direct'),
    proxyIp: proxies.filter((c) => c.via?.kind === 'direct'),
    direct: primary.filter((c) => c.source !== 'proxy'),
    fallback: candidates.filter((c) => c.deprioritized),
  }
}

/** 拨号失败的分类，用于给出可诊断的错误信息 */
export type DialFailureKind =
  /** 被 Cloudflare 拒绝：目标在 CF 自家网段，或目标不可达 */
  | 'blocked'
  /** 被本地策略拦截：环回 / 私网 / 链路本地 / 元数据地址（见 `outbound/guard.ts`） */
  | 'policy'
  /** 超时 */
  | 'timeout'
  /** 其它错误 */
  | 'other'

/** 拨号失败详情 */
export interface DialFailure {
  kind: DialFailureKind
  /** 原始错误信息 */
  message: string
  /** 出站候选描述 */
  candidate: string
}

/**
 * 把拨号异常分类。
 *
 * 旧实现把所有异常都吞成 null，导致「每一层都像目标不可达」，
 * 排查时完全没有线索。这里保留错误类型与候选描述，
 * 让「连不上」能直接看出是**被平台拒绝**还是**超时**还是**配置错**。
 */
export function classifyDialFailure(
  err: unknown,
  candidate: string
): DialFailure {
  const message = err instanceof Error ? err.message : String(err)
  // ⚠️ 策略拦截必须排在「被平台拒绝」之前：两者文案都含「拒绝 / 不可达」类词汇，
  // 但处理方式完全不同 —— 前者换个目标或配代理，后者要换第三方落地。
  if (isTargetBlockedError(err)) {
    return { kind: 'policy', message, candidate }
  }
  if (/proxy request failed|cannot connect to the specified address|TCP Loop/i.test(message)) {
    return { kind: 'blocked', message, candidate }
  }
  if (/timeout|超时|timed out|abort/i.test(message)) {
    return { kind: 'timeout', message, candidate }
  }
  return { kind: 'other', message, candidate }
}

/** 面向用户的失败说明 */
export function explainDialFailure(failure: DialFailure): string {
  switch (failure.kind) {
    case 'blocked':
      return (
        `出站被 Cloudflare 拒绝（${failure.candidate}）：${failure.message}\n` +
        '  常见原因：目标地址在 Cloudflare 自家网段（Worker 不能主动连回 CF 自己的入口）。\n' +
        '  → 换一个第三方 IP，或改用代理落地。'
      )
    case 'policy':
      return (
        `出站被策略拒绝（${failure.candidate}）：${failure.message}\n` +
        '  目标属于环回 / 内网 / 链路本地 / 保留地址，Worker 直连无法到达。\n' +
        '  → 要访问局域网设备，请配置落地代理（由代理侧建连）。'
      )
    case 'timeout':
      return (
        `出站超时（${failure.candidate}）：${failure.message}\n` +
        '  → 该地址当前不可达，可换一条候选或启用代理落地。'
      )
    default:
      return `出站失败（${failure.candidate}）：${failure.message}`
  }
}
