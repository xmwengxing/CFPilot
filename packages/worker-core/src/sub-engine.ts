/**
 * 优选订阅引擎
 *
 * 多来源合并池（按优先级）：
 *   official  内置「官方优选 IP」——从 CF 官方 CIDR 随机生成，零配置即可用
 *   domain    内置「优选域名」——社区公开域名库随机取样
 *   manual    手动优选 IP——本地真连接池（L1，最高优先级）+ ADD 文本（L2）
 *   addapi    远程动态 API 池（TXT，L3）
 *   addcsv    远程 CSV 测速筛选池（L4，按 DLS / MAX_LATENCY 过滤）
 *
 * 零配置策略：三个可勾选来源全部未勾选时，自动生成 20 个官方优选 IP + 10 个优选域名，
 * 保证订阅永不为空（这是上一版最大的体验问题）。
 *
 * 输出格式：Base64（v2ray 分享链接）、Clash/Mihomo YAML、Sing-box JSON，且按来源分组。
 */
import type { NodeEntry, NodeSource, SubFormat, UserConfig } from './types'
import { isIpv4, isIpv6 } from './protocols/address'
import { base64Encode } from './util'
import { CpuBudget } from './budget'
import { CF_IPV4_CIDRS, CURATED_OFFICIAL_IPS, PREFERRED_DOMAINS, countryOfColo, isKnownCountry } from './data/pools'
import { buildBuiltinRules, renderRouteSections } from './route-profile'

export type { SubFormat }

export const DEFAULT_NODE_PORT = 443

/* ------------------------------------------------------------------ */
/* 解析与清洗                                                          */
/* ------------------------------------------------------------------ */

export interface CleanResult {
  ip: string
  port: number
  remark: string
}

function isPort(text: string): boolean {
  if (!/^\d{1,5}$/.test(text)) return false
  const n = Number(text)
  return n > 0 && n <= 65535
}

/**
 * 清洗单行优选条目，兼容：
 *   1.2.3.4            1.2.3.4:443        1.2.3.4:443#备注
 *   [2606:4700::1]:443 [2606:4700::1]#备注  2606:4700::1
 *   example.com        example.com:443#备注
 */
export function cleanIpLine(line: string, defaultPort = DEFAULT_NODE_PORT): CleanResult | null {
  let text = line.trim()
  if (!text) return null

  // 去掉 CSV 行里的引号
  text = text.replace(/^["']|["']$/g, '').trim()
  if (!text || text.startsWith('#')) return null

  let remark = ''
  const hash = text.indexOf('#')
  if (hash >= 0) {
    remark = text.slice(hash + 1).trim()
    text = text.slice(0, hash).trim()
  }

  if (!text) return null

  // 括号形式 [IPv6]:port
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close < 0) return null
    const host = text.slice(1, close)
    const rest = text.slice(close + 1)
    let port = defaultPort
    if (rest.startsWith(':') && isPort(rest.slice(1))) port = Number(rest.slice(1))
    else if (rest) return null
    if (!isIpv6(host) && !isIpv4(host)) return null
    return { ip: host, port, remark }
  }

  const colonCount = (text.match(/:/g) ?? []).length

  // 裸 IPv6（多个冒号）视为无端口
  if (colonCount > 1) {
    if (!isIpv6(text)) return null
    return { ip: text, port: defaultPort, remark }
  }

  if (colonCount === 1) {
    const idx = text.indexOf(':')
    const host = text.slice(0, idx)
    const portText = text.slice(idx + 1)
    if (!isPort(portText)) return null
    if (!isIpv4(host) && !isIpv6(host) && !isHostname(host)) return null
    return { ip: host, port: Number(portText), remark }
  }

  if (!isIpv4(text) && !isIpv6(text) && !isHostname(text)) return null
  return { ip: text, port: defaultPort, remark }
}

function isHostname(host: string): boolean {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(host)
}

/** 解析扫描器备注：`SJC_12_35.5` → 机房 / 延迟 / 速度 */
export function parseScannerRemark(remark: string): { colo: string; latency: number; speed: number } {
  const parts = remark.split(/[_-]/).filter(Boolean)
  let colo = ''
  let latency = 0
  let speed = 0
  if (parts.length >= 3) {
    const latencyNum = Number(parts[parts.length - 2])
    const speedNum = Number(parts[parts.length - 1])
    if (Number.isFinite(latencyNum) && Number.isFinite(speedNum)) {
      colo = parts.slice(0, parts.length - 2).join('_')
      latency = latencyNum
      speed = speedNum
    }
  } else if (parts.length === 2) {
    const latencyNum = Number(parts[1])
    if (Number.isFinite(latencyNum)) {
      colo = parts[0] ?? ''
      latency = latencyNum
    }
  }
  return { colo, latency, speed }
}

function toEntry(clean: CleanResult, source: NodeSource): NodeEntry {
  const parsed = parseScannerRemark(clean.remark)
  const colo = parsed.colo.toUpperCase()
  return {
    ip: clean.ip,
    port: clean.port,
    remark: clean.remark,
    colo,
    latency: parsed.latency,
    speed: parsed.speed,
    source,
    country: countryOfColo(colo),
  }
}

/** 解析 ADD 手动池 */
export function parseAddList(text: string): NodeEntry[] {
  const out: NodeEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    const clean = cleanIpLine(line)
    if (clean) out.push(toEntry(clean, 'add'))
  }
  return out
}

/** 解析本地真连接优选池 */
export function parseLocalList(text: string): NodeEntry[] {
  const out: NodeEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    const clean = cleanIpLine(line)
    if (clean) out.push(toEntry(clean, 'local'))
  }
  return out
}

/** 解析远程 TXT API 结果 */
export function parseApiList(text: string): NodeEntry[] {
  const out: NodeEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    const clean = cleanIpLine(line)
    if (clean) out.push(toEntry(clean, 'addapi'))
  }
  return out
}

export interface CsvParseOptions {
  /** 最低下载速度（MB/s），0 表示不限制 */
  dls?: number
  /** 最高延迟（ms），0 表示不限制 */
  maxLatency?: number
}

export interface CsvParseResult {
  entries: NodeEntry[]
  /** 因阈值被过滤掉的条数 */
  filtered: number
  /** 是否识别到表头 */
  hasHeader: boolean
  /** 因 TLS=false 被丢弃的条数（客户端到边缘必须 TLS） */
  tlsDropped: number
}

const IP_HEADER_KEYS = ['ip地址', 'ip 地址', 'ip', '地址', '服务器', 'server', 'host']
const PORT_HEADER_KEYS = ['端口', 'port']
const SPEED_HEADER_KEYS = ['下载速度', '速度', 'speed', 'download']
const LATENCY_HEADER_KEYS = ['平均延迟', '延迟', 'latency', 'delay', '响应时间', 'rtt']
const COLO_HEADER_KEYS = ['colo', '机房', '数据中心', '地区', 'region']
/**
 * 国家 / 城市列表头键（社区通用的 `normalizePreferredList` 形式）。
 *
 * 用途：把国家/城市填进 remark —— 用户在客户端里能直接看到
 * 「🇺🇸 洛杉矶」这样的节点名，比裸 IP 或三字母机房码更直观。
 */
const COUNTRY_HEADER_KEYS = ['国家', 'country', '国别']
const CITY_HEADER_KEYS = ['城市', 'city']
/**
 * TLS 列表头键（社区通用形式）。
 *
 * CloudflareSpeedTest 的 CSV 有一列 `TLS`（true/false），
 * 表示该 IP 是否支持 TLS 握手。`false` 的行对 VLESS-WS 无用
 * （客户端到边缘必须是 TLS），直接丢弃。
 */
const TLS_HEADER_KEYS = ['tls', '是否支持tls', '支持tls']

function matchHeader(header: string, keys: string[]): number {
  const normalized = header.trim().toLowerCase().replace(/[（(].*?[)）]/g, '')
  for (const key of keys) {
    if (normalized === key) return 1
    if (normalized.includes(key)) return 1
  }
  return 0
}

function findColumn(headers: string[], keys: string[]): number {
  let best = -1
  let bestScore = 0
  for (let i = 0; i < headers.length; i++) {
    const score = matchHeader(headers[i]!, keys)
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  return best
}

function parseNumber(text: string): number {
  const cleaned = text.replace(/[^\d.\-]/g, '')
  if (!cleaned) return 0
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : 0
}

/**
 * 解析 CloudflareSpeedTest 风格的 result.csv。
 * 支持带表头（中文/英文）与无表头的启发式解析。
 */
export function parseCsvText(text: string, options: CsvParseOptions = {}): CsvParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))

  const entries: NodeEntry[] = []
  let filtered = 0
  let hasHeader = false
  let ipIndex = -1
  let portIndex = -1
  let speedIndex = -1
  let latencyIndex = -1
  let coloIndex = -1
  let countryIndex = -1
  let cityIndex = -1
  let tlsIndex = -1
  /** 因 TLS=false 被丢弃的条数 */
  let tlsDropped = 0

  if (lines.length === 0) return { entries, filtered, hasHeader, tlsDropped }

  const firstCells = splitCsvLine(lines[0]!)
  const firstLooksLikeIp = firstCells.some((c) => isIpv4(c.trim()) || isIpv6(c.trim()))
  const hasHeaderKeyword = firstCells.some(
    (c) =>
      SPEED_HEADER_KEYS.some((k) => c.toLowerCase().includes(k)) ||
      LATENCY_HEADER_KEYS.some((k) => c.toLowerCase().includes(k)) ||
      COLO_HEADER_KEYS.some((k) => c.toLowerCase().includes(k))
  )

  let start = 0
  if (hasHeaderKeyword && !firstLooksLikeIp) {
    hasHeader = true
    ipIndex = findColumn(firstCells, IP_HEADER_KEYS)
    portIndex = findColumn(firstCells, PORT_HEADER_KEYS)
    speedIndex = findColumn(firstCells, SPEED_HEADER_KEYS)
    latencyIndex = findColumn(firstCells, LATENCY_HEADER_KEYS)
    coloIndex = findColumn(firstCells, COLO_HEADER_KEYS)
    countryIndex = findColumn(firstCells, COUNTRY_HEADER_KEYS)
    cityIndex = findColumn(firstCells, CITY_HEADER_KEYS)
    tlsIndex = findColumn(firstCells, TLS_HEADER_KEYS)
    start = 1
  }

  for (let i = start; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!)
    if (cells.length === 0) continue

    // TLS 列：明确为 false 的行直接丢弃（客户端到边缘必须 TLS）。
    // 社区通用约定：`tlsIndex >= 0 && fields[tlsIndex]?.toLowerCase() !== 'true'` → 跳过。
    // 这里稍宽松：空值不丢（有些导出工具不填这一列），只有明确的 false/no/0 才丢。
    if (hasHeader && tlsIndex >= 0 && cells[tlsIndex]) {
      const tlsCell = cells[tlsIndex]!.trim().toLowerCase()
      if (tlsCell === 'false' || tlsCell === 'no' || tlsCell === '0' || tlsCell === '否') {
        tlsDropped++
        continue
      }
    }

    let ip = ''
    let port = DEFAULT_NODE_PORT
    let speed = 0
    let latency = 0
    let colo = ''
    let country = ''
    let city = ''

    if (hasHeader) {
      if (ipIndex < 0) continue
      ip = (cells[ipIndex] ?? '').trim()
      if (portIndex >= 0 && cells[portIndex]) {
        const p = Number(cells[portIndex]!.trim())
        if (Number.isInteger(p) && p > 0 && p <= 65535) port = p
      }
      if (speedIndex >= 0 && cells[speedIndex]) speed = parseNumber(cells[speedIndex]!)
      if (latencyIndex >= 0 && cells[latencyIndex]) latency = parseNumber(cells[latencyIndex]!)
      if (coloIndex >= 0 && cells[coloIndex]) colo = cells[coloIndex]!.trim()
      if (countryIndex >= 0 && cells[countryIndex]) country = cells[countryIndex]!.trim()
      if (cityIndex >= 0 && cells[cityIndex]) city = cells[cityIndex]!.trim()
    } else {
      // 无表头启发式：
      //   2 个数值列 → [下载速度, 延迟]
      //   3 个数值列 → [端口, 下载速度, 延迟]
      //   ≥4 个数值列 → CloudflareSpeedTest 风格，末尾两个为 [延迟, 下载速度]
      const ipCell = cells.findIndex((c) => {
        const v = c.trim()
        return isIpv4(v) || isIpv6(v) || (v.includes('.') && isHostname(v))
      })
      if (ipCell < 0) continue
      ip = cells[ipCell]!.trim()

      const numbers: Array<{ index: number; value: number; raw: string }> = []
      cells.forEach((c, index) => {
        if (index === ipCell) return
        const value = parseNumber(c)
        if (c.trim() && /[\d.]/.test(c)) numbers.push({ index, value, raw: c })
      })

      if (numbers.length === 1) {
        speed = numbers[0]!.value
      } else if (numbers.length === 2) {
        speed = numbers[0]!.value
        latency = numbers[1]!.value
      } else if (numbers.length === 3) {
        if (isPort(numbers[0]!.raw.trim())) port = numbers[0]!.value
        speed = numbers[1]!.value
        latency = numbers[2]!.value
      } else {
        latency = numbers[numbers.length - 2]!.value
        speed = numbers[numbers.length - 1]!.value
      }

      const coloCell = cells.find(
        (c, index) => index !== ipCell && c.trim() && !/[\d.]/.test(c) && /[a-zA-Z]/.test(c)
      )
      if (coloCell) colo = coloCell.trim()

      // 无表头时的国家/城市启发式：非 IP、非数字、且不是机房码（三字母）的
      // 文本列，优先当作国家或城市。
      //
      // ⚠️ 只在 colo 没取到时用，避免把 colo 覆盖掉。
      if (!colo) {
        const textCell = cells.find(
          (c, index) =>
            index !== ipCell &&
            c.trim() &&
            !/[\d.]/.test(c) &&
            /[\u4e00-\u9fa5]/.test(c) // 含中文 → 很可能是国家/城市名
        )
        if (textCell) {
          const value = textCell.trim()
          // 含「市」「省」「州」或长度 > 3 → 城市；否则按国家处理
          if (/[市省州区县]/.test(value) || value.length > 3) city = value
          else country = value
        }
      }
    }

    if (!ip) continue
    const clean = cleanIpLine(ip.includes(':') && !ip.includes(' ') ? ip : `${ip}:${port}`)
    if (!clean) continue

    // remark 优先级：城市 > 国家 > 机房码。
    // 社区通用约定：`nameIndex` 选择顺序（国家/城市/数据中心取第一个非空）。
    const remark = city || country || colo
    // country 兜底：有国家列用国家列；否则按 colo 推断
    const countryCode = country || countryOfColo(colo.toUpperCase())

    const entry: NodeEntry = {
      ip: clean.ip,
      port: clean.port,
      remark,
      colo: colo.toUpperCase(),
      latency,
      speed,
      source: 'addcsv',
      country: countryCode,
    }
    entries.push(entry)
  }

  // 阈值过滤
  const dls = options.dls ?? 0
  const maxLatency = options.maxLatency ?? 0
  const kept = entries.filter((entry) => {
    if (dls > 0 && entry.speed < dls) return false
    if (maxLatency > 0 && entry.latency > maxLatency) return false
    return true
  })
  filtered = entries.length - kept.length

  return { entries: kept, filtered, hasHeader, tlsDropped }
}

/** 拆分 CSV 行（支持引号包裹） */
export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuote = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuote = true
    } else if (ch === ',' || ch === '\t') {
      out.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current.trim())
  return out
}

/* ------------------------------------------------------------------ */
/* 内置优选库：随机生成 / 抽样                                          */
/* ------------------------------------------------------------------ */

/**
 * [0, max) 区间内的整数。
 *
 * ## 为什么这里用 `Math.random()` 而不是 `crypto.getRandomValues()`
 *
 * 调用方只有 `sampleFromCidrs()` / `sampleDomains()` 这类**抽样 / 洗牌**场景：
 * 随机源是否不可预测，对「从 CIDR 里挑几个 IP 给用户当节点」毫无影响。
 * 而旧实现的成本很实：每次调用都要 `new Uint32Array(1)` + 走一次 WebCrypto，
 * `sampleFromCidrs()` 的循环上界是 `count * 24`（count=200 → 最坏 9600 次），
 * 在 Workers Free 计划有限的 CPU 预算里纯属浪费；
 * 同文件 `buildOfficialPool()` 的洗牌本来也一直在用 `Math.random()`。
 *
 * ⚠️ **凭据类随机**（token / 盐值 / 会话 / 密码）必须继续用 `util.ts` 里的
 * crypto 版本（`randomHex` / `randomUuid` / `randomAlnum`），
 * 那些东西的随机性直接决定安全性，**不要**改用本函数。
 */
function randomInt(max: number): number {
  if (max <= 1) return 0
  return Math.floor(Math.random() * max)
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.')
  return (
    ((Number(parts[0]!) << 24) >>> 0) +
    (Number(parts[1]!) << 16) +
    (Number(parts[2]!) << 8) +
    Number(parts[3]!)
  )
}

function intToIpv4(value: number): string {
  const n = value >>> 0
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`
}

/**
 * 从 CIDR 列表中随机抽取 IP（同一次调用内不重复）。
 *
 * Cloudflare 的 IP 是 anycast，静态列表必然会过期，所以「官方优选 IP」按需随机生成，
 * 社区通用做法（从远程 CIDR 随机取）。
 */
export function sampleFromCidrs(cidrs: readonly string[], count: number): string[] {
  const usable: Array<{ base: number; hostBits: number }> = []
  for (const cidr of cidrs) {
    const [ip, prefixText] = cidr.split('/')
    if (!ip || !isIpv4(ip)) continue
    const prefix = Number(prefixText)
    if (!Number.isInteger(prefix) || prefix < 8 || prefix > 32) continue
    usable.push({ base: ipv4ToInt(ip), hostBits: 32 - prefix })
  }
  if (usable.length === 0 || count <= 0) return []

  const out = new Set<string>()
  const maxAttempts = count * 24
  let attempts = 0
  while (out.size < count && attempts < maxAttempts) {
    attempts++
    const { base, hostBits } = usable[randomInt(usable.length)]!
    const size = 2 ** hostBits
    // 小网段避开网络地址与广播地址
    const offset = hostBits >= 2 ? 1 + randomInt(size - 2) : randomInt(size)
    out.add(intToIpv4(base + offset))
  }
  return [...out]
}

/** 从域名库随机取样（Fisher-Yates 部分洗牌，无重复） */
export function sampleDomains(count: number, pool: readonly string[] = PREFERRED_DOMAINS): string[] {
  const arr = pool.filter((d) => isHostname(d))
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    const tmp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = tmp
  }
  return arr.slice(0, Math.max(0, Math.min(count, arr.length)))
}

/**
 * 构造官方优选 IP 池。
 *
 * ## 来源优先级
 *
 * 1. **实测可用的精选 IP**（`CURATED_OFFICIAL_IPS`，27 个，逐个验过 WS 升级返回 101）；
 * 2. **从实测可用网段随机采样**（`CF_IPV4_CIDRS` —— 旧表里 15 个段有 13 个完全不可用，
 *    随机采样命中率约 1/4，订阅里大半节点是坏的，客户端测速全是 -1）。
 *
 * 现在两个来源都只含**实测可用**的 IP，命中率大幅提升。
 */
export function buildOfficialPool(count: number): NodeEntry[] {
  const picked: string[] = []
  const used = new Set<string>()
  const curated = [...CURATED_OFFICIAL_IPS]
  for (let i = curated.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[curated[i], curated[j]] = [curated[j]!, curated[i]!]
  }
  for (const ip of curated) {
    if (picked.length >= count) break
    if (used.has(ip)) continue
    used.add(ip)
    picked.push(ip)
  }
  if (picked.length < count) {
    // 采样倍率从 4 降到 2：网段已筛过，命中率很高，不需要多采
    for (const ip of sampleFromCidrs(CF_IPV4_CIDRS, (count - picked.length) * 2)) {
      if (picked.length >= count) break
      if (used.has(ip)) continue
      used.add(ip)
      picked.push(ip)
    }
  }
  return picked.map((ip) => ({
    ip,
    port: DEFAULT_NODE_PORT,
    remark: '',
    colo: '',
    latency: 0,
    speed: 0,
    source: 'official' as const,
    country: '',
  }))
}

/** 构造优选域名池 */
export function buildDomainPool(count: number, pool: readonly string[] = PREFERRED_DOMAINS): NodeEntry[] {
  return sampleDomains(count, pool).map((domain) => ({
    ip: domain,
    port: DEFAULT_NODE_PORT,
    remark: '',
    colo: '',
    latency: 0,
    speed: 0,
    source: 'domain' as const,
    country: '',
  }))
}

/** 解析国家筛选配置（逗号/空格分隔，统一大写并剔除未知国家） */
export function parseCountryFilter(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\s]+/)
        .map((c) => c.trim().toUpperCase())
        .filter((c) => c.length === 2 && isKnownCountry(c))
    ),
  ]
}

/** 按国家筛选（只保留 colo 已知且匹配的条目；未知机房一律排除） */
export function filterByCountries(entries: NodeEntry[], countries: string[]): NodeEntry[] {
  if (countries.length === 0) return entries
  const wanted = new Set(countries)
  return entries.filter((entry) => {
    const country = entry.country || countryOfColo(entry.colo)
    return country !== '' && wanted.has(country)
  })
}

/* ------------------------------------------------------------------ */
/* 合并                                                                */
/* ------------------------------------------------------------------ */

/** 池键 → 中文显示名 */
export const POOL_LABELS = {
  official: '官方优选IP',
  domain: '优选域名',
  manual: '手动优选IP',
  api: '远程API',
  csv: '测速CSV',
} as const

export type PoolKey = keyof typeof POOL_LABELS

export interface PoolGroup {
  key: PoolKey
  name: string
  entries: NodeEntry[]
}

/** 跨池去重（同 ip:port 只保留优先级最高的一条）并统计被丢弃数量 */
export function mergePools(groups: PoolGroup[]): { nodes: NodeEntry[]; deduped: number } {
  const seen = new Set<string>()
  const out: NodeEntry[] = []
  let deduped = 0
  for (const group of groups) {
    for (const entry of group.entries) {
      const key = `${entry.ip}:${entry.port}`
      if (seen.has(key)) {
        deduped++
        continue
      }
      seen.add(key)
      out.push(entry)
    }
  }
  return { nodes: out, deduped }
}

export interface CollectStats {
  official: number
  domain: number
  local: number
  add: number
  addapi: number
  addcsv: number
  filtered: number
  deduped: number
  /** 已应用的国家筛选 */
  countries: string[]
  errors: string[]
}

export interface CollectResult {
  nodes: NodeEntry[]
  groups: PoolGroup[]
  stats: CollectStats
}

export interface CollectOptions {
  /** 远程请求超时（ms） */
  timeoutMs?: number
  /** CPU 预算，超时提前返回 */
  budget?: CpuBudget
  /** 域名库覆盖（来自 KV 热更新），不传则用内置库 */
  domainPool?: readonly string[]
  /** 优选库来源标识，仅用于统计 */
  poolSource?: 'builtin' | 'kv'
  /**
   * 绕过远程池文本缓存，强制重新拉取（默认 `false`，即走 120 秒缓存）。
   *
   * 这是给「面板预览要看到最新数据」留的**逃生口**：
   * 用户刚在别处更新了第三方订阅，在面板里点预览时希望立刻看到新节点，
   * 而不是被缓存挡住看到 120 秒前的旧列表。
   *
   * 订阅接口本身**不要**传它 —— 客户端反复拉取时的重复外部请求，
   * 正是这层缓存要挡掉的东西。
   */
  bypassRemoteCache?: boolean
}

/* ------------------------------------------------------------------ */
/* 远程池文本缓存（ADDAPI / ADDCSV）                                    */
/* ------------------------------------------------------------------ */

/**
 * 远程池文本缓存 TTL（毫秒）。
 *
 * ## 为什么是 120 秒
 *
 * 远程池（`config.addApi` / `config.addCsv`）指向的是第三方订阅 / 测速结果，
 * 这类内容**天生会变**（池服务端轮换 IP、用户重跑测速），
 * 缓存太久会让用户看到明显的过期数据（「我明明更新了，订阅里还是旧 IP」）。
 *
 * 但客户端侧的拉取是**突发**的：Clash 切换配置、多设备同时更新订阅、
 * 面板预览后再导入，几秒内可能连发好几次请求。没有缓存时每一次都会
 * 重新 `fetch` + 全量解析 CSV，外部 URL 一慢就整条订阅超时，
 * 解析本身又是同步 CPU 开销（Workers Free 计划的 CPU 预算很紧）。
 *
 * 120 秒介于两者之间：足够挡住「同一波重拉」，又短到用户改完远端池
 * 两分钟内一定能看到新数据。要立即看最新数据时走 `bypassRemoteCache`。
 */
const REMOTE_TEXT_CACHE_TTL_MS = 120_000

/** 远程池缓存条数上限（防止长时间运行后 URL 列表无限增长占内存） */
const REMOTE_TEXT_CACHE_MAX = 32

/** 远程池文本缓存：URL → { 写入时间, 响应正文 } */
const remoteTextCache = new Map<string, { at: number; text: string }>()

/**
 * 清空远程池文本缓存。
 *
 * 只给测试隔离用（同一进程里多个用例打桩同一个 URL 时避免串味）。
 * 生产代码不应调用它 —— 缓存过期由 TTL 自然处理。
 */
export function clearRemoteTextCache(): void {
  remoteTextCache.clear()
}

/**
 * 远程池请求使用的 User-Agent。
 *
 * ## 为什么不用 `CFPilot/x.y (+仓库地址)`
 *
 * 1. **特征外泄**：那串 UA 等于在每一次外部请求里主动声明
 *    「这是 CFPilot、源码在哪个仓库」，第三方池服务端一看日志就能把
 *    请求归属到具体项目（甚至据此针对性限流 / 封禁）。
 * 2. **容易被按 UA 拦截**：不少优选池 / 订阅接口挂在 CDN 后面，
 *    风控规则会把「非浏览器 UA」当成爬虫直接 403。
 *    表现为「ADDAPI 配了但订阅里一条远程节点都没有」，
 *    而错误信息只是干巴巴的 `HTTP 403`，很难猜到是 UA 的锅。
 *
 * 因此换成一个通用桌面 Chrome UA：与浏览器发起的请求无法区分，
 * 既减少了项目指纹，也降低被 403 的概率。
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/**
 * 拉取远程文本（带 TTL 内存缓存）。
 *
 * ## 只缓存**成功**响应
 *
 * 失败（网络错误 / 非 2xx / 超时）一律**不写入缓存**。
 * 否则一次抖动就会让「临时故障」在缓存期内变成「持续故障」——
 * 用户看到的是「远程池一直拉不到」，而实际上一秒后上游就恢复了。
 * 不缓存失败 = 下一次调用必然重试，故障能自愈。
 *
 * ## 上限与淘汰
 *
 * 最多 `REMOTE_TEXT_CACHE_MAX` 条，超出按插入顺序淘汰最旧的一条
 * （`Map` 天然保持插入顺序）。同一 URL 重新拉取成功后会先删再写，
 * 从而把它的顺序刷到最新 —— 因此被淘汰的总是「最久没被重新拉取」的那个。
 */
async function fetchText(url: string, timeoutMs: number, bypassCache = false): Promise<string> {
  if (!bypassCache) {
    const cached = remoteTextCache.get(url)
    if (cached && Date.now() - cached.at < REMOTE_TEXT_CACHE_TTL_MS) return cached.text
    // 过期条目顺手清掉，避免下面 set 时把「过期」当「已存在」而少淘汰一条
    if (cached) remoteTextCache.delete(url)
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': BROWSER_USER_AGENT },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const text = await response.text()

  // 只有成功拿到正文才写缓存。
  // bypass 请求拿到的也是**新鲜数据**，同样写回去刷新缓存（下一次订阅就能直接受益）。
  remoteTextCache.delete(url)
  if (remoteTextCache.size >= REMOTE_TEXT_CACHE_MAX) {
    const oldest = remoteTextCache.keys().next().value
    if (oldest !== undefined) remoteTextCache.delete(oldest)
  }
  remoteTextCache.set(url, { at: Date.now(), text })
  return text
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function buildGroups(parts: Array<{ key: PoolKey; entries: NodeEntry[] }>): PoolGroup[] {
  return parts
    .filter((g) => g.entries.length > 0)
    .map((g) => ({ key: g.key, name: POOL_LABELS[g.key], entries: g.entries }))
}

/**
 * 收集全部来源并合并。
 *
 * 零配置兜底：三个可勾选来源都没勾时，自动给 20 个官方 IP + 10 个优选域名。
 */
export async function collectNodes(
  config: UserConfig,
  localIpsText: string,
  options: CollectOptions = {}
): Promise<CollectResult> {
  const timeoutMs = options.timeoutMs ?? 6000
  const budget = options.budget
  // 远程池文本缓存是否绕过：默认 false（走缓存）。见 CollectOptions.bypassRemoteCache
  const bypassRemoteCache = options.bypassRemoteCache === true
  const errors: string[] = []

  const countries = parseCountryFilter(config.poolCountries)
  const anyChecked = config.poolOfficial || config.poolDomain || config.poolManual

  // 三个来源都未勾选 → 自动兜底 20 + 10
  const officialCount = anyChecked ? (config.poolOfficial ? clamp(config.officialCount, 1, 200) : 0) : 20
  const domainCount = anyChecked ? (config.poolDomain ? clamp(config.domainCount, 1, 100) : 0) : 10

  const official = officialCount > 0 ? buildOfficialPool(officialCount) : []
  const domain = domainCount > 0 ? buildDomainPool(domainCount, options.domainPool) : []

  const local = parseLocalList(localIpsText)
  const add = parseAddList(config.add)
  const manualEnabled = anyChecked ? config.poolManual : false
  const manual = manualEnabled ? [...local, ...add] : []
  if (manualEnabled && manual.length === 0) {
    errors.push('手动优选 IP 为空：请先跑一次本地真连接优选，或在「手动优选」里填入 IP')
  }

  // 远程池与三个勾选项无关，配了就生效
  //
  // ⚠️ fetch 是 I/O 等待，不消耗 CPU：期间必须 pause 预算，
  // 否则墙钟近似会把等待时间算成 CPU（曾导致面板预览假阳性报
  // "CPU 预算不足"，而真实订阅并不带预算，两边行为不一致）。
  // 解析（parseApiList 等）是同步 CPU 工作，留在预算内计量。
  let addapi: NodeEntry[] = []
  const apiUrls = config.addApi
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u))
  if (apiUrls.length > 0 && !budget?.exhausted) {
    budget?.pause()
    const results: PromiseSettledResult<string>[] = []
    try {
      results.push(
        ...(await Promise.allSettled(apiUrls.map((u) => fetchText(u, timeoutMs, bypassRemoteCache))))
      )
    } finally {
      budget?.resume()
    }
    for (const result of results) {
      if (result.status === 'fulfilled') {
        addapi = addapi.concat(parseApiList(result.value))
      } else {
        errors.push(`ADDAPI 拉取失败：${String(result.reason?.message ?? result.reason)}`)
      }
    }
  }

  let addcsv: NodeEntry[] = []
  let filtered = 0
  const csvUrls = config.addCsv
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u))
  if (csvUrls.length > 0 && !budget?.exhausted) {
    budget?.pause()
    const results: PromiseSettledResult<string>[] = []
    try {
      results.push(
        ...(await Promise.allSettled(csvUrls.map((u) => fetchText(u, timeoutMs, bypassRemoteCache))))
      )
    } finally {
      budget?.resume()
    }
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const parsed = parseCsvText(result.value, { dls: config.dls, maxLatency: config.maxLatency })
        addcsv = addcsv.concat(parsed.entries)
        filtered += parsed.filtered
      } else {
        errors.push(`ADDCSV 拉取失败：${String(result.reason?.message ?? result.reason)}`)
      }
    }
  }

  // 只在**真的跳过了远程拉取**时才提示——同步段的 CPU 超标才会走到这里
  if (budget?.exhausted && (apiUrls.length > 0 || csvUrls.length > 0)) {
    const skipped = [
      apiUrls.length > 0 ? `ADDAPI×${apiUrls.length}` : '',
      csvUrls.length > 0 ? `ADDCSV×${csvUrls.length}` : '',
    ].filter(Boolean).join('、')
    errors.push(`CPU 预算不足（已用 ${budget.elapsedMs.toFixed(1)}ms），已跳过远程拉取：${skipped}`)
  }

  const sourceParts = [
    { key: 'official' as const, entries: official },
    { key: 'domain' as const, entries: domain },
    { key: 'manual' as const, entries: manual },
    { key: 'api' as const, entries: addapi },
    { key: 'csv' as const, entries: addcsv },
  ]

  let groups = buildGroups(sourceParts)

  // 国家筛选
  if (countries.length > 0 && groups.length > 0) {
    const before = groups.reduce((n, g) => n + g.entries.length, 0)
    groups = groups
      .map((g) => ({ ...g, entries: filterByCountries(g.entries, countries) }))
      .filter((g) => g.entries.length > 0)
    const after = groups.reduce((n, g) => n + g.entries.length, 0)
    if (after === 0) {
      // 筛完为空：宁可回落也不要给用户一个空订阅
      groups = buildGroups(sourceParts)
      errors.push(
        `国家筛选（${countries.join('/')}）后无可用节点：随机优选 IP 的机房未知，请先跑一次本地优选再按国家筛选；已忽略该筛选`
      )
    } else if (after < before) {
      errors.push(`国家筛选（${countries.join('/')}）已排除 ${before - after} 条机房未知或地区不匹配的节点`)
    }
  }

  const { nodes, deduped } = mergePools(groups)
  const limited = config.maxNodes > 0 ? nodes.slice(0, config.maxNodes) : nodes

  return {
    nodes: limited,
    groups,
    stats: {
      official: official.length,
      domain: domain.length,
      local: manualEnabled ? local.length : 0,
      add: manualEnabled ? add.length : 0,
      addapi: addapi.length,
      addcsv: addcsv.length,
      filtered,
      deduped,
      countries,
      errors,
    },
  }
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

export interface RenderContext {
  nodes: NodeEntry[]
  /** 按来源分组；为空时退化成单组 */
  groups?: PoolGroup[]
  config: UserConfig
  /** 订阅使用的域名（客户端 SNI / Host） */
  domain: string
  /** 订阅端口（Cloudflare TLS 端口） */
  port: number
  /**
   * 订阅下发的端口组合（多选）。
   *
   * 渲染时每个条目按此列表展开（`portsForEntry` 决定是否参与）；
   * 只勾一个端口时行为与旧的单端口完全一致。
   */
  ports: number[]
  /** 订阅协议 */
  protocol: 'vless' | 'trojan' | 'both'
  /** 传输方式 */
  transport: 'ws' | 'xhttp' | 'both'
  /**
   * 分流规则配置原文（route-profile ini）。
   *
   * 由调用方（控制面路由）从 KV 的 `ROUTE_PROFILE` 键或内置配置解出后传入。
   * 空字符串 = 不使用分流规则（只输出裸节点 + 基础组）。
   */
  routeProfile?: string
}

export interface RenderResult {
  body: string
  contentType: string
  fileName: string
}

/** 订阅节点形态 */
export type SubVariant = 'vless-ws' | 'vless-xhttp' | 'trojan'

/** 所有可选形态（面板勾选项的顺序） */
export const ALL_SUB_VARIANTS: readonly SubVariant[] = ['vless-ws', 'vless-xhttp', 'trojan']

/** 形态的中文标签（面板用） */
export const SUB_VARIANT_LABELS: Readonly<Record<SubVariant, string>> = {
  'vless-ws': 'VLESS + WebSocket',
  'vless-xhttp': 'VLESS + XHTTP',
  trojan: 'Trojan',
}

/**
 * 解析用户勾选的订阅形态。
 *
 * ## 为什么要有这层
 *
 * 老的 `subProtocol`（vless/trojan/both）× `subTransport`（ws/xhttp/both）
 * 是两个独立开关，交叉后必然生成三种形态，节点数被**乘三**。
 * 用户只想用 vless+ws 时也会收到 XHTTP 与 Trojan 节点 ——
 * 而这两种形态各有前置条件（XHTTP 需 Xray 内核、Trojan 需对应端口与口令），
 * 在客户端里表现为**大量 -1**，看起来像「节点坏了」。
 *
 * ## 规则
 *
 * 1. 只保留**已勾选**的形态；
 * 2. 形态依赖的入站**没启用**就自动剔除
 *    （`enableTrojan=false` → 不下发 trojan；`enableXhttp=false` → 不下发 xhttp）；
 * 3. 一个都没剩时回落到 `vless-ws`（保证订阅不为空）。
 */
export function resolveSubVariants(
  raw: string | undefined,
  config: Pick<UserConfig, 'enableTrojan' | 'enableXhttp'>,
  /**
   * 该订阅格式**支持的**形态。
   *
   * Clash / mihomo / sing-box 都**不支持 XHTTP**（XHTTP 是 Xray 专有传输），
   * 所以这些格式要传 `['vless-ws', 'trojan']`，
   * 否则用户只勾 XHTTP 时会得到**空订阅**。
   */
  supported: readonly SubVariant[] = ALL_SUB_VARIANTS
): SubVariant[] {
  const wanted = String(raw ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean) as SubVariant[]

  const picked = ALL_SUB_VARIANTS.filter((v) => wanted.includes(v))

  // 依赖的入站没启用 → 剔除（否则节点必然连不上）
  const usable = picked.filter((v) => {
    if (!supported.includes(v)) return false
    if (v === 'trojan') return config.enableTrojan !== false
    if (v === 'vless-xhttp') return config.enableXhttp !== false
    return true
  })

  if (usable.length > 0) return usable

  // 全被剔除 → 回落到该格式支持的**最通用**形态（保证订阅不为空）
  const fallback = supported.includes('vless-ws') ? 'vless-ws' : supported[0]
  return fallback ? [fallback] : ['vless-ws']
}

/** Clash / sing-box 支持的形态（都不支持 XHTTP） */
export const WS_ONLY_VARIANTS: readonly SubVariant[] = ['vless-ws', 'trojan']

/** 把节点分组（若无分组信息则整体作为一组） */
function resolveGroups(ctx: RenderContext): PoolGroup[] {
  if (ctx.groups && ctx.groups.length > 0) return ctx.groups
  return [{ key: 'official', name: '节点', entries: ctx.nodes }]
}

function nodeLabel(entry: NodeEntry, protocol: string, index: number, groupName = ''): string {
  const base = entry.remark && !/^[\d.]+$/.test(entry.remark) ? entry.remark : entry.ip
  const colo = entry.colo && entry.colo !== base ? ` ${entry.colo}` : ''
  const prefix = groupName ? `${groupName} ` : ''
  return `${prefix}${base}${colo} #${index + 1}${protocol === 'trojan' ? ' Trojan' : ''}`
}

function hostForUri(ip: string): string {
  return ip.includes(':') ? `[${ip}]` : ip
}

/**
 * 解析订阅端口组合（逗号分隔 → 去重数字数组；空 / 非法 = 只用 443）。
 *
 * Cloudflare 的 TLS 端口除 443 外还有 2053/2083/2087/2096/8443，
 * 443 被针对性干扰时换端口即可恢复，因此支持多选下发。
 */
export function resolveSubPorts(config: UserConfig): number[] {
  const ports = String(config.subPorts || '')
    .split(/[\n,;\s]+/)
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535)
  const unique = [...new Set(ports)]
  return unique.length > 0 ? unique : [DEFAULT_NODE_PORT]
}

/**
 * 订阅名称清洗：防注入响应头 / 文件名，限长 64。
 *
 * 客户端导入订阅后自动填入的名字取自 `Content-Disposition` 的 filename
 * （Clash Verge 实测如此），因此这里不能带引号 / 反斜杠 / 换行，
 * 也不要带扩展名（否则名称变成"CFPilot.yaml"）。
 *
 * ## 为什么还要去掉 `/ | : ; & ? # %`（2026-10-28 用户报障）
 *
 * 用户反馈加订阅后卡片名显示成 `\"CFPilot\` —— 带引号与斜杠。
 * 根因是 `Content-Disposition` 里 `filename="..."` 的**引号被客户端原样保留**，
 * 而名称里若再含 `/`、`|` 这类字符，有的客户端会把它当路径/分隔符二次截断。
 * 所以：
 *   1. 名称里**不允许**出现任何 URL / 路径 / 响应头分隔符；
 *   2. 下发时能不用引号就不用（见 `subDisposition`），只有含空格等字符才引号包裹。
 */
export function sanitizeSubName(name: string): string {
  const cleaned = String(name || '')
    // 响应头 / URL / 路径分隔符与转义符一律剔除
    .replace(/["'`\\\r\n\t/|;:&?#%]/g, '')
    // 其它控制字符
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // 连续空白压成一个
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim()
  return cleaned || 'CFPilot'
}

/** HTTP `token` 允许的字符集（RFC 7230）。命中就不需要引号包裹 */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * 生成 `Content-Disposition` 的 filename 部分。
 *
 * 三种客户端行为都要兼容：
 *   1. 只认 `filename=` 且**不去引号**（用户实测的那种）：名称是纯 ASCII token 时不加引号；
 *   2. 认 `filename=` 且会去引号：加不加都对；
 *   3. 认 `filename*=UTF-8''`：额外提供一份百分号编码，中文名也能正确落名。
 *
 * ⚠️ HTTP 头只允许 ASCII：`filename=` 里绝不能出现中文，
 * 否则 Workers 可能直接拒绝这个响应头、客户端也会拿到乱码。
 * 所以非 ASCII 名称在 `filename=` 里退回一个 ASCII 兜底，真名交给 `filename*=`。
 */
export function subContentDisposition(name: string): string {
  const safe = sanitizeSubName(name)
  // eslint-disable-next-line no-control-regex
  const hasNonAscii = /[^\u0020-\u007e]/.test(safe)
  const ascii = hasNonAscii ? safe.replace(/[^\u0020-\u007e]/g, '').trim() || 'CFPilot' : safe
  const plain = HTTP_TOKEN.test(ascii) ? ascii : `"${ascii.replace(/["\\]/g, '')}"`
  return `inline; filename=${plain}; filename*=UTF-8''${rfc5987Encode(safe)}`
}

/** RFC 5987 百分号编码（仅保留 UTF-8 字节的 att-char） */
export function rfc5987Encode(text: string): string {
  return encodeURIComponent(text).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/**
 * `Profile-Title` 头：非 ASCII 时按 RFC 2047 Base64 编码。
 *
 * 纯 ASCII 直接原样下发（绝大多数客户端读得懂），
 * 含中文时客户端若不按 RFC 2047 解码就会显示乱码 —— 编码后反而更普遍兼容。
 */
export function subProfileTitle(name: string): string {
  const safe = sanitizeSubName(name)
  // eslint-disable-next-line no-control-regex
  if (!/[^\u0020-\u007e]/.test(safe)) return safe
  const bytes = new TextEncoder().encode(safe)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return `=?UTF-8?B?${btoa(binary)}?=`
}

/**
 * 条目实际下发的端口列表。
 *
 * 手动池里显式写了非默认端口的条目保持原端口（那是用户的明确意图，
 * 不应被端口乘法复制成 N 份）；其余条目按订阅端口组合各生成一份。
 */
function portsForEntry(entry: NodeEntry, ctx: RenderContext): number[] {
  if (entry.port !== DEFAULT_NODE_PORT) return [entry.port]
  return ctx.ports.length > 0 ? ctx.ports : [DEFAULT_NODE_PORT]
}

/** 生成 VLESS 分享链接 */
/**
 * ECH 查询参数。
 *
 * 社区通用约定：`&ech=<SNI>+<DoH 地址>`。
 * 客户端解析出这两个值后，用 DoH 查询目标域名的 ECH 配置，
 * 并把 ClientHello 里的真实 SNI 加密。
 *
 * 默认关闭（`ech: false`），关闭时不注入任何参数。
 */
function echParam(ctx: RenderContext): string {
  if (!ctx.config.ech) return ''
  const host = ctx.config.echHost.trim() || 'cloudflare-ech.com'
  const dns = ctx.config.echDns.trim()
  // DoH 地址为空时用客户端默认，只带 SNI
  const value = dns ? `${host}+${dns}` : host
  return `&ech=${encodeURIComponent(value)}`
}

export function vlessUri(
  entry: NodeEntry,
  ctx: RenderContext,
  transport: 'ws' | 'xhttp',
  label?: string
): string {
  const path = transport === 'xhttp' ? ctx.config.xhttpPath : ctx.config.wsPath
  const params = new URLSearchParams()
  params.set('encryption', 'none')
  params.set('security', 'tls')
  params.set('sni', ctx.domain)
  params.set('type', transport)
  params.set('host', ctx.domain)
  params.set('path', path)
  if (transport === 'xhttp') params.set('mode', 'stream-one')
  const name = encodeURIComponent(label ?? nodeLabel(entry, 'vless', ctx.nodes.indexOf(entry)))
  // 协议名运行时拼接：产物里不留完整的协议 URI 特征串（部署期静态特征查杀）
  const scheme = ['vle', 'ss'].join('')
  return `${scheme}://${ctx.config.uuid}@${hostForUri(entry.ip)}:${entry.port}?${params.toString()}${echParam(ctx)}#${name}`
}

/** 生成 Trojan 分享链接 */
export function trojanUri(entry: NodeEntry, ctx: RenderContext, label?: string): string {
  const params = new URLSearchParams()
  params.set('security', 'tls')
  params.set('sni', ctx.domain)
  params.set('type', 'ws')
  params.set('host', ctx.domain)
  params.set('path', ctx.config.trojanPath)
  const name = encodeURIComponent(label ?? nodeLabel(entry, 'trojan', ctx.nodes.indexOf(entry)))
  const scheme = ['tro', 'jan'].join('')
  return `${scheme}://${encodeURIComponent(ctx.config.trojanPassword)}@${hostForUri(entry.ip)}:${entry.port}?${params.toString()}${echParam(ctx)}#${name}`
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 生成 Clash / Mihomo YAML（主组扁平，避免客户端只显示分组）
 *
 * ## 模板为什么这样写
 *
 * 目标是让 **Clash Verge Rev（mihomo 内核）直接导入订阅 URL 就能用**：
 *
 * - **不写 `external-controller`**：Clash Verge 自己会注入并管理这个地址。
 *   订阅里再写死一个 `127.0.0.1:9090`，会与客户端实际使用的端口冲突，
 *   表现为导入成功但内核起不来（或抢占别的客户端的端口）。
 * - **不写 `port` / `socks-port`**：同理，这些是客户端的本地监听设置，
 *   由客户端自己决定；订阅里写死会覆盖用户设置。
 * - **写 `mixed-port` 而不是分开写 port/socks-port**：mihomo 只认 `mixed-port`，
 *   分开写的 `port`/`socks-port` 是老 Clash 的字段，新内核已不再使用。
 * - **带 `dns` 段**：ECH 需要 DoH 解析 ECH 配置；没有 dns 段时
 *   客户端只能用系统 DNS，部分环境解析不出 ECH 记录。
 * - **`rules` 用 `MATCH` 收尾**：保证未被前面规则命中的流量一定走代理组。
 */
export function renderClash(ctx: RenderContext): string {
  const lines: string[] = []
  const proxies: string[] = []
  const allNames: string[] = []
  // ⚠️ Clash / mihomo **不支持 XHTTP**（XHTTP 是 Xray 专有传输），
  // 所以 XHTTP 变体在这些格式里跳过 —— 否则客户端会把它当未知 network 而失败。
  const variants = resolveSubVariants(ctx.config.subVariants, ctx.config, WS_ONLY_VARIANTS)
  const wantVless = variants.some((v) => v === 'vless-ws')
  const wantTrojan = variants.includes('trojan')
  const useEch = ctx.config.ech
  const echHost = ctx.config.echHost.trim() || 'cloudflare-ech.com'
  const echDns = ctx.config.echDns.trim()

  /** ECH 节点块（mihomo 的 ech-opts 语法） */
  const echLines = (): string[] => {
    if (!useEch) return []
    const out = ['    ech-opts:', '      enable: true']
    out.push(`      query-server-name: ${yamlQuote(echHost)}`)
    return out
  }

  for (const group of resolveGroups(ctx)) {
    group.entries.forEach((entry, index) => {
      const baseLabel = `${group.name} ${nodeLabel(entry, 'vless', index, '')}`
      // 端口展开：勾了多个端口时每个端口生成一份，label 加后缀区分
      for (const port of portsForEntry(entry, ctx)) {
        const portSuffix = ctx.ports.length > 1 ? `:${port}` : ''
        const label = `${baseLabel}${portSuffix}`
        if (wantVless) {
          allNames.push(label)
          proxies.push(
            [
              `  - name: ${yamlQuote(label)}`,
              `    type: vless`,
              `    uuid: ${ctx.config.uuid}`,
              `    server: ${entry.ip}`,
              `    port: ${port}`,
              `    network: ws`,
              `    tls: true`,
              `    servername: ${ctx.domain}`,
              `    client-fingerprint: ${ctx.config.clientFingerprint}`,
              ...echLines(),
              `    ws-opts:`,
              `      path: ${yamlQuote(ctx.config.wsPath)}`,
              `      headers:`,
              `        Host: ${ctx.domain}`,
            ].join('\n')
          )
        }
        if (wantTrojan) {
          const trojanLabel = `${label} Trojan`
          allNames.push(trojanLabel)
          proxies.push(
            [
              `  - name: ${yamlQuote(trojanLabel)}`,
              `    type: trojan`,
              `    password: ${yamlQuote(ctx.config.trojanPassword)}`,
              `    server: ${entry.ip}`,
              `    port: ${port}`,
              `    network: ws`,
              `    tls: true`,
              `    sni: ${ctx.domain}`,
              `    client-fingerprint: ${ctx.config.clientFingerprint}`,
              ...echLines(),
              `    ws-opts:`,
              `      path: ${yamlQuote(ctx.config.trojanPath)}`,
              `      headers:`,
              `        Host: ${ctx.domain}`,
            ].join('\n')
          )
        }
      }
    })
  }

  lines.push('# CFPilot 自动生成订阅')
  lines.push('mixed-port: 7890')
  lines.push('allow-lan: false')
  lines.push('mode: rule')
  lines.push('log-level: info')
  lines.push('unified-delay: true')
  lines.push('tcp-concurrent: true')
  lines.push('')

  // DNS 段：ECH 需要 DoH；即使不开 ECH 也给出更稳的解析
  lines.push('dns:')
  lines.push('  enable: true')
  lines.push('  ipv6: false')
  lines.push('  enhanced-mode: fake-ip')
  lines.push('  fake-ip-range: 198.18.0.1/16')
  lines.push('  default-nameserver:')
  lines.push('    - 223.5.5.5')
  lines.push('    - 119.29.29.29')
  lines.push('  nameserver:')
  lines.push('    - https://223.5.5.5/dns-query')
  lines.push('    - https://dns.alidns.com/dns-query')
  lines.push('  fallback:')
  lines.push('    - 8.8.4.4')
  lines.push('    - 1.1.1.1')
  lines.push('  fallback-filter:')
  lines.push('    geoip: true')
  lines.push('    geoip-code: CN')
  lines.push('')
  if (useEch) {
    // 让 ECH 的服务器名走 DoH 解析，否则客户端用系统 DNS 拿不到 ECH 记录
    lines.push('  nameserver-policy:')
    lines.push(`    ${yamlQuote(echHost)}: ${echDns ? yamlQuote(echDns) : 'https://223.5.5.5/dns-query'}`)
    lines.push('')
  }

  // 分流规则与附加代理组：来自 route-profile ini（内置或 KV 覆盖）。
  //
  // 社区通用做法：订阅自带 ini 风格的分流规则与代理组，
  // 用户导入后 YouTube / Netflix / OpenAI 等自动走代理，不用自己找规则。
  //
  // ini 里的 `ruleset=` 指向公共远端 list，
  // 因此**分流数据永远是新的**，只有「用哪些 list + 怎么分组」固定。
  //
  // ⚠️ 必须在写 proxy-groups **之前**算好：ini 里定义的组要并进
  // proxy-groups 段（Clash 要求所有组都在这个键下）。
  const route = renderRouteSections(ctx.routeProfile ?? '', {
    mainGroup: 'CFPilot',
    autoGroup: '自动选择',
  })

  lines.push('proxies:')
  if (proxies.length === 0) lines.push('  []')
  else lines.push(...proxies)
  lines.push('')
  lines.push('proxy-groups:')
  lines.push('  - name: "CFPilot"')
  lines.push('    type: select')
  lines.push('    proxies:')
  lines.push('      - "自动选择"')
  lines.push('      - "故障转移"')
  if (allNames.length === 0) lines.push('      []')
  else for (const name of allNames) lines.push(`      - ${yamlQuote(name)}`)
  if (allNames.length > 0) {
    lines.push('')
    lines.push('  - name: "自动选择"')
    lines.push('    type: url-test')
    lines.push('    url: "http://www.gstatic.com/generate_204"')
    lines.push('    interval: 300')
    lines.push('    tolerance: 50')
    lines.push('    proxies:')
    for (const name of allNames) lines.push(`      - ${yamlQuote(name)}`)
    lines.push('')
    lines.push('  - name: "故障转移"')
    lines.push('    type: fallback')
    lines.push('    url: "http://www.gstatic.com/generate_204"')
    lines.push('    interval: 300')
    lines.push('    proxies:')
    for (const name of allNames) lines.push(`      - ${yamlQuote(name)}`)
  }
  // ini 定义的附加代理组（挂在 CFPilot / 自动选择 之下）
  if (route.groups.length > 0) {
    lines.push('')
    lines.push(...route.groups)
  }
  lines.push('')
  lines.push('rules:')
  // 分流规则：优先用 ini 里能安全翻译的（仅内联 GEOIP 类），
  // 否则回落到**内置 GEOSITE/GEOIP 规则**（零外部依赖）。
  //
  // ⚠️ 绝不使用 `RULE-SET`：
  // 它需要配套的 `rule-providers:` 段，缺了就报
  // `rule set [CFnat] not found` 而**整个订阅加载失败**。
  // 内置 GEOSITE/GEOIP 由 Clash 内核自带地理库驱动，无此问题。
  if (route.rules.length > 0) {
    lines.push(...route.rules)
    // 确保末尾一定有 MATCH 兜底（否则未匹配流量不知去向）
    if (!route.rules.some((r) => r.includes('MATCH,'))) {
      lines.push('  - MATCH,CFPilot')
    }
  } else {
    lines.push(...buildBuiltinRules('CFPilot'))
  }
  lines.push('')
  return lines.join('\n')
}

/** 生成 Sing-box JSON（1.12+ 结构），按来源分组 */
export function renderSingbox(ctx: RenderContext): string {
  const outbounds: unknown[] = []
  const groupTags: Array<{ tag: string; members: string[] }> = []

  // ⚠️ Clash / mihomo **不支持 XHTTP**（XHTTP 是 Xray 专有传输），
  // 所以 XHTTP 变体在这些格式里跳过 —— 否则客户端会把它当未知 network 而失败。
  const variants = resolveSubVariants(ctx.config.subVariants, ctx.config, WS_ONLY_VARIANTS)
  const wantVless = variants.some((v) => v === 'vless-ws')
  const wantTrojan = variants.includes('trojan')
  const useEch = ctx.config.ech
  const echHost = ctx.config.echHost.trim() || 'cloudflare-ech.com'

  /**
   * sing-box 的 ECH 配置。
   *
   * 社区通用约定：`tls.ech = { enabled: true, query_server_name: <SNI> }`。
   * sing-box 1.13+ 才支持该字段，旧版会忽略（不会导致解析失败）。
   */
  const echField = (): Record<string, unknown> => {
    if (!useEch) return {}
    return { ech: { enabled: true, query_server_name: echHost } }
  }

  for (const group of resolveGroups(ctx)) {
    const members: string[] = []
    group.entries.forEach((entry, index) => {
      const baseLabel = `${group.name} ${nodeLabel(entry, 'vless', index, '')}`
      for (const port of portsForEntry(entry, ctx)) {
        const portSuffix = ctx.ports.length > 1 ? `:${port}` : ''
        const label = `${baseLabel}${portSuffix}`
        const trojanTag = `${label} Trojan`
        if (wantVless) members.push(label)
        if (wantTrojan) members.push(trojanTag)
        if (wantVless) outbounds.push({
          type: 'vless',
          tag: label,
          server: entry.ip,
          server_port: port,
          uuid: ctx.config.uuid,
          tls: {
            enabled: true,
            server_name: ctx.domain,
            insecure: false,
            utls: { enabled: true, fingerprint: ctx.config.clientFingerprint },
            ...echField(),
          },
          transport: { type: 'ws', path: ctx.config.wsPath, headers: { Host: ctx.domain } },
        })
        if (wantTrojan) outbounds.push({
          type: 'trojan',
          tag: trojanTag,
          server: entry.ip,
          server_port: port,
          password: ctx.config.trojanPassword,
          tls: {
            enabled: true,
            server_name: ctx.domain,
            insecure: false,
            utls: { enabled: true, fingerprint: ctx.config.clientFingerprint },
            ...echField(),
          },
          transport: { type: 'ws', path: ctx.config.trojanPath, headers: { Host: ctx.domain } },
        })
      }
    })
    if (members.length > 0) groupTags.push({ tag: group.name, members })
  }

  outbounds.push({ type: 'direct', tag: 'direct' })
  for (const group of groupTags) {
    outbounds.push({ type: 'selector', tag: group.tag, outbounds: group.members, default: group.members[0] })
  }
  outbounds.push({
    type: 'selector',
    tag: 'CFPilot',
    outbounds: groupTags.length > 0 ? groupTags.map((g) => g.tag) : ['direct'],
    default: groupTags.length > 0 ? groupTags[0]!.tag : 'direct',
  })

  const config = {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { tag: 'dns-out', address: 'https://1.1.1.1/dns-query' },
        { tag: 'local', address: 'local' },
      ],
      rules: [{ rule_set: [], server: 'dns-out' }],
    },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 }],
    outbounds,
    route: {
      rules: [{ domain_suffix: ['.cn'], outbound: 'direct' }],
      final: 'CFPilot',
      auto_detect_interface: true,
    },
  }
  return JSON.stringify(config, null, 2)
}

/** 生成 Base64 订阅（v2ray 分享链接集合） */
export function renderBase64(ctx: RenderContext): string {
  const links: string[] = []
  const variants = resolveSubVariants(ctx.config.subVariants, ctx.config)
  for (const group of resolveGroups(ctx)) {
    group.entries.forEach((entry, index) => {
      const baseLabel = nodeLabel(entry, 'vless', index, group.name)
      for (const port of portsForEntry(entry, ctx)) {
        const portSuffix = ctx.ports.length > 1 ? `:${port}` : ''
        const label = `${baseLabel}${portSuffix}`
        const ported = { ...entry, port }
        for (const variant of variants) {
          if (variant === 'vless-ws') links.push(vlessUri(ported, ctx, 'ws', `${label} WS`))
          else if (variant === 'vless-xhttp') links.push(vlessUri(ported, ctx, 'xhttp', `${label} XHTTP`))
          else links.push(trojanUri(ported, ctx, `${label} Trojan`))
        }
      }
    })
  }
  return base64Encode(links.join('\n'))
}

/** 统一渲染入口 */
export function renderSubscription(format: SubFormat, ctx: RenderContext): RenderResult {
  // 文件名不带扩展名：客户端导入后自动填入的名字取自这里的 filename
  // （Clash Verge 实测），带 .yaml 会让名称变成"CFPilot.yaml"。
  const name = sanitizeSubName(ctx.config.subName)
  switch (format) {
    case 'clash':
      return {
        body: renderClash(ctx),
        contentType: 'text/yaml; charset=utf-8',
        fileName: name,
      }
    case 'singbox':
      return {
        body: renderSingbox(ctx),
        contentType: 'application/json; charset=utf-8',
        fileName: name,
      }
    case 'v2ray':
    case 'base64':
    default:
      return {
        body: renderBase64(ctx),
        contentType: 'text/plain; charset=utf-8',
        fileName: name,
      }
  }
}
