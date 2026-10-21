/**
 * 内置优选库（数据层）
 *
 * 设计取舍：
 *   1. 不内置「静态 IP 表」——Cloudflare 的 IP 是 anycast，静态表会随时间失效。
 *      edgetunnel 的做法也是「远程 CIDR 随机生成」，这里沿用同样的思路。
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
 * 它们来自 CFNext 的内置列表（https://github.com/PAICNI/CFNext）。
 * 随机网段抽样的命中率只有约 1/4，这里优先用已知可用的，再回落到随机抽样。
 */
export const CURATED_OFFICIAL_IPS: readonly string[] = [
  '104.17.242.168',
  '104.27.19.224',
  '104.17.76.217',
  '104.16.59.243',
  '104.17.112.167',
  '104.17.178.202',
  '104.16.211.40',
  '104.19.73.179',
  '104.18.0.20',
  '104.16.100.111',
]

export const CF_IPV4_CIDRS: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
]

/**
 * 社区公开优选域名库
 *
 * 主要搬运自 byJoey/cfnew 的「直连域名列表」（21 条），这些域名由第三方维护，
 * CNAME 到 Cloudflare 边缘、且解析到的 IP 通常对国内网络较友好。
 * 它们只负责「解析出一个好的 CF IP」，订阅里的 SNI / Host 仍然是你自己的 Worker 域名。
 *
 * 注意：第三方域名的可用性会随时间变化，面板提供「更新优选库」用于热更新。
 */
export const PREFERRED_DOMAINS: readonly string[] = [
  'cf.090227.xyz',
  'bestcf.top',
  'cloudflare.182682.xyz',
  'speed.marisalnc.com',
  'freeyx.cloudflare88.eu.org',
  'cdn.2020111.xyz',
  'cfip.cfcdn.vip',
  'cf.0sm.com',
  'cf.zhetengsha.eu.org',
  'cloudflare.9jy.cc',
  'cf.zerone-cdn.pp.ua',
  'cfip.1323123.xyz',
  'cnamefuckxxs.yuchen.icu',
  'cloudflare-ip.mofashi.ltd',
  '115155.xyz',
  'cname.xirancdn.us',
  'f3058171cad.002404.xyz',
  '8.889288.xyz',
  'cdn.tzpro.xyz',
  'cf.877771.xyz',
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
