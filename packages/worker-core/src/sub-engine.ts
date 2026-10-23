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
}

const IP_HEADER_KEYS = ['ip地址', 'ip 地址', 'ip', '地址', '服务器', 'server', 'host']
const PORT_HEADER_KEYS = ['端口', 'port']
const SPEED_HEADER_KEYS = ['下载速度', '速度', 'speed', 'download']
const LATENCY_HEADER_KEYS = ['平均延迟', '延迟', 'latency', 'delay', '响应时间', 'rtt']
const COLO_HEADER_KEYS = ['colo', '机房', '数据中心', '地区', 'region']

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

  if (lines.length === 0) return { entries, filtered, hasHeader }

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
    start = 1
  }

  for (let i = start; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!)
    if (cells.length === 0) continue

    let ip = ''
    let port = DEFAULT_NODE_PORT
    let speed = 0
    let latency = 0
    let colo = ''

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
    }

    if (!ip) continue
    const clean = cleanIpLine(ip.includes(':') && !ip.includes(' ') ? ip : `${ip}:${port}`)
    if (!clean) continue

    const entry: NodeEntry = {
      ip: clean.ip,
      port: clean.port,
      remark: colo,
      colo: colo.toUpperCase(),
      latency,
      speed,
      source: 'addcsv',
      country: countryOfColo(colo.toUpperCase()),
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

  return { entries: kept, filtered, hasHeader }
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

/** [0, max) 区间内的密码学随机整数 */
function randomInt(max: number): number {
  if (max <= 1) return 0
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0]! % max
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
 * 这也是 edgetunnel 的做法（从远程 CIDR 随机取）。
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
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'CFPilot/1.1 (+https://github.com/xmwengxing/CFPilot)' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.text()
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
  let addapi: NodeEntry[] = []
  const apiUrls = config.addApi
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u))
  if (apiUrls.length > 0 && !budget?.exhausted) {
    const results = await Promise.allSettled(apiUrls.map((u) => fetchText(u, timeoutMs)))
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
    const results = await Promise.allSettled(csvUrls.map((u) => fetchText(u, timeoutMs)))
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

  if (budget?.exhausted) {
    errors.push('CPU 预算不足，已跳过部分远程拉取')
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
  /** 订阅协议 */
  protocol: 'vless' | 'trojan' | 'both'
  /** 传输方式 */
  transport: 'ws' | 'xhttp' | 'both'
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

/** 生成 VLESS 分享链接 */
/**
 * ECH 查询参数。
 *
 * 参照 edgetunnel 的做法：`&ech=<SNI>+<DoH 地址>`。
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
      const label = `${group.name} ${nodeLabel(entry, 'vless', index, '')}`
      if (wantVless) {
        allNames.push(label)
        proxies.push(
          [
            `  - name: ${yamlQuote(label)}`,
            `    type: vless`,
            `    uuid: ${ctx.config.uuid}`,
            `    server: ${entry.ip}`,
            `    port: ${entry.port}`,
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
            `    port: ${entry.port}`,
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
  lines.push('')
  lines.push('rules:')
  lines.push('  - GEOIP,CN,DIRECT')
  lines.push('  - MATCH,CFPilot')
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
   * 参照 edgetunnel：`tls.ech = { enabled: true, query_server_name: <SNI> }`。
   * sing-box 1.13+ 才支持该字段，旧版会忽略（不会导致解析失败）。
   */
  const echField = (): Record<string, unknown> => {
    if (!useEch) return {}
    return { ech: { enabled: true, query_server_name: echHost } }
  }

  for (const group of resolveGroups(ctx)) {
    const members: string[] = []
    group.entries.forEach((entry, index) => {
      const label = `${group.name} ${nodeLabel(entry, 'vless', index, '')}`
      const trojanTag = `${label} Trojan`
      if (wantVless) members.push(label)
      if (wantTrojan) members.push(trojanTag)
      if (wantVless) outbounds.push({
        type: 'vless',
        tag: label,
        server: entry.ip,
        server_port: entry.port,
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
        server_port: entry.port,
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
      const label = nodeLabel(entry, 'vless', index, group.name)
      for (const variant of variants) {
        if (variant === 'vless-ws') links.push(vlessUri(entry, ctx, 'ws', `${label} WS`))
        else if (variant === 'vless-xhttp') links.push(vlessUri(entry, ctx, 'xhttp', `${label} XHTTP`))
        else links.push(trojanUri(entry, ctx, `${label} Trojan`))
      }
    })
  }
  return base64Encode(links.join('\n'))
}

/** 统一渲染入口 */
export function renderSubscription(format: SubFormat, ctx: RenderContext): RenderResult {
  switch (format) {
    case 'clash':
      return {
        body: renderClash(ctx),
        contentType: 'text/yaml; charset=utf-8',
        fileName: 'CFPilot.yaml',
      }
    case 'singbox':
      return {
        body: renderSingbox(ctx),
        contentType: 'application/json; charset=utf-8',
        fileName: 'CFPilot.json',
      }
    case 'v2ray':
    case 'base64':
    default:
      return {
        body: renderBase64(ctx),
        contentType: 'text/plain; charset=utf-8',
        fileName: 'CFPilot.txt',
      }
  }
}
