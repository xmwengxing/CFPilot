// 生成两份可手动上传的 Pages 压缩包（控制面 + 数据面）。
//
// ## 为什么要这个脚本
//
// Cloudflare Pages 对同一项目的二次部署会返回 `8000119`（项目级风控标记），
// 因此更新时容易被卡住。提供两份 zip 让用户直接在控制台上传即可。
//
// ## 输出位置
//
// **仓库根目录**（`CFPilot-control.zip` / `CFPilot-dataplane.zip`）——
// 用户从 GitHub 首页就能直接下载，不用翻目录。
//
// ## 什么时候跑
//
// `npm run build` / `npm run verify` 都会调用（见 package.json），
// 保证每次改动内核后 zip 与 `dist/` 一致。
//
// ## Pages 格式
//
// Pages 的 Advanced Mode 只认根目录的 `_worker.js`，zip 里不能有外层目录。
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const DIST = resolve(ROOT, 'packages/worker-core/dist')
const STAGE = resolve(ROOT, '.pages-zip-staging')

const TARGETS = [
  { label: 'control', file: 'control.js', out: 'CFPilot-control.zip', desc: '控制面' },
  { label: 'dataplane', file: 'dataplane.js', out: 'CFPilot-dataplane.zip', desc: '数据面' },
]

// 产物必须存在（先跑 npm run build -w @cfpilot/worker-core）
for (const t of TARGETS) {
  if (!existsSync(resolve(DIST, t.file))) {
    console.error(`[pages-zip] 缺少 ${t.file}，请先运行 npm run build -w @cfpilot/worker-core`)
    process.exit(1)
  }
}

rmSync(STAGE, { recursive: true, force: true })

for (const t of TARGETS) {
  const dir = resolve(STAGE, t.label)
  mkdirSync(dir, { recursive: true })
  copyFileSync(resolve(DIST, t.file), resolve(dir, '_worker.js'))

  const zip = resolve(ROOT, t.out)
  rmSync(zip, { force: true })

  // Windows 用 Compress-Archive；其他平台有 zip 就用 zip
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${resolve(dir, '_worker.js')}' -DestinationPath '${zip}' -Force`,
      ],
      { stdio: 'pipe' }
    )
  } else {
    execFileSync('zip', ['-j', '-q', zip, resolve(dir, '_worker.js')], { stdio: 'pipe' })
  }

  const size = readFileSync(zip).length
  const codeSize = readFileSync(resolve(dir, '_worker.js')).length
  console.log(
    `[pages-zip] ${t.desc} → ${t.out} (${(size / 1024).toFixed(1)} KB，_worker.js ${(codeSize / 1024).toFixed(1)} KB)`
  )
}

rmSync(STAGE, { recursive: true, force: true })

// 仓库根目录再放一份**数据面代码文件**，供「手动部署到 Workers」直接复制粘贴。
//
// 为什么需要它：Workers 的手动部署是在网页编辑器里粘贴代码，
// 而 zip 是给 Pages 上传用的 —— 让用户解压再找文件属于多余的一步。
// 文件名固定 `_worker.js`：与 Cloudflare 控制台「模块名」默认值一致，
// 也与 Pages Advanced Mode 的入口名一致，用户不会搞混。
const rootWorker = resolve(ROOT, '_worker.js')
copyFileSync(resolve(DIST, 'dataplane.js'), rootWorker)
console.log(`[pages-zip] 数据面代码 → _worker.js (${(readFileSync(rootWorker).length / 1024).toFixed(1)} KB)`)
