/**
 * 国家 / 地区 → Cloudflare 机房三字码映射。
 *
 * ## 数据来源与同步说明
 *
 * 这张表与 worker-core 的 `src/data/pools.ts` 保持同源（那里用于订阅侧国家筛选）。
 * scanner-cli 是**独立发布**的包（`cfpilot-scanner`，被 `npx` 直接拉取），
 * 不能依赖 worker-core，因此这里复制一份。
 * 修改规则：**只允许在 worker-core 改，然后同步过来**，避免两边漂移。
 */

/** 国家代码 → 机房三字码列表 */
export const COUNTRY_COLOS: Record<string, readonly string[]> = {
  HK: ['HKG'],
  TW: ['TPE', 'KHH'],
  JP: ['NRT', 'KIX', 'CTS', 'FUK'],
  KR: ['ICN', 'PUS'],
  SG: ['SIN'],
  MY: ['KUL'],
  TH: ['BKK'],
  VN: ['SGN', 'HAN'],
  ID: ['CGK', 'DPS'],
  PH: ['MNL'],
  IN: ['BOM', 'MAA', 'DEL'],
  AU: ['SYD', 'MEL', 'BNE', 'PER'],
  NZ: ['AKL'],
  US: ['LAX', 'SJC', 'SEA', 'ORD', 'DFW', 'IAD', 'EWR', 'ATL', 'MIA', 'DEN', 'PHX', 'BOS'],
  CA: ['YYZ', 'YVR', 'YYC'],
  GB: ['LHR', 'MAN'],
  DE: ['FRA', 'MUC', 'BER'],
  FR: ['CDG', 'MRS'],
  NL: ['AMS'],
  IT: ['MXP', 'FCO'],
  ES: ['MAD', 'BCN'],
  SE: ['ARN'],
  CH: ['ZRH'],
  AT: ['VIE'],
  PL: ['WAW'],
  RU: ['DME', 'SVO'],
  TR: ['IST'],
  AE: ['DXB'],
  IL: ['TLV'],
  ZA: ['JNB'],
  BR: ['GRU', 'GIG'],
  AR: ['EZE'],
  CL: ['SCL'],
  MX: ['MEX'],
}

/** 国家中文显示名 */
export const COUNTRY_NAMES: Record<string, string> = {
  HK: '香港',
  TW: '台湾',
  JP: '日本',
  KR: '韩国',
  SG: '新加坡',
  MY: '马来西亚',
  TH: '泰国',
  VN: '越南',
  ID: '印尼',
  PH: '菲律宾',
  IN: '印度',
  AU: '澳大利亚',
  NZ: '新西兰',
  US: '美国',
  CA: '加拿大',
  GB: '英国',
  DE: '德国',
  FR: '法国',
  NL: '荷兰',
  IT: '意大利',
  ES: '西班牙',
  SE: '瑞典',
  CH: '瑞士',
  AT: '奥地利',
  PL: '波兰',
  RU: '俄罗斯',
  TR: '土耳其',
  AE: '阿联酋',
  IL: '以色列',
  ZA: '南非',
  BR: '巴西',
  AR: '阿根廷',
  CL: '智利',
  MX: '墨西哥',
}

/** 机房三字码 → 国家代码（模块加载时构建一次） */
const coloToCountry = new Map<string, string>()
for (const [country, colos] of Object.entries(COUNTRY_COLOS)) {
  for (const colo of colos) coloToCountry.set(colo, country)
}

/** 查询机房所属国家；未知返回空串 */
export function countryOfColo(colo: string): string {
  return coloToCountry.get(colo.toUpperCase()) ?? ''
}

/** 国家代码是否受支持 */
export function isKnownCountry(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(COUNTRY_COLOS, code.toUpperCase())
}

/** 全部受支持的国家代码（按定义顺序） */
export const SUPPORTED_COUNTRIES: readonly string[] = Object.keys(COUNTRY_COLOS)

/** 把用户输入的国家列表规范化：大写、去重、只保留受支持的代码 */
export function normalizeCountryFilter(input: readonly string[] | undefined): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const raw of input) {
    const code = String(raw ?? '').trim().toUpperCase()
    if (!code || out.includes(code)) continue
    if (isKnownCountry(code)) out.push(code)
  }
  return out
}
