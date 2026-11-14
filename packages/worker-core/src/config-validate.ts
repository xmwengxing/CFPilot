/**
 * 配置写入前的后端校验
 *
 * ## 为什么必须有
 *
 * 前端校验只负责体验，**真正的安全边界在后端**。之前 `PUT /api/v1/config`
 * 只做 `mergeConfig` 的类型归一（字符串/布尔/数字），任何值都能存进去：
 *
 * - `wsPath` 存成 `abc` → 入站路径永远匹配不上，用户以为是部署坏了；
 * - `officialCount` 存成 100000 → 每次生成订阅都在内存里造十万条节点；
 * - `socks5` 存成一段乱码 → 出站全部失败，但面板显示"已配置"；
 * - `subDomain` 存成带路径的串 → 订阅里的 SNI 直接非法。
 *
 * 这些都不是"用户操作失误"，是**后端没有拒绝**。所以这里逐字段定规则，
 * 非法值一律 400 并指名道姓，而不是静默存下来等运行时炸。
 *
 * ## 设计原则
 *
 * 1. **只校验本次提交的字段**：面板是分页保存的，整份配置校验会把无关字段的
 *    历史脏值也拦下来，用户会莫名其妙存不了；
 * 2. **报错要能直接看懂**：返回中文短句 + 字段名，前端原样弹给用户；
 * 3. **不做业务判断**：只判断"这个值能不能用"，不判断"该不该这么配"。
 */

import { cleanIpLine } from './sub-engine'
import { validatePinnedHosts } from './outbound/pinned'

/** 单字段校验结果 */
export interface FieldError {
  field: string
  message: string
}

/** 主机名（不含协议/路径），允许 IPv4 / IPv6 字面量 */
const HOSTNAME = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isIpv4(text: string): boolean {
  const m = IPV4.exec(text)
  if (!m) return false
  return m.slice(1).every((part) => Number(part) <= 255)
}

/**
 * 手动填写的 IP 列表 —— 语法校验。
 *
 * ## 为什么要有
 *
 * 面板「节点来源 → 手动指定 IP」的输入框是自由文本，语法很简单：
 * `#` 开头是注释，其余每行一条（`IP` / `IP:端口` / `IP:端口#备注` / `[IPv6]:端口`）。
 *
 * 但**解析层是宽容的**（`cleanIpLine` 遇到看不懂的行就跳过），
 * 所以用户填错时**看不到任何提示** —— 只有「保存成功」，
 * 但节点一条都没进订阅。这是最难排查的一类问题：
 * 面板显示已保存，订阅里就是没有。
 *
 * ## 口径
 *
 * **判定权完全在解析层**（`cleanIpLine`）：解析器认得的这里必须放行，
 * 解析器丢掉的这里必须报错。两边判据不一致会出现
 * 「校验说没问题但节点没进去」—— 那比不校验更糟。
 *
 * @returns 空串 = 全部合法；否则是可直接展示给用户的一句话
 */
export function validateIpList(text: string): string {
  const bad: number[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (!line) return
    // 整行注释：解析器会跳过，这里也不该报错
    const body = line.replace(/^["']|["']$/g, '').trim()
    if (!body || body.startsWith('#')) return
    if (cleanIpLine(line) === null) bad.push(index + 1)
  })
  if (bad.length === 0) return ''
  const shown = bad.slice(0, 3).map((n) => `第 ${n} 行`).join('、')
  const rest = bad.length > 3 ? ` 等 ${bad.length} 行` : ''
  return `手动指定 IP 有 ${bad.length} 行无法识别（${shown}${rest}）`
}

/** 代理条目：允许 `scheme://[user:pass@]host[:port]`，也允许裸 `host[:port]` */
const PROXY_LINE = /^(?:(?:socks5|socks|socks5h|http|https):\/\/)?(?:[^\s@/]+@)?(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]+)(?::\d{1,5})?$/

/** 路径：必须以 / 开头，不含空白与控制字符 */
function checkPath(value: string, field: string, errors: FieldError[]): void {
  if (!value) {
    errors.push({ field, message: `${field} 不能为空` })
    return
  }
  if (!value.startsWith('/')) {
    errors.push({ field, message: `${field} 必须以 / 开头` })
    return
  }
  if (value.length > 128) {
    errors.push({ field, message: `${field} 过长（最多 128 字符）` })
    return
  }
  if (/[\s\u0000-\u001f]/.test(value)) {
    errors.push({ field, message: `${field} 不能包含空格或控制字符` })
  }
}

/** 数值区间 */
function checkRange(
  value: number,
  field: string,
  min: number,
  max: number,
  errors: FieldError[]
): void {
  if (!Number.isFinite(value)) {
    errors.push({ field, message: `${field} 必须是数字` })
    return
  }
  if (value < min || value > max) {
    errors.push({ field, message: `${field} 必须在 ${min} ~ ${max} 之间（当前 ${value}）` })
  }
}

/**
 * 代理池与反代入口池的默认上限。
 *
 * 代理类（proxyIp / socks5 / httpProxy）是「用户自配的一小组出口」，
 * 20 条足够；反代入口池是「优选出来的候选」，优选一轮出十几条，
 * 给它单独的额度（见 MAX_RELAY_POOL）。
 */
const MAX_PROXY_POOL = 20

/**
 * 反代入口池的条数上限。
 *
 * 反代入口池会被轮换使用（见 collectRelayEndpoints），
 * 条数多只是多几个备选，不会拖慢出站 —— 但要挡住「误粘几万条」。
 */
const MAX_RELAY_POOL = 200

/** 手动指定 IP 列表的条数上限。 */
const MAX_MANUAL_IPS = 2000

/** 逐行解析的代理池（空行忽略） */
function checkProxyPool(
  value: string,
  field: string,
  errors: FieldError[],
  max = MAX_PROXY_POOL
): void {
  const lines = value.split(/\r?\n|,/).map((l) => l.trim()).filter(Boolean)
  if (lines.length > max) {
    errors.push({ field, message: `${field} 最多 ${max} 条（当前 ${lines.length}）` })
    return
  }
  for (const line of lines) {
    if (!PROXY_LINE.test(line)) {
      errors.push({ field, message: `${field} 里有无法识别的条目：${line.slice(0, 40)}` })
      return
    }
  }
}

/** 远程订阅源：必须是 http(s) URL，最多 10 条 */
function checkRemoteSources(value: string, field: string, errors: FieldError[]): void {
  const items = value.split(/\r?\n|,/).map((l) => l.trim()).filter(Boolean)
  if (items.length > 10) {
    errors.push({ field, message: `${field} 最多 10 条（当前 ${items.length}）` })
    return
  }
  for (const item of items) {
    if (!/^https?:\/\/\S+$/i.test(item)) {
      errors.push({ field, message: `${field} 必须是 http(s) 地址：${item.slice(0, 40)}` })
      return
    }
  }
}

/**
 * 手动指定 IP 列表：逐行校验。
 *
 * 之前完全没有校验 —— 解析层遇到看不懂的行就静默跳过，
 * 用户看到「保存成功」但订阅里一个节点都没进去。
 */
function checkIpList(value: string, field: string, errors: FieldError[]): void {
  const lines = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length > MAX_MANUAL_IPS) {
    // ⚠️ 条数也要限。
    //
    // 手动指定的 IP 会进订阅，而订阅请求每次都要读 + 解析这份配置
    // （配置有 15 秒缓存，超时就要重解析 —— 免费版的 CPU 预算扛不住）。
    // 粘几万条会让**所有**订阅请求都变慢甚至报错，殃及所有人。
    errors.push({ field, message: `${field} 最多 ${MAX_MANUAL_IPS} 条（当前 ${lines.length}）` })
    return
  }
  const message = validateIpList(value)
  if (message) errors.push({ field, message })
}

/**
 * 校验一次配置提交。
 *
 * @param patch 前端提交的**部分**配置（未出现的字段不校验）
 * @returns 错误列表；空数组表示通过
 */
export function validateConfigPatch(patch: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = []
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(patch, key)

  if (has('wsPath')) checkPath(String(patch.wsPath ?? ''), 'wsPath', errors)
  if (has('trojanPath')) checkPath(String(patch.trojanPath ?? ''), 'trojanPath', errors)
  if (has('xhttpPath')) checkPath(String(patch.xhttpPath ?? ''), 'xhttpPath', errors)

  // 三个路径不能相同：相同会导致其中一个入站永远匹配不到
  const paths = ['wsPath', 'trojanPath', 'xhttpPath']
    .filter((k) => has(k))
    .map((k) => `${k}=${String(patch[k] ?? '')}`)
  if (paths.length >= 2) {
    const values = paths.map((p) => p.slice(p.indexOf('=') + 1))
    if (new Set(values).size !== values.length) {
      errors.push({ field: 'paths', message: 'wsPath / trojanPath / xhttpPath 不能重复' })
    }
  }

  if (has('proxyMode')) {
    const mode = String(patch.proxyMode ?? '')
    if (!['only', 'global', 'fallback', 'smart'].includes(mode)) {
      errors.push({ field: 'proxyMode', message: 'proxyMode 值无效' })
    }
  }

  if (has('clientFingerprint')) {
    const fingerprint = String(patch.clientFingerprint ?? '').trim()
    if (fingerprint.length > 32 || !/^[A-Za-z0-9._-]*$/.test(fingerprint)) {
      errors.push({ field: 'clientFingerprint', message: 'clientFingerprint 值无效' })
    }
  }

  if (has('subDomain')) {
    const domain = String(patch.subDomain ?? '').trim()
    // 留空是合法的（表示用请求域名）
    if (domain && (!HOSTNAME.test(domain) || domain.includes('/'))) {
      errors.push({ field: 'subDomain', message: 'subDomain 必须是合法主机名（不含协议与路径）' })
    }
  }

  if (has('proxyIp')) checkProxyPool(String(patch.proxyIp ?? ''), 'proxyIp', errors)
  if (has('socks5')) checkProxyPool(String(patch.socks5 ?? ''), 'socks5', errors)
  if (has('httpProxy')) checkProxyPool(String(patch.httpProxy ?? ''), 'httpProxy', errors)
  if (has('relayPool')) {
    checkProxyPool(String(patch.relayPool ?? ''), 'relayPool', errors, MAX_RELAY_POOL)
  }
  if (has('pinnedHosts')) {
    const bad = validatePinnedHosts(String(patch.pinnedHosts ?? ''))
    if (bad.length > 0) {
      errors.push({
        field: 'pinnedHosts',
        message: `固定落地 IP 第 ${bad.slice(0, 3).join('、')} 行无效`,
      })
    }
  }

  if (has('officialCount')) {
    checkRange(Number(patch.officialCount), 'officialCount', 1, 200, errors)
  }
  if (has('domainCount')) checkRange(Number(patch.domainCount), 'domainCount', 1, 200, errors)
  if (has('maxNodes')) checkRange(Number(patch.maxNodes), 'maxNodes', 0, 500, errors)
  if (has('dls')) checkRange(Number(patch.dls), 'dls', 0, 1000, errors)
  if (has('maxLatency')) checkRange(Number(patch.maxLatency), 'maxLatency', 0, 10000, errors)
  if (has('dataBudgetMB')) {
    checkRange(Number(patch.dataBudgetMB), 'dataBudgetMB', 0, 102400, errors)
  }
  if (has('subTokenTtlDays')) {
    checkRange(Number(patch.subTokenTtlDays), 'subTokenTtlDays', 0, 3650, errors)
  }

  if (has('subPorts')) {
    const raw = String(patch.subPorts ?? '').trim()
    if (raw) {
      const ports = raw.split(/[\n,;\s]+/).filter(Boolean)
      if (ports.length > 6) {
        errors.push({ field: 'subPorts', message: 'subPorts 最多 6 个端口' })
      } else if (!ports.every((p) => /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535)) {
        errors.push({ field: 'subPorts', message: 'subPorts 里每个端口都必须是 1~65535 的数字' })
      }
    }
  }

  if (has('subName')) {
    const name = String(patch.subName ?? '')
    if (name.length > 40) errors.push({ field: 'subName', message: 'subName 最多 40 字符' })
    if (/[\u0000-\u001f]/.test(name)) {
      errors.push({ field: 'subName', message: 'subName 不能包含控制字符' })
    }
  }

  if (has('addApi')) checkRemoteSources(String(patch.addApi ?? ''), 'addApi', errors)
  if (has('addCsv')) checkRemoteSources(String(patch.addCsv ?? ''), 'addCsv', errors)

  // 手动指定 IP：逐行校验（解析层会静默跳过看不懂的行，必须在这里拦住）
  if (has('add')) checkIpList(String(patch.add ?? ''), 'add', errors)

  if (has('uuid')) {
    const uuid = String(patch.uuid ?? '').trim()
    if (uuid && !/^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(uuid)) {
      errors.push({ field: 'uuid', message: 'uuid 必须是标准 UUID（36 位，可带连字符）' })
    }
  }

  if (has('poolCountries')) {
    const raw = String(patch.poolCountries ?? '').trim()
    if (raw) {
      const codes = raw.split(/[\n,;\s]+/).filter(Boolean)
      if (codes.length > 30) {
        errors.push({ field: 'poolCountries', message: 'poolCountries 最多 30 个国家/地区' })
      } else if (!codes.every((c) => /^[A-Za-z]{2,3}$/.test(c))) {
        errors.push({ field: 'poolCountries', message: 'poolCountries 只能是 2~3 位字母代码' })
      }
    }
  }

  if (has('udpDnsEndpoint')) {
    const endpoint = String(patch.udpDnsEndpoint ?? '').trim()
    if (endpoint && !/^https:\/\/\S+$/i.test(endpoint)) {
      errors.push({ field: 'udpDnsEndpoint', message: 'udpDnsEndpoint 必须是 https 地址' })
    }
  }

  return errors
}

/** 把错误列表压成一句可直接展示的话 */
export function describeFieldErrors(errors: FieldError[]): string {
  if (errors.length === 0) return ''
  if (errors.length === 1) return errors[0]!.message
  return `有 ${errors.length} 项配置不合法：${errors.map((e) => e.message).join('；')}`
}
