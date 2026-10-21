/**
 * 优选订阅引擎
 *
 * 四层优先级合并池：
 *   L1 LOCAL_IPS   本地真连接优选池（cfpilot-scanner 实测并通过 WS 101 握手校验）
 *   L2 ADD         手动自定义池
 *   L3 ADDAPI      远程动态 API 池（TXT）
 *   L4 ADDCSV      远程 CSV 测速筛选池（按 DLS / MAX_LATENCY 过滤）
 *
 * 输出格式：Base64（v2ray 分享链接）、Clash/Mihomo YAML、Sing-box JSON。
 */
import type { NodeEntry, SubFormat, UserConfig } from './types'
import { isIpv4, isIpv6 } from './protocols/address'
import { base64Encode } from './util'
import { CpuBudget } from './budget'

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

function toEntry(clean: CleanResult, source: NodeEntry['source']): NodeEntry {
  const parsed = parseScannerRemark(clean.remark)
  return {
    ip: clean.ip,
    port: clean.port,
    remark: clean.remark,
    colo: parsed.colo,
    latency: parsed.latency,
    speed: parsed.speed,
    source,
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

function looksLikeSpeed(text: string): boolean {
  return /m\/?b|mb\/s|下载|速度|speed/i.test(text)
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
  const hasHeaderKeyword = firstCells.some((c) =>
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
      colo,
      latency,
      speed,
      source: 'addcsv',
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
/* 合并                                                                */
/* ------------------------------------------------------------------ */

export interface PoolResult {
  source: NodeEntry['source']
  entries: NodeEntry[]
}

/** 按优先级合并并去重（同 ip:port 只保留优先级最高的一条） */
export function mergePools(pools: PoolResult[]): NodeEntry[] {
  const seen = new Set<string>()
  const out: NodeEntry[] = []
  for (const pool of pools) {
    for (const entry of pool.entries) {
      const key = `${entry.ip}:${entry.port}`
      if (seen.has(key)) continue
      seen.add(key)
      // 来源层级由所在池决定（比条目自带的 source 更可靠）
      out.push({ ...entry, source: pool.source })
    }
  }
  return out
}

export interface CollectResult {
  nodes: NodeEntry[]
  stats: {
    local: number
    add: number
    addapi: number
    addcsv: number
    filtered: number
    errors: string[]
  }
}

export interface CollectOptions {
  /** 远程请求超时（ms） */
  timeoutMs?: number
  /** CPU 预算，超时提前返回 */
  budget?: CpuBudget
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'CFPilot/1.0 (+https://github.com/xmwengxing/CFPilot)' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.text()
}

/** 收集四层优选池并合并 */
export async function collectNodes(
  config: UserConfig,
  localIpsText: string,
  options: CollectOptions = {}
): Promise<CollectResult> {
  const timeoutMs = options.timeoutMs ?? 6000
  const budget = options.budget
  const errors: string[] = []

  const local = parseLocalList(localIpsText)
  const add = parseAddList(config.add)

  let addapi: NodeEntry[] = []
  const apiUrls = config.addApi
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u))
  if (apiUrls.length > 0) {
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
  if (csvUrls.length > 0) {
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

  const nodes = mergePools([
    { source: 'local', entries: local },
    { source: 'add', entries: add },
    { source: 'addapi', entries: addapi },
    { source: 'addcsv', entries: addcsv },
  ])

  const limited = config.maxNodes > 0 ? nodes.slice(0, config.maxNodes) : nodes

  return {
    nodes: limited,
    stats: {
      local: local.length,
      add: add.length,
      addapi: addapi.length,
      addcsv: addcsv.length,
      filtered,
      errors,
    },
  }
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

export interface RenderContext {
  nodes: NodeEntry[]
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

function nodeLabel(entry: NodeEntry, protocol: string, index: number): string {
  const base = entry.remark && !/^[\d.]+$/.test(entry.remark) ? entry.remark : entry.ip
  const colo = entry.colo && entry.colo !== base ? ` ${entry.colo}` : ''
  return `${base}${colo} #${index + 1}${protocol === 'trojan' ? ' Trojan' : ''}`
}

function hostForUri(ip: string): string {
  return ip.includes(':') ? `[${ip}]` : ip
}

function encodePath(path: string): string {
  return encodeURIComponent(path)
}

/** 生成 VLESS 分享链接 */
export function vlessUri(entry: NodeEntry, ctx: RenderContext, transport: 'ws' | 'xhttp'): string {
  const path = transport === 'xhttp' ? ctx.config.xhttpPath : ctx.config.wsPath
  const params = new URLSearchParams()
  params.set('encryption', 'none')
  params.set('security', 'tls')
  params.set('sni', ctx.domain)
  params.set('type', transport)
  params.set('host', ctx.domain)
  params.set('path', path)
  if (transport === 'xhttp') params.set('mode', 'stream-one')
  const name = encodeURIComponent(nodeLabel(entry, 'vless', ctx.nodes.indexOf(entry)))
  return `vless://${ctx.config.uuid}@${hostForUri(entry.ip)}:${entry.port}?${params.toString()}#${name}`
}

/** 生成 Trojan 分享链接 */
export function trojanUri(entry: NodeEntry, ctx: RenderContext): string {
  const params = new URLSearchParams()
  params.set('security', 'tls')
  params.set('sni', ctx.domain)
  params.set('type', 'ws')
  params.set('host', ctx.domain)
  params.set('path', ctx.config.trojanPath)
  const name = encodeURIComponent(nodeLabel(entry, 'trojan', ctx.nodes.indexOf(entry)))
  return `trojan://${encodeURIComponent(ctx.config.trojanPassword)}@${hostForUri(entry.ip)}:${entry.port}?${params.toString()}#${name}`
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 生成 Clash / Mihomo YAML */
export function renderClash(ctx: RenderContext): string {
  const lines: string[] = []
  const proxies: string[] = []
  const groupNames: string[] = []

  ctx.nodes.forEach((entry, index) => {
    const label = nodeLabel(entry, 'vless', index)
    groupNames.push(label)
    const common = [
      `    server: ${entry.ip}`,
      `    port: ${entry.port}`,
      `    network: ws`,
      `    tls: true`,
      `    servername: ${ctx.domain}`,
      `    client-fingerprint: ${ctx.config.clientFingerprint}`,
      `    ws-opts:`,
      `      path: ${yamlQuote(ctx.config.wsPath)}`,
      `      headers:`,
      `        Host: ${ctx.domain}`,
    ]
    proxies.push(
      [
        `  - name: ${yamlQuote(label)}`,
        `    type: vless`,
        `    uuid: ${ctx.config.uuid}`,
        ...common,
      ].join('\n')
    )
    proxies.push(
      [
        `  - name: ${yamlQuote(`${label} Trojan`)}`,
        `    type: trojan`,
        `    password: ${yamlQuote(ctx.config.trojanPassword)}`,
        `    server: ${entry.ip}`,
        `    port: ${entry.port}`,
        `    network: ws`,
        `    tls: true`,
        `    sni: ${ctx.domain}`,
        `    client-fingerprint: ${ctx.config.clientFingerprint}`,
        `    ws-opts:`,
        `      path: ${yamlQuote(ctx.config.trojanPath)}`,
        `      headers:`,
        `        Host: ${ctx.domain}`,
      ].join('\n')
    )
  })

  lines.push('# CFPilot 自动生成订阅')
  lines.push('port: 7890')
  lines.push('socks-port: 7891')
  lines.push('allow-lan: false')
  lines.push('mode: rule')
  lines.push('log-level: info')
  lines.push('external-controller: 127.0.0.1:9090')
  lines.push('')
  lines.push('proxies:')
  if (proxies.length === 0) {
    lines.push('  []')
  } else {
    lines.push(...proxies)
  }
  lines.push('')
  lines.push('proxy-groups:')
  lines.push('  - name: "CFPilot"')
  lines.push('    type: select')
  if (groupNames.length === 0) {
    lines.push('    proxies: []')
  } else {
    for (const name of groupNames) lines.push(`    - ${yamlQuote(name)}`)
  }
  lines.push('')
  lines.push('rules:')
  lines.push('  - GEOIP,CN,DIRECT')
  lines.push('  - MATCH,CFPilot')
  lines.push('')
  return lines.join('\n')
}

/** 生成 Sing-box JSON（1.12+ 结构） */
export function renderSingbox(ctx: RenderContext): string {
  const outbounds: unknown[] = []

  ctx.nodes.forEach((entry, index) => {
    const label = nodeLabel(entry, 'vless', index)
    outbounds.push({
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
      },
      transport: {
        type: 'ws',
        path: ctx.config.wsPath,
        headers: { Host: ctx.domain },
      },
    })
    outbounds.push({
      type: 'trojan',
      tag: `${label} Trojan`,
      server: entry.ip,
      server_port: entry.port,
      password: ctx.config.trojanPassword,
      tls: {
        enabled: true,
        server_name: ctx.domain,
        insecure: false,
        utls: { enabled: true, fingerprint: ctx.config.clientFingerprint },
      },
      transport: {
        type: 'ws',
        path: ctx.config.trojanPath,
        headers: { Host: ctx.domain },
      },
    })
  })

  outbounds.push({ type: 'direct', tag: 'direct' })

  const firstTag = ctx.nodes.length > 0 ? nodeLabel(ctx.nodes[0]!, 'vless', 0) : 'direct'
  const config = {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: [
        { tag: 'dns-out', address: 'https://1.1.1.1/dns-query' },
        { tag: 'local', address: 'local' },
      ],
      rules: [{ rule_set: [], server: 'dns-out' }],
    },
    inbounds: [
      { type: 'socks', tag: 'socks-in', listen: '127.0.0.1', listen_port: 2080 },
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 },
    ],
    outbounds,
    route: {
      rules: [{ domain_suffix: ['.cn'], outbound: 'direct' }],
      final: firstTag,
      auto_detect_interface: true,
    },
  }
  return JSON.stringify(config, null, 2)
}

/** 生成 Base64 订阅（v2ray 分享链接集合） */
export function renderBase64(ctx: RenderContext): string {
  const links: string[] = []
  ctx.nodes.forEach((entry, index) => {
    if (ctx.protocol === 'vless' || ctx.protocol === 'both') {
      if (ctx.transport === 'ws' || ctx.transport === 'both') {
        links.push(vlessUri(entry, ctx, 'ws'))
      }
      if (ctx.transport === 'xhttp' || ctx.transport === 'both') {
        links.push(vlessUri(entry, ctx, 'xhttp'))
      }
    }
    if (ctx.protocol === 'trojan' || ctx.protocol === 'both') {
      links.push(trojanUri(entry, ctx))
    }
    void index
  })
  return base64Encode(links.join('\n'))
}

/** 统一渲染入口 */
export function renderSubscription(format: SubFormat, ctx: RenderContext): RenderResult {
  switch (format) {
    case 'clash':
      return {
        body: renderClash(ctx),
        contentType: 'text/yaml; charset=utf-8',
        fileName: 'cfpilot-clash.yaml',
      }
    case 'singbox':
      return {
        body: renderSingbox(ctx),
        contentType: 'application/json; charset=utf-8',
        fileName: 'cfpilot-singbox.json',
      }
    case 'v2ray':
    case 'base64':
    default:
      return {
        body: renderBase64(ctx),
        contentType: 'text/plain; charset=utf-8',
        fileName: 'cfpilot-sub.txt',
      }
  }
}
