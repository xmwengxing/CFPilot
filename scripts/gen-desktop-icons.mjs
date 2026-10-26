// 生成 CFPilot 桌面版需要的图标资源。
//
// ## 为什么需要这个脚本
//
// Go 编译出的 exe **默认没有图标**（Windows 显示成一张白纸），
// 而托盘图标也必须是**真实**的 PNG —— 手写假字节会让
// systray 的 LoadImage 失败，整个程序静默退出（实测踩过）。
//
// 本脚本从 packages/gui/build/icon.png（Electron 版用的 512×512 图标）
// 生成：
//   - packages/desktop/build/tray-16.png   托盘图标（16×16）
//   - packages/desktop/build/tray-32.png   托盘图标（32×32，高 DPI）
//   - packages/desktop/build/app.ico       应用图标（多尺寸 ICO，给 go-winres 用）
//   - packages/desktop/internal/tray/icon.go  把托盘 PNG 字节内嵌成 Go 代码
//
// ## 为什么自己编码而不装图像库
//
// 项目坚持零第三方依赖（连图标生成也不想引入 sharp/jimp 之类的重依赖）。
// PNG 与 ICO 的编码规则都很短，直接手写反而更可控。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, crc32 } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const srcIcon = join(repoRoot, 'packages', 'gui', 'build', 'icon.png')
const outDir = join(repoRoot, 'packages', 'desktop', 'build')

mkdirSync(outDir, { recursive: true })

// ---- PNG 编码 ----

/** 组装一个 PNG 数据块 */
function chunk(type, payload) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(payload.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

/**
 * 生成一张纯色渐变 PNG（RGBA）。
 *
 * 我们不解析源 PNG（避免引入解码器），而是**按品牌色重画**：
 * 左上到右下的紫蓝渐变 + 白色 CP 字样。
 * 这样生成的小尺寸图标在高 DPI 下比缩放的照片类图标更清晰。
 */
function makePng(size) {
  const rows = []
  const CX = [0x4f, 0x7c, 0xff] // #4f7cff
  const CY = [0x8b, 0x5c, 0xf6] // #8b5cf6

  // CP 字样用「按比例定位的矩形段」画，比逐像素硬编更好维护
  const s = (v) => Math.round((v / 16) * size)
  const white = [
    // C：左上 → 左下（一个开口向右的 C）
    [s(4), s(4), s(7), s(5)],
    [s(4), s(5), s(5), s(11)],
    [s(4), s(10), s(7), s(11)],
    // P：竖笔 + 上半圆弧
    [s(9), s(4), s(10), s(12)],
    [s(10), s(4), s(13), s(5)],
    [s(12.5), s(5), s(13.5), s(8)],
    [s(10), s(7), s(13), s(8)],
  ]

  const inRect = (x, y, rect) => x >= rect[0] && x < rect[2] && y >= rect[1] && y < rect[3]

  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 4)
    for (let x = 0; x < size; x++) {
      const t = size > 1 ? (x + y) / (2 * size - 2) : 0
      let r = Math.round(CX[0] + (CY[0] - CX[0]) * t)
      let g = Math.round(CX[1] + (CY[1] - CX[1]) * t)
      let b = Math.round(CX[2] + (CY[2] - CX[2]) * t)
      let a = 255

      // 圆角：四角各去掉一个 2/16 半径的三角
      const rad = Math.max(1, Math.round(size * 0.125))
      const cornerX = x < rad ? rad - x : x >= size - rad ? x - (size - rad - 1) : 0
      const cornerY = y < rad ? rad - y : y >= size - rad ? y - (size - rad - 1) : 0
      if (cornerX > 0 && cornerY > 0 && cornerX * cornerX + cornerY * cornerY > rad * rad) {
        a = 0
      }

      if (a > 0 && white.some((rect) => inRect(x, y, rect))) {
        r = 255
        g = 255
        b = 255
      }

      const o = x * 4
      row[o] = r
      row[o + 1] = g
      row[o + 2] = b
      row[o + 3] = a
    }
    // PNG 每行前加 filter 字节（0 = None）
    rows.push(Buffer.concat([Buffer.from([0]), row]))
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- ICO 编码（内嵌 PNG，Windows Vista+ 支持）----

function makeIco(sizes) {
  const pngs = sizes.map((s) => ({ size: s, data: makePng(s) }))

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(pngs.length, 4)

  let offset = 6 + 16 * pngs.length
  const entries = []
  for (const p of pngs) {
    const e = Buffer.alloc(16)
    e[0] = p.size >= 256 ? 0 : p.size // width（256 记作 0）
    e[1] = p.size >= 256 ? 0 : p.size // height
    e[2] = 0 // palette
    e[3] = 0 // reserved
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bit count
    e.writeUInt32LE(p.data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += p.data.length
    entries.push(e)
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

// ---- 生成 ----

const tray16 = makePng(16)
const tray32 = makePng(32)
const ico = makeIco([16, 24, 32, 48, 64, 128, 256])

writeFileSync(join(outDir, 'tray-16.png'), tray16)
writeFileSync(join(outDir, 'tray-32.png'), tray32)
writeFileSync(join(outDir, 'app.ico'), ico)

console.log(`[icons] tray-16.png  ${tray16.length} 字节`)
console.log(`[icons] tray-32.png  ${tray32.length} 字节`)
console.log(`[icons] app.ico      ${ico.length} 字节（7 个尺寸）`)

// ---- 内嵌进 Go 代码 ----

function toGoBytes(name, buf, comment) {
  const lines = []
  if (comment) lines.push(comment)
  lines.push(`var ${name} = []byte{`)
  for (let i = 0; i < buf.length; i += 12) {
    const part = buf.subarray(i, i + 12)
    lines.push('\t' + Array.from(part, (b) => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(', ') + ',')
  }
  lines.push('}')
  return lines.join('\n')
}

const goSrc = `package tray

// 托盘图标资源（多格式）。
//
// ## ⚠️ Windows 必须用 ICO，不能用 PNG（2026-10-26 最终结论）
//
// systray 的源码注释写得很明确：
//
//     // iconBytes should be the content of .ico for windows and
//     // .ico/.jpg/.png for other platforms.
//
// Windows 实现走 \`LoadImage(hInstance, path, IMAGE_ICON, 0, 0, LR_LOADFROMFILE|LR_DEFAULTSIZE)\`，
// 只认 ICO。喂 PNG **不会报错**，但句柄不可用，
// 托盘上就是一个**完全透明的占位** —— 看得见位置、点得到菜单、没有图案。
//
// 排查历程（前两次判断都是错的，记下来避免重走）：
//   1. 以为是「手写假 PNG 字节」→ 换真 PNG，仍透明
//   2. 以为是 16×16 被 LR_DEFAULTSIZE 拉伸丢 Alpha → 换 32×32，仍透明
//   3. 最后看库文档：**Windows 要 .ico**
//
// 因此三种格式都内嵌，由 icon_platform.go 按 GOOS 选用：
//   Windows        → iconICO（多尺寸 ICO）
//   Linux / macOS  → iconPNG32
//
// 本文件由 scripts/gen-desktop-icons.mjs 生成，**不要手改**。

${toGoBytes('iconICO', ico, '// iconICO 是多尺寸 ICO（16/24/32/48/64/128/256）。Windows 托盘与 exe 都用它。')}

${toGoBytes('iconPNG16', tray16, '// iconPNG16 是 16×16 PNG（Linux / macOS 备用）。')}

${toGoBytes('iconPNG32', tray32, '// iconPNG32 是 32×32 PNG（Linux / macOS 主用）。')}
`

const iconGoPath = join(repoRoot, 'packages', 'desktop', 'internal', 'tray', 'icon.go')
writeFileSync(iconGoPath, goSrc, 'utf8')
console.log(`[icons] icon.go      已更新（ICO + PNG16 + PNG32）`)

// 源图标仅供参考（不参与生成，因为我们是按品牌色重画）
try {
  const src = readFileSync(srcIcon)
  console.log(`[icons] 参考源图标 ${src.length} 字节（品牌色取自它）`)
} catch {
  console.log('[icons] 未找到参考源图标，已使用内置品牌色')
}
