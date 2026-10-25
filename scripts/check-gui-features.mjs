// 确认 GUI 产物含 0.4.1 的新功能（esbuild 会把中文转义成 \uXXXX）
import { readFileSync } from 'node:fs'

const s = readFileSync('packages/gui/dist/main/deployer-lib.js', 'utf8')
console.log('deployer-lib.js:', (s.length / 1024).toFixed(1), 'KB')

// 解码 \uXXXX
const decoded = s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))

const marks = [
  ['删除旧项目', '已删除被替换的旧'],
  ['域名迁移成功', '自定义域名已迁移到新项目'],
  ['解绑旧项目', '已从旧项目'],
  ['识别旧域名', '绑定了自定义域名'],
  ['迁移失败告警', '域名迁移失败'],
]

console.log('')
let allOk = true
for (const [label, pat] of marks) {
  const ok = decoded.includes(pat)
  if (!ok) allOk = false
  console.log(`  ${label.padEnd(16)} ${ok ? '✅' : '❌'}  "${pat}"`)
}

console.log('')
console.log(allOk ? '✅ GUI 产物已包含全部新功能' : '❌ 有缺失，需重新构建')
process.exit(allOk ? 0 : 1)
