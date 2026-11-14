/**
 * 目标域名 → 固定落地 IP 映射。
 *
 * ## 为什么需要
 *
 * 有些站点的权威 DNS 会把流量分散到多家 CDN：同一域名在不同解析来源下
 * 返回完全不同的落地 IP，而不同落地节点对出口的待遇也不同 —— 有的稳定
 * 放行，有的直接拒绝。Worker 侧把域名交给运行时解析、或逐家 DoH 取第一个
 * 应答，都会让「这次连到哪一类节点」随 DNS 轮询漂移，表现为同一页面
 * 刷新时好时坏。
 *
 * 固定映射让用户为指定域名写明落地 IP，出站不再解析该域名，只连这些
 * 明确给出的地址 —— 落点确定，出口稳定。
 *
 * ## 格式
 *
 * 每行一条 `域名=IP[:端口]`，`=` 右侧可逗号分隔多个 IP；`#` 开头为注释。
 * 只接受 IPv4 字面量：这里要的是「直接建连的地址」，不再引入域名解析
 * （否则又回到漂移问题）。端口省略时用目标端口，由调用方补。
 *
 * ## 反代入口形态（`r:` 前缀）
 *
 * 值以 `r:` 开头（`域名=r:IP[:端口]`）表示**该域名必须经指定反代入口**
 * 按 SNI 转发 —— 用于「目标本身在 Cloudflare 网段，直连任何落地 IP 都会被
 * TCP Loop 拒绝」的场景（如 cloudflare.com）：无法用固定落地 IP，但可以固定
 * 反代入口，跳过反代池的粘性哈希，每次都走实测最快的那个入口。
 *
 * 例：
 *   example.com=203.0.113.10
 *   another.example=203.0.113.11:443,203.0.113.12
 *   cloudflare.com=r:198.51.100.7
 */
export interface PinnedEntry {
  host: string
  endpoints: Array<{ ip: string; port?: number }>
  /** true = 反代入口条目（`r:` 前缀），按 SNI 转发；false = 直连落地 IP */
  relay: boolean
}

/** 值里的反代入口前缀：`r:IP[:端口]` = 经指定反代入口按 SNI 转发 */
export const PINNED_RELAY_PREFIX = 'r:'


/** 严格 IPv4 字面量（不含端口、不含方括号） */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isIpv4(value: string): boolean {
  const m = IPV4.exec(value)
  if (!m) return false
  return m.slice(1).every((part) => Number(part) <= 255 && String(Number(part)) === part)
}

/** 合法主机名（域名或 `*.` 通配前缀） */
const HOST = /^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

/** 单条映射最多几个落地 IP，避免误粘一大段把出站额度占满 */
const MAX_IPS_PER_HOST = 8
/** 最多几条映射 */
const MAX_ENTRIES = 64

/**
 * 解析配置文本。看不懂的行**跳过**（不抛异常）—— 面板写入前会先过
 * `validateConfigPatch`，这里只负责运行期容错。
 */
export function parsePinnedHosts(text: string): PinnedEntry[] {
  const out: PinnedEntry[] = []
  const byHost = new Map<string, PinnedEntry>()
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const host = line.slice(0, eq).trim().toLowerCase()
    if (!HOST.test(host)) continue
    // 同一 host 的两类条目（直连 / 反代入口）分池存放 —— 语义互斥：
    // 直连落地 IP 与反代入口不能混在一起，否则选路无法判定走哪条。
    const endpoints: Array<{ ip: string; port?: number }> = []
    let relay = false
    for (const piece of line.slice(eq + 1).split(',')) {
      const item = piece.trim()
      if (!item) continue
      // `r:` 前缀 = 反代入口条目；一行内可以混写吗？不能 —— 见下方一致性检查。
      const isRelayPiece = item.toLowerCase().startsWith(PINNED_RELAY_PREFIX)
      const bare = isRelayPiece ? item.slice(PINNED_RELAY_PREFIX.length).trim() : item
      if (bare.startsWith(PINNED_RELAY_PREFIX)) continue
      const colon = bare.lastIndexOf(':')
      let ip = bare
      let port: number | undefined
      if (colon > 0 && /^\d{1,5}$/.test(bare.slice(colon + 1))) {
        ip = bare.slice(0, colon).trim()
        const n = Number(bare.slice(colon + 1))
        if (n > 0 && n <= 65535) port = n
        else continue
      }
      if (!isIpv4(ip)) continue
      // 一行混写两类（首个条目已定 relay 类）→ 后续不同类的直接丢弃：
      // 宁可少用一条也不要把「直连落地」误当「反代入口」（或反过来）。
      if (endpoints.length > 0 && isRelayPiece !== relay) continue
      relay = isRelayPiece
      endpoints.push({ ip, port })
      if (endpoints.length >= MAX_IPS_PER_HOST) break
    }
    if (endpoints.length === 0) continue
    const entryKey = relay ? `relay:${host}` : host
    let entry = byHost.get(entryKey)
    if (!entry) {
      if (out.length >= MAX_ENTRIES) break
      entry = { host, endpoints: [], relay }
      byHost.set(entryKey, entry)
      out.push(entry)
    }
    for (const ep of endpoints) {
      if (entry.endpoints.length >= MAX_IPS_PER_HOST) break
      if (entry.endpoints.some((e) => e.ip === ep.ip && e.port === ep.port)) continue
      entry.endpoints.push(ep)
    }
  }
  return out
}

/**
 * 取某个目标域名的固定落地 IP（**直连条目**，不含反代入口条目）。
 *
 * 精确匹配优先；其次 `*.suffix` 通配（取最长匹配，保证 `*.example.com`
 * 不会盖掉用户为 `a.example.com` 单独写的精确条目）。
 */
function pickPinned(
  text: string,
  hostname: string,
  wantRelay: boolean
): PinnedEntry | undefined {
  const host = String(hostname ?? '').trim().toLowerCase()
  if (!host) return undefined
  const entries = parsePinnedHosts(text)
  let picked: PinnedEntry | undefined
  let wildcard: PinnedEntry | undefined
  let wildcardLen = -1
  for (const entry of entries) {
    if (entry.relay !== wantRelay) continue
    if (entry.host === host) {
      picked = entry
      break
    }
    if (entry.host.startsWith('*.')) {
      const suffix = entry.host.slice(1) // ".example.com"
      if (host.endsWith(suffix) && suffix.length > wildcardLen) {
        wildcard = entry
        wildcardLen = suffix.length
      }
    }
  }
  return picked ?? wildcard
}

/** 取某个目标域名的固定**直连落地 IP**（`域名=IP` 条目）。 */
export function pinnedIpsFor(
  text: string,
  hostname: string,
  defaultPort: number
): Array<{ ip: string; port: number }> {
  const chosen = pickPinned(text, hostname, false)
  if (!chosen) return []
  return chosen.endpoints.map((e) => ({ ip: e.ip, port: e.port ?? defaultPort }))
}

/**
 * 取某个目标域名的固定**反代入口**（`域名=r:IP` 条目）。
 *
 * 命中后该域名不走 DoH、不走反代池粘性哈希，直接由 dial 层把流量
 * 送到这里的入口按 SNI 转发 —— 用于目标本身在 Cloudflare 网段、
 * 只能靠反代打通且需要固定入口的场景（如 cloudflare.com）。
 */
export function pinnedRelaysFor(
  text: string,
  hostname: string,
  defaultPort: number
): Array<{ ip: string; port: number }> {
  const chosen = pickPinned(text, hostname, true)
  if (!chosen) return []
  return chosen.endpoints.map((e) => ({ ip: e.ip, port: e.port ?? defaultPort }))
}

/** 面板校验：返回非法行号（1 起），空数组表示全部合法。判据与解析层同源。 */
export function validatePinnedHosts(text: string): number[] {
  const bad: number[] = []
  String(text ?? '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    if (parsePinnedHosts(line).length === 0) bad.push(index + 1)
  })
  return bad
}
