/**
 * 外部清单内容归一：TXT / CSV / 简单 JSON → 带端口的 IP / 域名候选。
 *
 * ## 铁律 6：清洗集中在既有实现
 *
 * 文本形态（TXT/CSV）一律先过 `readIpFile(text)` —— 它已经处理了
 * 「哪一列是 IP」「表头跳过」「剥 #备注」「IPv6 方括号」等一堆坑。
 * 本模块只补 `readIpFile` 刻意丢掉的两样东西：**JSON 支持**与**端口保留**。
 * 不在别处另写一套逐行解析器。
 *
 * IP 合法性 / CF 段判定同样不在这里做：`upsertCandidates` 是唯一裁判，
 * 它会统一计入 `reasons.invalidIp` / `reasons.notCloudflare`。
 */
import { readIpFile } from '../scan/ip-ranges'
import type { CandidateInput } from './pool'

export interface ParsedCandidate {
  ip: string
  port: number | null
}

const IPV4 = '\\d{1,3}(?:\\.\\d{1,3}){3}'
const IPV6 = '[0-9a-fA-F:.]+'
/** 域名：至少两段 label，label 以字母数字开头结尾（中间允许连字符） */
const DOMAIN = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+'
/** `1.2.3.4:8443` / `[2606:4700::1]:8443` / `example.com:8443`，端口一律是最后一个捕获组 */
const HOST_PORT = new RegExp(`(?:\\[(${IPV6})\\]:|(${IPV4}):|(${DOMAIN}):)(\\d{1,5})`)

/** JSON 清单里常见的「IP 字段」别名。 */
const IP_KEYS = ['ip', 'address', 'addr', 'host', 'target', 'value'] as const
/** JSON 清单里常见的「列表字段」别名。 */
const LIST_KEYS = ['ips', 'data', 'list', 'candidates', 'result', 'items', 'records'] as const

function objString(v: unknown, keys: readonly string[]): string | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  for (const k of keys) {
    if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim()
  }
  return null
}

function objPort(v: unknown): number | null {
  if (!v || typeof v !== 'object') return null
  const raw = (v as Record<string, unknown>).port
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 65535) return raw
  if (typeof raw === 'string' && /^\d{1,5}$/.test(raw)) {
    const n = Number(raw)
    if (n >= 1 && n <= 65535) return n
  }
  return null
}

/** 把「带端口的 token」拆成 host + port；纯 host 返回 port=null。 */
function splitHostPort(token: string): ParsedCandidate | null {
  let t = token.trim()
  const hash = t.indexOf('#')
  if (hash >= 0) t = t.slice(0, hash).trim()
  if (!t) return null
  if (t.startsWith('[')) {
    const end = t.indexOf(']')
    if (end < 0) return null
    const host = t.slice(1, end)
    const rest = t.slice(end + 1)
    const port = /^:\d{1,5}$/.test(rest) ? Number(rest.slice(1)) : null
    return { ip: host, port: port && port >= 1 && port <= 65535 ? port : null }
  }
  const m = new RegExp(`^(${IPV4}):(\\d{1,5})$`).exec(t)
  if (m) {
    const port = Number(m[2])
    return { ip: m[1]!, port: port >= 1 && port <= 65535 ? port : null }
  }
  return { ip: t, port: null }
}

/** 从原始文本里收集「host → port」映射（IP 与域名都认），只用于补回 readIpFile 丢掉的端口。 */
function collectPorts(text: string): Map<string, number> {
  const ports = new Map<string, number>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    // 显式 `host:port`（IPv4 / `[IPv6]` / 域名）
    for (const m of line.matchAll(new RegExp(HOST_PORT, 'g'))) {
      const host = m[1] ?? m[2] ?? m[3]
      const port = Number(m[4])
      if (host && port >= 1 && port <= 65535 && !ports.has(host)) ports.set(host, port)
    }
    // CSV 的 `IP,port` 形态（IP 列后面紧跟纯数字端口列）
    if (line.includes(',')) {
      const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, '').replace(/#.*$/, '').trim())
      for (let i = 0; i < cols.length - 1; i++) {
        const host = cols[i]!
        if (!new RegExp(`^(?:${IPV4}|\\[${IPV6}\\])$`).test(host)) continue
        if (!/^\d{1,5}$/.test(cols[i + 1]!)) continue
        const port = Number(cols[i + 1])
        const clean = host.startsWith('[') ? host.slice(1, -1) : host
        if (port >= 1 && port <= 65535 && !ports.has(clean)) ports.set(clean, port)
      }
    }
  }
  return ports
}

function parseJson(text: string): ParsedCandidate[] | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  let list: unknown = data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const k of LIST_KEYS) {
      const v = (data as Record<string, unknown>)[k]
      if (Array.isArray(v)) {
        list = v
        break
      }
    }
  }
  if (!Array.isArray(list)) return null

  const out: ParsedCandidate[] = []
  for (const item of list) {
    if (typeof item === 'string') {
      const parsed = splitHostPort(item)
      if (parsed) out.push(parsed)
      continue
    }
    const host = objString(item, IP_KEYS)
    if (!host) continue
    // 对象里的 host 也可能自带 `:port`
    const parsed = splitHostPort(host)
    if (!parsed) continue
    out.push({ ip: parsed.ip, port: objPort(item) ?? parsed.port })
  }
  return out
}

/**
 * 解析外部清单正文。
 *
 * 优先按 JSON 试；不是 JSON 就走 `readIpFile` 的文本清洗，再用
 * `collectPorts` 把原文里的 `:port` / CSV 端口列补回去（缺省 443）。
 */
export function parseSourcePayload(text: string): ParsedCandidate[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const json = parseJson(trimmed)
    if (json !== null) return json
  }
  const hosts = readIpFile(text)
  const ports = collectPorts(text)
  return hosts.map((ip) => ({ ip, port: ports.get(ip) ?? null }))
}

/** 转成池层输入。`source` 用数据源 id，合法性统一由 upsertCandidates 判定。 */
export function toCandidateInputs(
  parsed: readonly ParsedCandidate[],
  sourceId: string
): CandidateInput[] {
  return parsed.map((p) => ({
    ip: p.ip,
    ...(p.port === null ? {} : { port: p.port }),
    source: sourceId,
  }))
}
