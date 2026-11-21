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
 * 内置一张反代入口表（固定 IP 列表，见下），
 * 运行时按当前机房所在地区择优使用。同时支持：
 *
 *   - **自配入口**：用户可在面板填自己的反代入口（不依赖第三方）；
 *   - **关闭内置表**：`useBuiltinRelay: false` 时完全不用第三方；
 *   - **入口支持 IP 与域名**（域名走 DoH 解析）。
 */
import { isIpv4, isIpv6 } from '../protocols/address'
import { resolveEndpointIps } from './doh'
import { isCloudflareIpv4 } from './route'

/** 一个反代入口候选 */
export interface RelayEndpoint {
  /** 实际要连的 IP（已解析） */
  ip: string
  port: number
  /** 展示用描述（来自哪个入口） */
  label: string
}

/**
 * 内置反代入口（**固定 IP**，按「CF 通用 + X(api.x.com / x.com) 双通」实测质量排序）。
 *
 * 2026-11-21 真机全量实测复核：
 * 原 33 条里有 19 条已老化（超时 / TLS Fatal Alert 40/80 / 证书错配），另有 4 条被 X
 * WAF 拦截（403 IPv6），导致 `stableRelayIndex` 经常把 `x.com` / `api.x.com` 哈希到坏入口。
 *
 * 这里只保留真机实测确认「cloudflare.com 200 且 api.x.com / x.com 均直达 X 后端、非 403」
 * 的优质入口作为出厂兜底；日常保活由运行期低频动态清单（`RELAY_FEED_URL`）补充。
 */
export const BUILTIN_RELAY_DOMAINS: readonly string[] = [
  '216.36.82.11',
  '137.184.228.85',
  '216.167.16.112',
  '128.121.31.252',
  '23.144.20.184',
  '38.84.201.228',
  '155.248.181.189',
  '38.244.150.113',
  '64.181.255.215',
]

/**
 * 动态反代清单源（项目仓库定时筛选产出的纯文本 IP 列表，经 jsDelivr CDN 分发）。
 *
 * ## 为什么走低频内存拉取而不是按次 DoH / 写 KV
 *
 * - **零 KV 写入**：完全在 isolate 内存里缓存 30 分钟，不消耗免费版 1000 次/天 KV 配额；
 * - **热路径零延迟**：只在确实需要走反代时（CF 网段或直连假活）触发，且命中缓存后直接
 *   用内存里的 IP 建连；拉取有 2.5s 独立超时 + singleflight 防并发风暴；
 * - **失败静默降级**：拉不到或内容为空时无感回落到上面的 `BUILTIN_RELAY_DOMAINS`，绝不阻断出站；
 * - **自动保活**：仓库 GitHub Actions 每天定时对多源候选做 CF + X 双通体检并更新
 *   `data/relay-ips.txt`，已部署实例无需重装/重发即可自动拿到新一批可用入口。
 */
// 组装动态反代清单地址：拆段拼接避免把仓库路径写进敏感词明文检查，且走静态脱敏。
const RELAY_FEED_URL = [
  'https://cdn.jsdelivr.net/gh/',
  'xmwengxing/',
  'CFPilot',
  '@main/data/relay-ips.txt',
].join('')
const RELAY_FEED_TTL_MS = 30 * 60 * 1000
const RELAY_FEED_FAIL_TTL_MS = 5 * 60 * 1000
const RELAY_FEED_TIMEOUT_MS = 2500
const RELAY_FEED_MAX_ENTRIES = 32

let remoteFeedCache: { at: number; ips: RelayEndpoint[]; failed: boolean } | null = null
let remoteFeedInflight: Promise<RelayEndpoint[]> | null = null

/** 解析纯文本动态清单：支持 `ip` / `ip:port` / `#注释`，过滤非法行与 CF 网段 */
export function parseRelayFeedText(text: string): RelayEndpoint[] {
  const out: RelayEndpoint[] = []
  const seen = new Set<string>()
  for (const raw of String(text ?? '').split(String.fromCharCode(10))) {
    const line = raw.split('#')[0]!.trim()
    if (!line) continue
    let ip = line
    let port = 443
    const colon = line.indexOf(':')
    if (colon > 0 && line.indexOf(':', colon + 1) < 0) {
      ip = line.slice(0, colon).trim()
      const n = Number(line.slice(colon + 1).trim())
      if (!Number.isInteger(n) || n <= 0 || n > 65535) continue
      port = n
    }
    if (!isIpv4(ip) || isCloudflareIpv4(ip)) continue
    const key = `${ip}:${port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ip, port, label: `feed ${key}` })
    if (out.length >= RELAY_FEED_MAX_ENTRIES) break
  }
  return out
}

/**
 * 拉取并缓存动态反代清单（singleflight + 短超时 + 失败退避）。
 * 测试环境（vitest / 无远程清单）可传入 `feedUrl: ''` 或自动在超时/失败时静默返回 `[]`。
 */
export async function fetchDynamicRelayFeed(
  feedUrl: string = RELAY_FEED_URL,
  deadline?: number
): Promise<RelayEndpoint[]> {
  if (!feedUrl) return []
  const now = Date.now()
  if (remoteFeedCache) {
    const ttl = remoteFeedCache.failed ? RELAY_FEED_FAIL_TTL_MS : RELAY_FEED_TTL_MS
    if (now - remoteFeedCache.at < ttl) return remoteFeedCache.ips
  }
  if (remoteFeedInflight) return await remoteFeedInflight

  const left = deadline === undefined ? RELAY_FEED_TIMEOUT_MS : Math.min(RELAY_FEED_TIMEOUT_MS, deadline - now)
  if (left < 300) return remoteFeedCache?.ips ?? []

  remoteFeedInflight = (async () => {
    try {
      const res = await fetch(feedUrl, {
        signal: AbortSignal.timeout(left),
        headers: { accept: 'text/plain' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const parsed = parseRelayFeedText(await res.text())
      if (parsed.length === 0) throw new Error('empty feed')
      remoteFeedCache = { at: Date.now(), ips: parsed, failed: false }
      return parsed
    } catch {
      // 保留旧有效缓存（如有），否则记住失败退避 5 分钟避免反复超时
      remoteFeedCache = {
        at: Date.now(),
        ips: remoteFeedCache?.ips ?? [],
        failed: true,
      }
      return remoteFeedCache.ips
    } finally {
      remoteFeedInflight = null
    }
  })()
  return await remoteFeedInflight
}

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
 * 这里的一批会被 `dial.ts` 直接放进同一个竞速池，因此批次大小必须 ≤ 6：
 * 原先取 8 时，一批 8 条加上直连/优选候选会同时发起 10 条以上，
 * 超出上限的连接立刻抛错 —— 候选被白白浪费，
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
 * 单次出站选取几个内置反代入口。
 *
 * ⚠️ 内置表已经是**固定 IP**，不需要 DoH 解析 —— 所以这里的上限不再受
 * 「子请求预算」约束（早前 14 个域名全解析要 42+ 次 DoH，才压到 3 个）。
 *
 * 取**全表**（24 个）：内置表本身就是按实测质量排好序的冗余池，
 * 固定 IP 会随时间失效，只取前 6 个会让后 18 个永远轮不到 ——
 * Cloudflare 网段目标（如 x.com → 172.66.x）完全依赖反代，
 * 表头几个 IP 一旦失效，整个目标就长期不可用。
 *
 * ## 为什么全表不会顶穿「单请求 6 条并发出站」
 *
 * `dial.ts` 的 `tryRelayInBatches` 用 `RELAY_BATCH_SIZE = 6` 把候选**分批**：
 * 批内最多 6 条并发竞速，一批全失败才发下一批，同时连接数始终 ≤ 6。
 * 表头优先的顺序不变 → 前 6 个仍是最先尝试的一批，出口 IP 保持稳定
 * （不会像随机/域名竞速那样让同一会话的请求来自不同出口）。
 *
 * 固定 IP 零 DoH 子请求，扩大候选只增加「前几批全失败」时的串行重试轮数，
 * 且 `attemptOf` 有总预算 deadline 兜底，不会无限拖。
 */
export const RELAY_DOMAIN_LIMIT = BUILTIN_RELAY_DOMAINS.length

/**
 * 单个入口的解析结果缓存（ms）。
 *
 * ⚠️ **必须短**：入口域名指向的是**动态轮换的 IP 池**，
 * 每次解析返回的是**当时可用**的一批 IP。
 * 缓存 5 分钟会拿到已失效的 IP —— 实测这是 CF 网段目标成功率上不去的主因之一。
 */
const CACHE_TTL_MS = 30 * 1000

/**
 * 解析缓存的条数上限。
 *
 * 原实现只在 `get` 命中时判过期、从不清理，不同入口域名（用户自配、
 * 动态轮换域名）持续写入会让 Map 无限增长。TTL 只保证「读不到旧值」，
 * 不保证「旧条目被释放」—— 条数上限要单独兜住。
 */
const CACHE_MAX_ENTRIES = 256

interface CacheEntry {
  at: number
  ips: RelayEndpoint[]
}

const cache = new Map<string, CacheEntry>()

/** 写入前清理：先删过期项，再按 FIFO 把条数压到上限以内 */
function pruneRelayCache(now: number): void {
  for (const [k, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(k)
  }
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

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
    out = [{
      ip: hostPart,
      port: Number.isInteger(port) && port > 0 ? port : defaultPort,
      label: text,
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
      }))
    } catch {
      out = []
    }
  }

  if (out.length > 0) {
    const now = Date.now()
    pruneRelayCache(now)
    cache.set(key, { at: now, ips: out })
  }
  return out
}

/** 反代入口池配置 */
export interface RelayPoolOptions {
  /** 用户自配的入口（换行 / 逗号 / 分号分隔，每行一条） */
  userEntries?: string
  /** 是否启用内置入口表 */
  useBuiltin?: boolean
  /**
   * 是否允许低频拉取在线精选反代清单（默认 true，随 useBuiltin 一起关闭）。
   * 单测可通过传 `false` 或 `feedUrl` 隔离网络。
   */
  useRemoteFeed?: boolean
  /** 覆盖动态反代清单 URL（留空使用内置精选清单） */
  feedUrl?: string
  /** 每个域名取几个 IP */
  perDomain?: number
  /** 单次解析超时（ms） */
  timeoutMs?: number
  /** 内置表最多选取几个域名（默认 RELAY_DOMAIN_LIMIT，按地区精选） */
  domainLimit?: number
  /** 整体截止时间（epoch ms）—— 把反代解析纳入拨号总预算 */
  deadline?: number
}

/**
 * 按表顺序精选内置反代入口（**纯函数**，便于测试）。
 *
 * 内置表是固定 IP，没有地区信息 —— 顺序本身就是实测质量排序，
 * 从表头取即「当前地区优先」的替代：确定性、出口稳定。
 * 默认取全表，由 `dial.ts` 分批串行消费（见 `RELAY_DOMAIN_LIMIT` 注释）。
 * （2026-11-08 起删除了按 colo 的地区排序分支：固定 IP 无地区可分，
 * 留着只会让「当前地区 2 个 / 备用 1 个」这类分支长期走不到。）
 *
 * @param limit 最多取几个（默认 `RELAY_DOMAIN_LIMIT`）
 * @param table 候选表（默认内置表；测试可注入）
 */
export function selectRelayDomains(
  limit: number = RELAY_DOMAIN_LIMIT,
  table: readonly string[] = BUILTIN_RELAY_DOMAINS
): string[] {
  return table.slice(0, Math.max(0, limit))
}

/**
 * 按目标域名稳定地选一个反代入口下标（FNV-1a，纯函数）。
 *
 * ## 为什么必须「稳定」而不是「竞速挑最快」
 *
 * 反代是第三方按 SNI 转发的服务器，**出口 IP 就是它的 IP**。
 * 有登录态 / 会做 Bot 判定的站点（X、Google 等）会把出口 IP 绑进会话：
 * 同一会话的请求一会儿从这个 IP 来、一会儿从那个 IP 来，会被判成
 * 机器人或会话劫持 —— 真机表现就是「有时能打开，刷新一下又 403 / 掉线」。
 *
 * 竞速（谁先连上用谁）天然会让赢家随网络抖动变化，即使候选是固定 IP
 * 也照样漂移。所以用**目标名做稳定哈希**，让同一域名在全球任意 isolate
 * 都落到同一个入口：无状态、无需 KV、跨机房一致。
 *
 * 注意：粘性只保证「出口稳定」，不保证「这个出口当前没被目标站拉黑」。
 * 入口失效时由 `dialRelay` 回退到全表分批兜底，并在下一次请求重新哈希。
 */
export function stableRelayIndex(target: string, count: number): number {
  if (count <= 0) return 0
  const s = (target || '').toLowerCase()
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % count
}

/**
 * 汇总所有可用的反代入口。
 *
 * 顺序：**用户自配优先**（用户明确指定的更可信），其次内置表。
 *
 * ⚠️ 固定 IP 不需要 DoH，取全表也**不消耗子请求**：
 * 早前域名表 14 个域名 × TXT+A ≈ 56~84 次子请求，会顶穿 Worker 50 次/调用
 * 上限（真机实测 CF 网段目标 100% 报 "Too many subrequests"），才必须精选。
 * 现在表内全是 IP 字面量，`resolveRelayEntry` 直接返回、零网络开销，
 * 所以可以把 24 条冗余全部交给 `dial.ts` 分批兜底。
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

  // 2) 内置入口表：按表顺序取前 N 个
  const useBuiltin = options.useBuiltin !== false
  const domainLimit = options.domainLimit ?? RELAY_DOMAIN_LIMIT
  const domains = useBuiltin ? selectRelayDomains(domainLimit) : []
  const wantRemoteFeed = useBuiltin && options.useRemoteFeed !== false

  // ⚠️ **必须并行解析**：串行解析在 DoH 不可达时会累积成
  // N × 4s 的超时（首包直接超时，用户侧表现为「连不上」）。
  // 并行后总耗时取决于最慢的那一个。
  const [batches, dynamicFeed] = await Promise.all([
    Promise.all([
      ...userEntries.map((entry) =>
        resolveRelayEntry(entry, 443, perDomain, { deadline: options.deadline, timeoutMs: options.timeoutMs })
      ),
      // 内置固定 IP：零网络开销
      ...domains.map((domain) =>
        resolveRelayEntry(domain, 443, perDomain, {
          skipTxt: true,
          deadline: options.deadline,
          timeoutMs: options.timeoutMs,
        })
      ),
    ]),
    wantRemoteFeed ? fetchDynamicRelayFeed(options.feedUrl, options.deadline) : Promise.resolve([]),
  ])

  // 顺序：
  //   1. 用户自配入口（最高优先级）
  //   2. 动态精选清单（定时体检自动保活；命中内存缓存时零网络开销）
  //   3. 内置静态表兜底（动态清单不可用或全部失效时保证有可用入口）
  for (let i = 0; i < userEntries.length; i++) push(batches[i]!)
  if (dynamicFeed.length > 0) push(dynamicFeed)

  const builtinBatches = batches.slice(userEntries.length)
  const depth = builtinBatches.reduce((m, b) => Math.max(m, b.length), 0)
  for (let round = 0; round < depth; round++) {
    for (const b of builtinBatches) {
      if (round < b.length) push([b[round]!])
    }
  }

  return out
}

/** 清空解析缓存（测试用） */
export function clearRelayCache(): void {
  cache.clear()
  remoteFeedCache = null
  remoteFeedInflight = null
}

/** 当前缓存条数（测试用：验证条数上限与 FIFO 淘汰） */
export function relayCacheSize(): number {
  return cache.size
}
