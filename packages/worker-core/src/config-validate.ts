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

/** 逐行解析的代理池（空行忽略） */
function checkProxyPool(value: string, field: string, errors: FieldError[]): void {
  const lines = value.split(/\r?\n|,/).map((l) => l.trim()).filter(Boolean)
  if (lines.length > 20) {
    errors.push({ field, message: `${field} 最多 20 条（当前 ${lines.length}）` })
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
  if (has('relayPool')) checkProxyPool(String(patch.relayPool ?? ''), 'relayPool', errors)

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
