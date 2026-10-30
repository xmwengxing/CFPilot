/**
 * 国家 / 地区 → Cloudflare 机房三字码映射。
 *
 * ## 数据来源与同步说明
 *
 * 这张表与 worker-core 的 `src/data/pools.ts` 保持同源（那里用于订阅侧国家筛选）。
 * 优选器已合并进单一 CLI 包（`cfpilot`，入口是 `cfpilot scan` 子命令），
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

/**
 * 区域分组：界面上的「亚洲组 / 美国组」按钮与 CLI 菜单、`--countries` 分组关键字共用。
 *
 * 分组是**国家代码的集合**，不是机房码集合 —— 机房码由 COUNTRY_COLOS 展开，
 * 避免两处各写一份机房表。
 *
 * 与 Go 版 `packages/desktop/internal/scan/countries.go` 的 `regionGroups` 保持同源，
 * 修改规则同 COUNTRY_COLOS：**两边必须同时改**。
 *
 * ## 亚洲组包含哪些国家
 *
 * 按地理口径取「亚洲国家」：东亚 / 东南亚 / 南亚 / 西亚（阿联酋、以色列）。
 * 不含大洋洲（AU / NZ），也不含横跨欧亚、机房落在欧洲一侧的
 * TR（伊斯坦布尔）与 RU（莫斯科）。
 */
export const REGION_GROUPS: Record<string, readonly string[]> = {
  ASIA: ['HK', 'TW', 'JP', 'KR', 'SG', 'MY', 'TH', 'VN', 'ID', 'PH', 'IN', 'AE', 'IL'],
  US: ['US'],
}

/** 分组关键字 → 中文名（菜单与界面文案共用） */
export const REGION_GROUP_NAMES: Record<string, string> = {
  ASIA: '亚洲组',
  US: '美国组',
}

/** 是否是分组关键字（不是国家代码） */
export function isRegionGroup(code: string): boolean {
  const key = String(code ?? '').trim().toUpperCase()
  if (!Object.prototype.hasOwnProperty.call(REGION_GROUPS, key)) return false
  // US 既是分组名也是国家码：展开结果与它自身一致，仍按分组处理
  return true
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

/**
 * 把用户输入的国家列表规范化：大写、去重、只保留受支持的代码。
 *
 * 分组关键字（`ASIA` / `US`）在这里展开成该组的全部国家代码，
 * 所以下游拿到的永远是国家码，不需要再认识分组。
 * 同时写分组和组内国家（如 `ASIA,HK`）会自动去重。
 *
 * **兼容机房三字码**：`HKG` 会被归一到它的国家 `HK`。
 * 早前 CLI 只认国家码，`--countries HKG` 会被静默丢弃（直接跑全量），
 * 而 Go 界面用的是机房码 —— 同一个参数在两端行为不一致。
 * 现在两端都以**国家码为准**，机房码作别名兼容（Go 侧早已支持）。
 */
export function normalizeCountryFilter(input: readonly string[] | undefined): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const push = (code: string): void => {
    if (code && !out.includes(code)) out.push(code)
  }
  for (const raw of input) {
    const code = String(raw ?? '').trim().toUpperCase()
    if (!code) continue
    // 分组关键字 → 展开成组内国家（组内只含国家码，不会递归）
    if (isRegionGroup(code)) {
      for (const member of REGION_GROUPS[code] ?? []) push(String(member).toUpperCase())
      continue
    }
    if (isKnownCountry(code)) {
      push(code)
      continue
    }
    // 机房码 → 所属国家；未知码仍然丢弃（不当成「全量」以外的意外行为）
    const country = countryOfColo(code)
    if (country) push(country)
  }
  return out
}

/**
 * 机房三字码 → 城市中文名（**只用于展示**）。
 *
 * 与 worker-core 的 `src/data/pools.ts` 同源，修改规则同 `COUNTRY_COLOS`：
 * 只在 worker-core 改，然后同步到这里。
 *
 * 为什么不用离线 IP 库：Cloudflare anycast IP 的注册地与真实机房没有稳定关系，
 * 而 101 握手已经能拿到真实 colo —— 一张静态表足够，且不引入任何依赖。
 */
export const COLO_CITIES: Record<string, string> = {
  HKG: '香港', TPE: '台北', KHH: '高雄', NRT: '东京', KIX: '大阪', CTS: '札幌', FUK: '福冈',
  ICN: '首尔', PUS: '釜山', SIN: '新加坡', KUL: '吉隆坡', BKK: '曼谷', SGN: '胡志明市',
  HAN: '河内', CGK: '雅加达', DPS: '登巴萨', MNL: '马尼拉', BOM: '孟买', MAA: '金奈',
  DEL: '新德里', SYD: '悉尼', MEL: '墨尔本', BNE: '布里斯班', PER: '珀斯', AKL: '奥克兰',
  LAX: '洛杉矶', SJC: '圣何塞', SEA: '西雅图', ORD: '芝加哥', DFW: '达拉斯', IAD: '华盛顿',
  EWR: '纽瓦克', ATL: '亚特兰大', MIA: '迈阿密', DEN: '丹佛', PHX: '凤凰城', BOS: '波士顿',
  YYZ: '多伦多', YVR: '温哥华', YYC: '卡尔加里', LHR: '伦敦', MAN: '曼彻斯特', FRA: '法兰克福',
  MUC: '慕尼黑', BER: '柏林', CDG: '巴黎', MRS: '马赛', AMS: '阿姆斯特丹', MXP: '米兰',
  FCO: '罗马', MAD: '马德里', BCN: '巴塞罗那', ARN: '斯德哥尔摩', ZRH: '苏黎世',
  VIE: '维也纳', WAW: '华沙', DME: '莫斯科', SVO: '莫斯科', IST: '伊斯坦布尔', DXB: '迪拜',
  TLV: '特拉维夫', JNB: '约翰内斯堡', GRU: '圣保罗', GIG: '里约热内卢', EZE: '布宜诺斯艾利斯',
  SCL: '圣地亚哥', MEX: '墨西哥城',
}

/** 机房城市名；未知返回空串 */
export function coloCity(colo: string): string {
  return COLO_CITIES[colo.toUpperCase()] ?? ''
}
