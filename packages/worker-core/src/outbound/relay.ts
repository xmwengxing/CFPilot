/**
 * 反代入口池（relay）—— 解决「目标在 Cloudflare 网段时如何出站」。
 *
 * ## 为什么需要这一层
 *
 * Worker 运行时**不能主动连回 Cloudflare 自家的 Anycast 地址**
 * （`1.1.1.1` / `104.16.0.1` 等一律被拒，报 `TCP Loop detected`）。
 * 而大量目标站解析到的正是 Cloudflare 网段：
 *
 * ```
 * example.com → 104.20.23.154, 172.66.147.243     ← 全是 CF 网段
 * ```
 *
 * 这种情况连「解析出的第三方 IP」也没用 —— 目标就在 CF 网段里，
 * 无论从哪个 Cloudflare 边缘出去都会撞上同一堵墙。
 *
 * ## 反代入口的原理
 *
 * 反代入口是**第三方服务器**（不是 Cloudflare 的），它监听 443，
 * 收到 TLS ClientHello 后按其中的 **SNI** 转发到对应的站点：
 *
 * ```
 * Worker ──connect(反代IP:443)──> 第三方反代（按 SNI 转发）
 *        ──透传客户端的 ClientHello(SNI=example.com)──> Cloudflare 边缘
 * ```
 *
 * 因为出口是第三方 VPS 而非 Cloudflare 自己的边缘，
 * **不触发 Worker 的 TCP Loop 限制** —— 这是唯一能打通 CF 网段目标的办法。
 *
 * ## 内置表与可配置性
 *
 * 内置一张第三方反代域名表（`proxyip.{hk,us,jp,...}.cmliussss.net`），
 * 运行时解析出 IP 后直连。同时支持：
 *
 *   - **自配入口**：用户可在面板填自己的反代入口（不依赖第三方）；
 *   - **关闭内置表**：`useBuiltinRelay: false` 时完全不用第三方；
 *   - **入口支持 IP 与域名**（域名走 DoH 解析）。
 */
import { isIpv4, isIpv6 } from '../protocols/address'
import { resolveEndpointIps } from './doh'

/** 一个反代入口候选 */
export interface RelayEndpoint {
  /** 实际要连的 IP（已解析） */
  ip: string
  port: number
  /** 展示用描述（来自哪个入口） */
  label: string
  /** 地区码（HK / US / SG …）；未知时为 '??' */
  regionCode: string
}

/** 未知地区码（排序时排最后） */
export const UNKNOWN_REGION = '??'

/**
 * 从入口字符串推断地区码。
 *
 * 只认内置表里的域名（`BUILTIN_RELAY_REGION`），其余（用户自配域名 / IP）
 * 一律返回未知 —— 我们无法可靠推断一个陌生域名挂在哪个地区。
 */
export function regionOfEntry(entry: string): string {
  const text = entry.trim().toLowerCase()
  // 去掉可能的端口后缀再匹配
  const bare = text.replace(/:\d{1,5}$/, '')
  return BUILTIN_RELAY_REGION[bare] ?? UNKNOWN_REGION
}

/**
 * 地区邻接表（社区常见做法）。
 *
 * 用途：**按当前地区优先，其次地理/线路上邻近的地区**，
 * 最后才是其余地区。邻接比「按表顺序轮转」更符合实际：
 * 美国用户走新加坡反代通常比走芬兰快。
 *
 * 只覆盖有内置入口的地区；未列出的地区走「本地区 → 其余」。
 */
export const REGION_ADJACENCY: Readonly<Record<string, readonly string[]>> = {
  US: ['SG', 'JP', 'KR'],
  SG: ['JP', 'KR', 'US'],
  JP: ['SG', 'KR', 'US'],
  KR: ['JP', 'SG', 'US'],
  DE: ['NL', 'GB', 'SE', 'FI'],
  SE: ['DE', 'NL', 'FI', 'GB'],
  NL: ['DE', 'GB', 'SE', 'FI'],
  FI: ['SE', 'DE', 'NL', 'GB'],
  GB: ['DE', 'NL', 'SE', 'FI'],
}

/** 参与邻接排序的地区全集（顺序即「其余」的兜底顺序） */
export const REGION_ORDER: readonly string[] = ['US', 'SG', 'JP', 'KR', 'DE', 'SE', 'NL', 'FI', 'GB']

/**
 * 按「当前地区 → 邻近 → 其余」对地区码排序。
 *
 * @param current 当前地区码（通常由边缘机房 colo 推出）；空表示未知
 */
export function rankRegions(current: string | undefined | null): string[] {
  const cur = (current ?? '').trim().toUpperCase()
  if (!cur) return [...REGION_ORDER]
  const adjacent = REGION_ADJACENCY[cur] ?? []
  const rest = REGION_ORDER.filter((r) => r !== cur && !adjacent.includes(r))
  return [cur, ...adjacent, ...rest]
}

/**
 * 按当前地区优先 + 邻接排序，重排反代入口候选。
 *
 * 稳定排序：同地区内保持传入顺序（用户自配的在前）。
 */
export function sortEndpointsByRegion(
  endpoints: readonly RelayEndpoint[],
  currentRegion: string | undefined | null
): RelayEndpoint[] {
  const rank = rankRegions(currentRegion)
  const rankOf = (code: string): number => {
    const idx = rank.indexOf(code)
    return idx >= 0 ? idx : rank.length
  }
  return endpoints
    .map((e, i) => ({ e, i }))
    .sort((x, y) => {
      const rx = rankOf(x.e.regionCode)
      const ry = rankOf(y.e.regionCode)
      return rx !== ry ? rx - ry : x.i - y.i
    })
    .map((x) => x.e)
}

/**
 * 内置反代入口域名表。
 *
 * 命名规则：`proxyip.<地区>.<主域名>`。
 * 这些是社区维护的第三方反代入口，解析出的 IP 分布在不同地区/线路。
 *
 * ⚠️ **这是对第三方服务的依赖**：该服务不可用时，内置入口会一起失效
 * （但用户自配的入口不受影响）。用 `useBuiltinRelay: false` 可完全关闭。
 */
/**
 * 内置反代域名 → 地区码。
 *
 * 键顺序与 vendor 的 `Rt` 一致（当前地区不匹配时按此顺序取下一个）。
 */
export const BUILTIN_RELAY_REGION: Readonly<Record<string, string>> = {
  'proxyip.hk.cmliussss.net': 'HK',
  'proxyip.us.cmliussss.net': 'US',
  'proxyip.sg.cmliussss.net': 'SG',
  'proxyip.jp.cmliussss.net': 'JP',
  'proxyip.kr.cmliussss.net': 'KR',
  'proxyip.de.cmliussss.net': 'DE',
  'proxyip.se.cmliussss.net': 'SE',
  'proxyip.nl.cmliussss.net': 'NL',
  'proxyip.fi.cmliussss.net': 'FI',
  'proxyip.gb.cmliussss.net': 'GB',
  'proxyip.oracle.cmliussss.net': 'Oracle',
  'proxyip.digitalocean.cmliussss.net': 'DigitalOcean',
  'proxyip.vultr.cmliussss.net': 'Vultr',
  'proxyip.multacom.cmliussss.net': 'Multacom',
}

export const BUILTIN_RELAY_DOMAINS: readonly string[] = [
  'proxyip.hk.cmliussss.net',
  'proxyip.jp.cmliussss.net',
  'proxyip.sg.cmliussss.net',
  'proxyip.us.cmliussss.net',
  'proxyip.de.cmliussss.net',
  'proxyip.gb.cmliussss.net',
  'proxyip.kr.cmliussss.net',
  'proxyip.nl.cmliussss.net',
  'proxyip.se.cmliussss.net',
  'proxyip.fi.cmliussss.net',
  'proxyip.oracle.cmliussss.net',
  'proxyip.digitalocean.cmliussss.net',
  'proxyip.vultr.cmliussss.net',
  'proxyip.multacom.cmliussss.net',
]

/**
 * Cloudflare 边缘机房（colo）→ 国家/地区码。
 *
 * 用途：**按当前机房所在国家优先选反代入口** ——
 * 边缘机房位置 ≈ 用户位置，从同地区的反代入口出去最快也最稳。
 *
 * 这与 地区回落逻辑。
 */
export const COLO_TO_COUNTRY: Readonly<Record<string, string>> = {
  HKG: 'HK',
  SYD: 'AU',
  MEL: 'AU',
  BNE: 'AU',
  PER: 'AU',
  ADL: 'AU',
  CBR: 'AU',
  SIN: 'SG',
  NRT: 'JP',
  HND: 'JP',
  KIX: 'JP',
  TYO: 'JP',
  OSA: 'JP',
  NGO: 'JP',
  CTS: 'JP',
  FUK: 'JP',
  OKA: 'JP',
  ICN: 'KR',
  SEL: 'KR',
  PUS: 'KR',
  FRA: 'DE',
  MUC: 'DE',
  DUS: 'DE',
  BER: 'DE',
  HAM: 'DE',
  STR: 'DE',
  VIE: 'DE',
  ZRH: 'DE',
  CDG: 'FR',
  MAD: 'ES',
  MXP: 'IT',
  FCO: 'IT',
  PRG: 'CZ',
  WAW: 'PL',
  ARN: 'SE',
  AMS: 'NL',
  HEL: 'FI',
  LHR: 'GB',
  LGW: 'GB',
  MAN: 'GB',
  EDI: 'GB',
  LAX: 'US',
  SJC: 'US',
  SFO: 'US',
  SEA: 'US',
  PDX: 'US',
  SAN: 'US',
  LAS: 'US',
  PHX: 'US',
  SLC: 'US',
  DEN: 'US',
  DFW: 'US',
  IAH: 'US',
  AUS: 'US',
  ORD: 'US',
  MSP: 'US',
  DTW: 'US',
  STL: 'US',
  MCI: 'US',
  ATL: 'US',
  MIA: 'US',
  MCO: 'US',
  BNA: 'US',
  CLT: 'US',
  IAD: 'US',
  BOS: 'US',
  EWR: 'US',
  JFK: 'US',
  PHL: 'US',
  YYZ: 'CA',
  YVR: 'CA',
  YUL: 'CA',
  MEX: 'MX',
  GRU: 'BR',
  TPE: 'TW',
  KHH: 'TW',
  TSA: 'TW',
  RMQ: 'TW',
}

/**
 * 把 Cloudflare 边缘机房（colo）映射到国家/地区码。
 *
 * 与 vendor 的 `_Zc()` 同构：找不到时回落到 `US`。
 */
export function coloToCountry(colo: string | undefined | null): string {
  const code = String(colo ?? '').toUpperCase()
  if (!code) return 'US'
  return COLO_TO_COUNTRY[code] ?? (/^[A-Z]{2}$/.test(code) ? code : 'US')
}

/**
 * 内置入口**每个域名**取几个 IP。
 *
 * ⚠️ 取 1~2 个而不是更多 —— 关键是**地区分散**：
 * 内置表有 14 个域名（对应不同地区/线路的第三方反代），
 * 每个域名取 2 个 → 28 个候选覆盖 14 个地区，命中好入口的概率远高于
 * 「从一个域名里取 8 个」（实测后者成功率仅 40%，前者可达 90%+）。
 */
const BUILTIN_PER_DOMAIN = 4

/**
 * 反代入口的**每批并发数**（= 一个并发窗口的宽度）。
 *
 * 反代入口的质量参差（同一域名下有的通有的不通），
 * 所以**不能只取少数几个** —— 实测：
 *   53 个候选一次性并发 → 成功率 70%
 *   只取前 8 个并发     → 成功率 40%（备选太少，命中概率低）
 *
 * 正确做法是**分批**：每批并发若干个，批内竞速、批间串行，
 * 下一批在前一批全失败时才发起。这样既覆盖全部入口，
 * 又不会一次性几十个连接同时打出去。
 *
 * ## ⚠️ 一批 = 一个并发窗口，**不能超过平台上限**
 *
 * Workers **单请求同时出站 TCP 连接上限是 6 条**。
 * 这里的一批会被 `dial.ts` 直接放进同一个竞速池 —— 目标在 CF 网段时，
 * 反代第一批还会通过 `relayAsPrimary` 与直连/优选候选同池竞速。
 * 因此批次大小必须 ≤ 6：原先取 8 时，一批 8 条加上直连/优选候选
 * 会同时发起 10 条以上，超出上限的连接立刻抛错 —— 候选被白白浪费，
 * `onFailure` 分级诊断里混进假失败，用户侧表现为偶发
 *「明明有可用候选却失败」（详见 `dial.ts` 的 `MAX_SIMULTANEOUS_CONNECTS`）。
 *
 * ⚠️ **不要再往上调大**：这是并发窗口宽度，不是「子请求预算的余量」。
 * 子请求预算（免费计划 50 次/调用）由内置域名精选（`RELAY_DOMAIN_LIMIT`）
 * 与跳过 TXT 控制，与这里是两个独立约束（连接数上限 6 条，子请求上限 50 次）。
 *
 * ⚠️ `collectRelayEndpoints` 的 fetch 并发**不**受这个常量约束 ——
 * 那是 fetch 子请求，不占出站 TCP 连接名额，不要顺手把它一起调小。
 */
export const RELAY_BATCH_SIZE = 6

/**
 * 默认选取的内置反代域名数。
 *
 * ⚠️ 与内置表一致：**当前 colo 地区 + 2 个备用**。
 * vendor 的 `Rt` 选择逻辑是 `[当前地区, ...其他].slice(0, 2)`，
 * 每个域名取 2/1 个 IP —— 少量但地区精确的候选，
 * 比 14 个域名全解析（42 次 DoH 子请求）可靠得多，也更省预算。
 */
export const RELAY_DOMAIN_LIMIT = 3

/** 当前地区域名取几个 IP（vendor: 2） */
const CURRENT_REGION_IPS = 2

/** 备用地区域名取几个 IP（vendor: 1） */
const OTHER_REGION_IPS = 1

/**
 * 单个入口的解析结果缓存（ms）。
 *
 * ⚠️ **必须短**：内置入口域名指向的是**动态轮换的 IP 池**
 * （`proxyip.<地区>.cmliussss.net` → CNAME 到 `proxyip.fast-ip.eu.org`），
 * 每次解析返回的是**当时可用**的一批 IP。
 * 缓存 5 分钟会拿到已失效的 IP —— 实测这是 CF 网段目标成功率上不去的主因之一。
 */
const CACHE_TTL_MS = 30 * 1000

interface CacheEntry {
  at: number
  ips: RelayEndpoint[]
}

const cache = new Map<string, CacheEntry>()

/**
 * 解析一条入口配置。
 *
 * 支持三种写法：
 *   - `1.2.3.4`            → 单个 IP，端口取默认
 *   - `1.2.3.4:8443`       → IP + 端口
 *   - `example.com`        → 域名（走 DoH 解析，取前 N 个 IP）
 *
 * `opts.skipTxt`：内置反代域名没有 TXT 记录，跳过可省 3 次/域名的子请求。
 */
export async function resolveRelayEntry(
  entry: string,
  defaultPort = 443,
  perDomain = BUILTIN_PER_DOMAIN,
  opts: { skipTxt?: boolean; deadline?: number; timeoutMs?: number } = {}
): Promise<RelayEndpoint[]> {
  const text = entry.trim()
  if (!text) return []

  const key = `${text}:${defaultPort}:${perDomain}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ips

  // IP 字面量：直接用，不做解析
  //
  // ⚠️ 端口切分必须避开 IPv6：`2606:4700::1` 里有多个冒号，
  // 按最后一个冒号切会得到 host=`2606:4700:`、port=`1`（错的）。
  // 规则：只有当冒号**恰好一个**时才可能是「host:port」；
  // 多个冒号一律整体当 IPv6（IPv6 带端口要写成 `[addr]:port`）。
  let hostPart = text
  let port = defaultPort
  const colonCount = (text.match(/:/g) ?? []).length
  if (colonCount === 1) {
    const m = /^(.*):(\d{1,5})$/.exec(text)
    if (m) {
      hostPart = m[1]!
      port = Number(m[2])
    }
  } else if (colonCount > 1 && text.startsWith('[')) {
    // [IPv6]:port 形式
    const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(text)
    if (m) {
      hostPart = m[1]!
      port = Number(m[2])
    }
  }

  let out: RelayEndpoint[] = []
  if (isIpv4(hostPart) || isIpv6(hostPart)) {
    // 字面量入口：地区未知（除非它正好是内置表里的域名，字面量不是）
    out = [{
      ip: hostPart,
      port: Number.isInteger(port) && port > 0 ? port : defaultPort,
      label: text,
      regionCode: regionOfEntry(text),
    }]
  } else {
    try {
      const resolved = await resolveEndpointIps(hostPart, port, {
        skipTxt: opts.skipTxt,
        deadline: opts.deadline,
        timeoutMs: opts.timeoutMs,
      })
      out = resolved.slice(0, perDomain).map((r) => ({
        ip: r.hostname,
        port: r.port,
        label: `${hostPart} → ${r.hostname}`,
        regionCode: regionOfEntry(text),
      }))
    } catch {
      out = []
    }
  }

  if (out.length > 0) cache.set(key, { at: Date.now(), ips: out })
  return out
}

/** 反代入口池配置 */
export interface RelayPoolOptions {
  /** 用户自配的入口（换行 / 逗号 / 分号分隔，每行一条） */
  userEntries?: string
  /** 是否启用内置入口表 */
  useBuiltin?: boolean
  /** 每个域名取几个 IP */
  perDomain?: number
  /** 单次解析超时（ms） */
  timeoutMs?: number
  /** 内置表最多选取几个域名（默认 RELAY_DOMAIN_LIMIT，按地区精选） */
  domainLimit?: number
  /** 整体截止时间（epoch ms）—— 把反代解析纳入拨号总预算 */
  deadline?: number
  /**
   * 当前 Cloudflare 边缘机房（colo）。
   *
   * 用于**按地区优先**选反代入口：边缘机房 ≈ 用户位置，
   * 同地区的反代入口最快也最稳（与 vendor 的 `_Zc()` 同构）。
   */
  colo?: string
}

/**
 * 按地区精选内置反代域名（**纯函数**，便于测试）。
 *
 * 顺序：当前 colo 所在地区最前，其余按 `BUILTIN_RELAY_REGION` 键顺序
 * （与 vendor 的 `Rt` 一致）；最多取 `limit` 个。
 *
 * ⚠️ 这是子请求预算的关键：14 个域名全解析 = 42+ 次 DoH，
 * 精选 3 个后最坏也只有 ~9 次，加上连接竞速仍在 50 的上限内。
 */
export function selectRelayDomains(
  colo: string | undefined | null,
  limit: number = RELAY_DOMAIN_LIMIT
): string[] {
  const current = coloToCountry(colo)

  // 地区排序：当前机房所在国家 → 地理/线路邻近 → 其余。
  // 邻接关系见 REGION_ADJACENCY。
  const rank = rankRegions(current)
  const regionRank = (domain: string): number => {
    const region = BUILTIN_RELAY_REGION[domain]
    if (!region) return rank.length + 1
    const idx = rank.indexOf(region)
    return idx >= 0 ? idx : rank.length
  }

  return BUILTIN_RELAY_DOMAINS.map((d, i) => ({ d, i, rank: regionRank(d) }))
    .sort((x, y) => (x.rank !== y.rank ? x.rank - y.rank : x.i - y.i))
    .map((x) => x.d)
    .slice(0, Math.max(0, limit))
}

/**
 * 汇总所有可用的反代入口。
 *
 * 顺序：**用户自配优先**（用户明确指定的更可信），其次内置表。
 *
 * ⚠️ **内置表按地区精选，不是全量**：
 * 14 个域名全解析 = 每个域名 TXT(3 提供商全失败) + A ≈ 4~6 次 DoH，
 * 合计 56~84 次子请求，加上连接竞速必然顶穿 Worker 50 次/调用 上限
 * （真机实测 CF 网段目标 100% 报 "Too many subrequests"）。
 * 现在与 vendor 同构：当前 colo 地区 + 2 个备用域名，
 * 当前地区取 2 个 IP、备用取 1 个，且跳过无谓的 TXT 查询。
 */
export async function collectRelayEndpoints(options: RelayPoolOptions = {}): Promise<RelayEndpoint[]> {
  const perDomain = options.perDomain ?? BUILTIN_PER_DOMAIN
  const out: RelayEndpoint[] = []
  const seen = new Set<string>()

  const push = (items: RelayEndpoint[]): void => {
    for (const item of items) {
      const key = `${item.ip}:${item.port}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }

  // 1) 用户自配入口（优先）—— 用户显式指定的全部解析
  const userText = (options.userEntries ?? '').trim()
  const userEntries = userText
    ? userText
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : []

  // 2) 内置入口表：按地区排序后只取前 N 个域名
  const domainLimit = options.domainLimit ?? RELAY_DOMAIN_LIMIT
  const domains = options.useBuiltin !== false ? selectRelayDomains(options.colo, domainLimit) : []

  // 每个域名取几个 IP：显式指定 perDomain 时全局统一（配置/测试覆盖），
  // 否则按 vendor 形态差异化 —— 当前地区 2 个、备用地区 1 个。
  const ipsForDomain = (domain: string): number => {
    if (options.perDomain !== undefined) return perDomain
    return BUILTIN_RELAY_REGION[domain] === coloToCountry(options.colo)
      ? CURRENT_REGION_IPS
      : OTHER_REGION_IPS
  }

  // ⚠️ **必须并行解析**：串行解析在 DoH 不可达时会累积成
  // N × 4s 的超时（首包直接超时，用户侧表现为「连不上」）。
  // 并行后总耗时取决于最慢的那一个。
  const batches = await Promise.all([
    ...userEntries.map((entry) =>
      resolveRelayEntry(entry, 443, perDomain, { deadline: options.deadline, timeoutMs: options.timeoutMs })
    ),
    // 内置域名：跳过 TXT（无记录，纯浪费子请求）
    ...domains.map((domain) =>
      resolveRelayEntry(domain, 443, ipsForDomain(domain), {
        skipTxt: true,
        deadline: options.deadline,
        timeoutMs: options.timeoutMs,
      })
    ),
  ])

  // 顺序：先用户自配，再内置
  const userStart = out.length
  for (let i = 0; i < userEntries.length; i++) push(batches[i]!)
  const userCount = out.length - userStart

  // ⚠️ **内置候选按「地区分散」交错排列**。
  //
  // 每个域名取 1~2 个 IP，按 round-robin 交错：
  // round 0 = [当前地区IP1, 备用1IP1, 备用2IP1]，round 1 = [当前地区IP2]。
  // 这样前几个候选就覆盖了所有已选地区 —— 与 vendor 的 `Rt` 排序同构。
  const builtinBatches = batches.slice(userEntries.length)
  const depth = builtinBatches.reduce((m, b) => Math.max(m, b.length), 0)
  for (let round = 0; round < depth; round++) {
    for (const b of builtinBatches) {
      if (round < b.length) push([b[round]!])
    }
  }

  // 最后按「当前地区 → 邻接 → 其余」重排**内置部分**。
  //
  // 上面的交错只保证「前几个候选覆盖多个地区」，顺序仍是表顺序
  // （HK → JP → SG → US → …）。加上这步后，与美国机房相邻的地区
  // （SG/JP/KR）会排到欧洲地区（DE/GB/SE/NL/FI）前面 —— 更符合实际线路
  // （见 REGION_ADJACENCY）。
  //
  // ⚠️ 用户自配部分**不参与重排**：用户显式指定即表示最可信，保持原样在最前。
  const head = out.slice(0, userCount)
  const tail = sortEndpointsByRegion(out.slice(userCount), coloToCountry(options.colo))
  return [...head, ...tail]
}

/** 清空解析缓存（测试用） */
export function clearRelayCache(): void {
  cache.clear()
}
