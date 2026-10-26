#!/usr/bin/env node
/**
 * 校验分流规则里用到的 GEOSITE 分类名是否真实存在于 mihomo 的 geosite.dat。
 *
 * ## 为什么需要（2026-10-26 线上事故）
 *
 * 上一版用了 `GEOSITE,wikipedia`，而 mihomo 的 geosite.dat 里根本没有
 * 这个分类（只有 `WIKIMEDIA` / `WIKIHOW`）。Clash 报：
 *
 *     list wikipedia not found in geosite.dat
 *
 * **整份配置加载失败**——不是跳过该条，是全部作废。
 *
 * 教训：GEOSITE 分类名**必须实测**，不能凭印象写。
 *
 * ## 用法
 *
 * ```bash
 * # 自动找本机 Clash Verge / mihomo 的 geosite.dat
 * node scripts/check-geosite.mjs
 *
 * # 或指定路径
 * node scripts/check-geosite.mjs /path/to/geosite.dat
 * ```
 *
 * ## 找不到 geosite.dat 时
 *
 * 脚本会提示去哪里找，并以「跳过」退出（不阻塞构建）——
 * CI 环境通常没有这个文件。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 本项目分流规则里用到的 GEOSITE 分类（与 route-profile.ts 保持一致） */
const REQUIRED_CATEGORIES = [
  'category-ads-all',
  'youtube',
  'netflix',
  'disney',
  'primevideo',
  'hbo',
  'bahamut',
  'spotify',
  'tiktok',
  'openai',
  'anthropic',
  'google-gemini',
  'github',
  'telegram',
  'google',
  'twitter',
  'facebook',
  'instagram',
  'wikimedia',
  'cn',
]

/** 常见 geosite.dat 位置 */
function findGeosite() {
  const candidates = []
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    candidates.push(
      join(roaming, 'io.github.clash-verge-rev.clash-verge-rev', 'geosite.dat'),
      join(roaming, 'clash-verge', 'geosite.dat'),
      join(homedir(), '.config', 'clash', 'geosite.dat')
    )
  } else {
    candidates.push(
      join(homedir(), '.config', 'clash-verge', 'geosite.dat'),
      join(homedir(), '.config', 'mihomo', 'geosite.dat'),
      '/etc/mihomo/geosite.dat'
    )
  }
  return candidates.find((p) => existsSync(p))
}

/** 读 varint */
function readVarint(buf, pos) {
  let result = 0
  let shift = 0
  let p = pos
  for (;;) {
    if (p >= buf.length) return null
    const byte = buf[p++]
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: result, next: p }
    shift += 7
    if (shift > 35) return null
  }
}

/**
 * 解析 geosite.dat，返回全部分类名（统一转大写）。
 *
 * 结构：`GeoSiteList { repeated GeoSite entry = 1 }`，
 * 每个 `GeoSite` 的 field 1 是 `country_code`（分类名）。
 */
function parseCategories(buf) {
  const parseEntry = (start, end) => {
    let p = start
    while (p < end) {
      const tag = buf[p]
      if (tag === undefined) return null
      const field = tag >> 3
      const wire = tag & 7
      p++
      if (wire === 2) {
        const size = readVarint(buf, p)
        if (!size) return null
        const strEnd = size.next + size.value
        if (strEnd > end) return null
        if (field === 1) {
          const name = buf.slice(size.next, strEnd).toString('utf8')
          if (/^[A-Za-z0-9_!-]{1,60}$/.test(name)) return name
        }
        p = strEnd
      } else if (wire === 0) {
        const v = readVarint(buf, p)
        if (!v) return null
        p = v.next
      } else {
        return null
      }
    }
    return null
  }

  const out = []
  let pos = 0
  while (pos < buf.length) {
    if (buf[pos] !== 0x0a) break
    pos++
    const size = readVarint(buf, pos)
    if (!size) break
    const end = size.next + size.value
    if (end > buf.length) break
    const name = parseEntry(size.next, end)
    if (name) out.push(name)
    pos = end
  }
  return out
}

const explicit = process.argv[2]
const path = explicit ?? findGeosite()

if (!path) {
  console.log('[check-geosite] 未找到 geosite.dat，跳过校验')
  console.log('  可用参数指定：node scripts/check-geosite.mjs <路径>')
  console.log('  Windows 常见位置：')
  console.log('    %APPDATA%\\io.github.clash-verge-rev.clash-verge-rev\\geosite.dat')
  process.exit(0)
}

if (!existsSync(path)) {
  console.error(`[check-geosite] 文件不存在：${path}`)
  process.exit(1)
}

const buf = readFileSync(path)
const categories = parseCategories(buf)
if (categories.length === 0) {
  console.error('[check-geosite] 解析失败：没读到任何分类')
  process.exit(1)
}

const upper = new Set(categories.map((c) => c.toUpperCase()))
console.log(`[check-geosite] ${path}`)
console.log(`[check-geosite] 解析到 ${categories.length} 个分类`)
console.log('')

let missing = 0
for (const name of REQUIRED_CATEGORIES) {
  const ok = upper.has(name.toUpperCase())
  if (!ok) missing++
  console.log(`  ${ok ? '✅' : '❌'} ${name}`)
}

console.log('')
if (missing > 0) {
  console.error(
    `[check-geosite] ❌ ${missing} 个分类不存在 —— 写进订阅会让 **整份配置加载失败**`
  )
  console.error('  请到 route-profile.ts 的 buildBuiltinRules() 里移除或换成实际存在的分类')
  process.exit(1)
}
console.log('[check-geosite] ✅ 全部分类均存在')
