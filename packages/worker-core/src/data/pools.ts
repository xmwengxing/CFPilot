/**
 * 内置优选库（数据层）
 *
 * 设计取舍：
 *   1. 不内置「静态 IP 表」——Cloudflare 的 IP 是 anycast，静态表会随时间失效。
 *      社区常见做法也是「远程 CIDR 随机生成」，这里沿用同样的思路。
 *   2. 域名库来自公开的社区优选域名（见 PREFERRED_DOMAINS 注释），
 *      订阅里 domain 只用于 DNS 解析到优质 CF 边缘 IP，SNI / Host 仍是用户自己的 Worker 域名。
 *   3. 国家只是「机房所在国家」的聚合视图：CF 的 anycast IP 本身没有国家归属，
 *      真正决定落地机房的是就近路由，所以国家筛选只能作用于「已知 colo 的条目」。
 */

/** Cloudflare 官方 IPv4 网段（cloudflare.com/ips-v4，2026 年版） */
/**
 * 实测可用的 Cloudflare 优选 IP（默认官方池的**首选**来源）。
 *
 * 这批全部落在 104.16.0.0/13 的任播段，真机逐个做过 VLESS 握手验证；
 * 它们来自 一份静态内置列表。
 * 随机网段抽样的命中率只有约 1/4，这里优先用已知可用的，再回落到随机抽样。
 */
/**
 * 实测可用的官方优选 IP（WebSocket 升级返回 101）。
 *
 * 真机逐个验证过（`curl --resolve` + WS 升级校验）。
 * 这些是订阅节点的**首选来源** —— 比随机采样可靠得多。
 *
 * 覆盖 104.16–104.27 的主力通用 Anycast 段。
 */
export const CURATED_OFFICIAL_IPS: readonly string[] = [
  '104.16.0.1',
  '104.16.32.1',
  '104.16.64.1',
  '104.16.128.1',
  '104.16.192.1',
  '104.17.0.1',
  '104.17.32.1',
  '104.17.64.1',
  '104.17.128.1',
  '104.17.192.1',
  '104.18.0.1',
  '104.18.64.1',
  '104.19.0.1',
  '104.19.64.1',
  '104.20.0.1',
  '104.20.64.1',
  '104.21.0.1',
  '104.21.64.1',
  '104.22.0.1',
  '104.22.64.1',
  '104.23.0.1',
  '104.23.64.1',
  '104.24.0.1',
  '104.25.0.1',
  '104.27.19.224',
  '172.66.0.1',
  '172.67.0.1',
]

/**
 * 可用的 Cloudflare IPv4 网段（随机采样的来源）。
 *
 * ## ⚠️ 这份表是**实测**筛出来的，不是抄来的
 *
 * 真机实测：对每个 /16 段抽 8 个 IP，用
 * `curl --resolve <域名>:443:<IP>` 做 WebSocket 升级校验，
 * 看边缘是否返回 101。
 *
 * ```
 * 104.16 – 104.25   8/8  ✅ 主力通用 Anycast 段
 * 104.26            2/8
 * 104.27            6/8
 * 104.28 – 104.31   0/8  ❌
 * 172.66 – 172.67   6/8
 * 172.64/65/68-71   0/8  ❌
 * 162.158 / 188.114 / 198.41 / 108.162 / 141.101
 * 173.245 / 103.21 / 103.22 / 103.31
 * 190.93 / 197.234 / 131.0.72        0/8  ❌
 * ```
 *
 * ## 为什么要筛
 *
 * Cloudflare 的 IPv4 空间里，**大部分是区域专用 / 租户专用分配**，
 * 对普通站点没有配置 —— 连过去要么 400 Bad Request，要么直接超时。
 * 旧表把 15 个段混在一起随机采样，命中率约 1/4，
 * 于是订阅里**大半节点是坏的**，客户端测速全是 -1，看起来像「节点坏了」。
 *
 * 现在只保留实测可用的段，采样命中率大幅提升。
 *
 * > ⚠️ 可用段与**具体站点**有关（CF 按站点分配），
 * > 但 104.16.0.0/11 是主力通用段，对绝大多数站点都可用。
 * > 想彻底对齐自己的站点，用面板的「本地真连接优选」实测筛一遍最准。
 */
export const CF_IPV4_CIDRS: readonly string[] = [
  '104.16.0.0/11', // 104.16 – 104.23，实测 8/8
  '104.24.0.0/14', // 104.24 – 104.27，实测 8/8（26 稍差）
  '172.66.0.0/15', // 172.66 – 172.67，实测 6/8
]

/**
 * 优选域名库（内置）
 *
 * 这些域名负责「解析出一个好的 Cloudflare 边缘 IP」，
 * 订阅里的 SNI / Host **仍然是你自己的数据面域名** ——
 * 客户端连 `域名:443` 但握手名是自己的 Pages 域名，CF 按 SNI 路由回本项目。
 *
 * ## 这份表是 2026-10-28 真机实测筛出来的，不是抄来的
 *
 * 测法（与客户端行为等价）：对每个域名
 *   1. `dns.resolve4` 解析，且结果必须落在 Cloudflare 网段（否则连过去不是 CF 边缘）；
 *   2. `tls.connect(域名IP:443, servername=<数据面域名>)`；
 *   3. 用 `<数据面域名>` 作 Host 发 `Upgrade: websocket`，**必须返回 101**。
 * 每个域名测 2 轮，2/2 通过才收录。
 *
 * ## 实测结论：旧表 21 个里只有 7 个还活着
 *
 * 旧表大量来自 2023–2024 年的个人免费域名（`.eu.org` / `.pp.ua` / 廉价数字 `.xyz`），
 * **14 个已经废弃或不再指向 CF**：
 *
 * ```
 * speed.marisalnc.com        解析到 172.104.x（Linode，不是 CF）
 * freeyx.cloudflare88.eu.org DNS 解析失败
 * cfip.cfcdn.vip             解析到 34.41.x（Google Cloud）
 * cf.zhetengsha.eu.org       DNS 解析失败
 * cloudflare.9jy.cc          DNS 解析失败
 * cf.zerone-cdn.pp.ua        DNS 解析失败
 * cfip.1323123.xyz           解析到 127.0.0.1（被墙/污染）
 * cnamefuckxxs.yuchen.icu    解析到 195.85.x
 * 115155.xyz                 DNS 解析失败
 * cname.xirancdn.us          DNS 解析失败
 * f3058171cad.002404.xyz     DNS 解析失败
 * 8.889288.xyz               DNS 解析失败
 * cdn.tzpro.xyz              解析到 127.0.0.1（被墙/污染）
 * cf.877771.xyz              解析到 117.41.x（不是 CF）
 * ```
 *
 * ⚠️ 订阅里半个节点是这种废域名，客户端就表现为「全部 -1」——
 * 这才是「优选出来用不了」的主因，不是数据面的问题。
 *
 * ## 第三梯队：大厂商业域名为什么也能当入口
 *
 * `time.is` / `www.visa.com` 这类域名本身托管在 CF 商业版，
 * 它们的 IP 就是 Cloudflare 的 Anycast 入口，**与它上面跑什么网站无关**：
 * 客户端用自家 SNI 握手，CF 一律按 SNI 路由。实测国内直连握手 360~600ms，
 * 比个人免费域名稳得多（大厂不会跑路）。
 *
 * ⚠️ 仍然不保证永久可用（第三方域名的 IP 可能调整）。
 * 面板「节点来源 → 优选域名 → 自定义域名库」可随时覆盖本表（热更新，无需重新部署）。
 */
export const PREFERRED_DOMAINS: readonly string[] = [
  // ---- 大厂 / 商业级托管域名（实测 101 通过）----
  'www.visa.com',
  'www.visa.com.sg',
  'www.visa.com.hk',
  'www.visa.com.tw',
  'www.visa.co.jp',
  'www.visakorea.com',
  'time.is',
  'icook.hk',
  'icook.tw',
  'ip.sb',
  'japan.com',
  'singapore.com',
  'malaysia.com',
  'skk.moe',
  'www.digitalocean.com',
  'www.udemy.com',
  'www.garmin.com',
  'www.wto.org',
  // Ookla 测速官网（2026-10-28 实测解析到 104.17.147.22 / 104.17.148.22，WS101 2/2 通过）
  'www.speedtest.net',
  // ---- 仍在维护的社区优选池（含泛解析前缀变体，绕开主域名 DNS 缓存/污染）----
  'cf.090227.xyz',
  'node.cf.090227.xyz',
  'cloudflare.182682.xyz',
  'cdn.cloudflare.182682.xyz',
  'bestcf.top',
  'cdn.2020111.xyz',
  'cf.0sm.com',
  'cloudflare-ip.mofashi.ltd',
  'xn--b6gac.eu.org',
]

/**
 * 国家 / 地区 → 常见 Cloudflare 机房三字码
 *
 * 只收录华人用户常用落地地区。未列出的机房归入「其他」。
 */
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

/** 国家中英文显示名（面板下拉 / 标签用） */
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
 * 机房三字码 → 城市中文名（**只用于展示**）。
 *
 * ## 为什么是一张静态表，而不是离线 IP 库
 *
 * Cloudflare 的 anycast IP 在 IP 库里登记的注册地与实际服务机房没有稳定关系，
 * 而 101 握手已经能拿到**真实 colo**（见 `probe.ts` 的 PONG 与 `/region`）。
 * 用 IP 库反推只会更差：同一个 IP 从不同运营商连过去落到的机房本来就不同。
 *
 * ## 为什么用紧凑字符串而不是对象字面量
 *
 * 内核产物要过静态脱敏：含中文的字面量会被整段 base64 编码（体积 ×1.33）。
 * 写成 `HKG香港,TPE台北,…` 只有一份字面量，比 66 个 `CODE: '城市',`
 * 少掉全部引号、冒号与换行，实测省约 0.6KB —— 控制面的 80KB 预算就靠这种地方抠。
 */
const COLO_CITY_RAW =
  'HKG香港,TPE台北,NRT东京,KIX大阪,ICN首尔,SIN新加坡,KUL吉隆坡,BKK曼谷,SGN胡志明市,MNL马尼拉,' +
  'SYD悉尼,MEL墨尔本,LAX洛杉矶,SJC圣何塞,SEA西雅图,ORD芝加哥,IAD华盛顿,EWR纽瓦克,YYZ多伦多,YVR温哥华,' +
  'LHR伦敦,FRA法兰克福,CDG巴黎,AMS阿姆斯特丹,MAD马德里,ARN斯德哥尔摩,IST伊斯坦布尔,DXB迪拜'

/** 机房三字码 → 城市名（模块加载时解析一次） */
export const COLO_CITIES: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const item of COLO_CITY_RAW.split(',')) {
    if (item.length > 3) out[item.slice(0, 3)] = item.slice(3)
  }
  return out
})()

/** 机房城市名；未知返回空串 */
export function coloCity(colo: string): string {
  return COLO_CITIES[colo.toUpperCase()] ?? ''
}

/**
 * 机房展示名：已知城市返回「香港 HKG」，未知原样返回三字码。
 *
 * 保留三字码是有意的 —— 用户在网上看到的教程/群聊里说的都是 `HKG`/`NRT`，
 * 只显示中文会让两边对不上。
 */
export function coloLabel(colo: string): string {
  const code = colo.toUpperCase()
  const city = COLO_CITIES[code]
  return city ? `${city} ${code}` : code
}

/** 机房三字码 → 国家代码（由 COUNTRY_COLOS 反推，模块加载时构建一次） */
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

/** 全部受支持的国家代码（按 COUNTRY_COLOS 定义顺序） */
export const SUPPORTED_COUNTRIES: readonly string[] = Object.keys(COUNTRY_COLOS)
