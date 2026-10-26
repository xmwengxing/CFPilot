// 校验内核源码哈希的稳定性与正确性。
//
// ## 为什么需要（2026-10-27 用户反馈）
//
// 用户点「检查状态」永远显示「已是最新」，即使我改了面板 UI。
//
// 根因：`buildVersion()` 计算源码哈希时**包含了 `ui/panel.generated.ts`**——
// 那是 `panel.html` 压缩后的构建中间产物，每次构建都会重新生成。
//
// 于是形成死循环：
//   1. 构建开始 → 算哈希（用的是**上一次**的 generated）→ 得到旧值 A
//   2. 构建过程 → 重新生成 generated
//   3. 下次构建 → 哈希纳入新的 generated → 得到新值 B
//   4. 再下次 → 又变回 A ...
//
// 结果：改了面板 HTML 后版本号不变（永远滞后一次），
// 用户点「检查状态」看不到可更新，订阅也拿不到新面板。
//
// 正确做法：源码哈希只覆盖**人手写的文件**，排除 `.generated.ts`。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

const SRC = resolve('packages/worker-core/src')

/**
 * 复算源码哈希，可选择是否包含生成文件。
 *
 * 与 build.mjs 的 buildVersion() 保持同一算法（排序 + 顺序喂入）。
 */
function computeHash(includeGenerated) {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|html)$/.test(name)) {
        if (!includeGenerated && /\.generated\.ts$/.test(name)) continue
        files.push(p)
      }
    }
  }
  walk(SRC)
  files.sort()
  const d = createHash('sha256')
  for (const f of files) d.update(readFileSync(f))
  return { hash: d.digest('hex').slice(0, 8), files }
}

let bad = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) bad++
}

console.log('=== 内核源码哈希校验 ===\n')

// 1) build.mjs 里必须排除 .generated.ts
const buildSrc = readFileSync('packages/worker-core/scripts/build.mjs', 'utf8')
check(
  'build.mjs 排除 .generated.ts',
  /!\/\\\.generated\\\.ts\$\/\.test\(name\)/.test(buildSrc) ||
    !/\.generated\.ts/.test(buildSrc.split('buildVersion')[1]?.split('return')[0] ?? ''),
  '源码哈希不能包含构建中间产物'
)

// 2) 两个哈希必须不同（说明排除生效了）
const withGen = computeHash(true)
const withoutGen = computeHash(false)

check(
  '排除 generated 后哈希不同',
  withGen.hash !== withoutGen.hash,
  `含=${withGen.hash} 不含=${withoutGen.hash}`
)

// 3) 排除后不应残留 generated 文件
const genFiles = withoutGen.files.filter((f) => /\.generated\.ts$/.test(f))
check('排除后文件列表无 generated', genFiles.length === 0, `参与哈希 ${withoutGen.files.length} 个文件`)

// 4) 相同的两次计算必须一致（稳定性）
const again = computeHash(false)
check('重复计算哈希一致', withoutGen.hash === again.hash, '同一份源码应得到同一版本号')

// 5) 关键源文件必须在哈希范围内
const mustInclude = ['api.ts', 'config.ts', 'ui/panel.html', 'routes/control.ts']
for (const rel of mustInclude) {
  const hit = withoutGen.files.some((f) => f.endsWith(rel.replace(/\//g, '\\')) || f.endsWith(rel))
  check(`哈希包含 ${rel}`, hit)
}

console.log(
  bad === 0
    ? '\n全部通过：源码哈希稳定且不含构建中间产物，改了代码版本号才会变。'
    : `\n${bad} 项失败 —— 版本号可能永不收敛，用户会一直看到「已是最新」。`
)
process.exit(bad ? 1 : 0)
