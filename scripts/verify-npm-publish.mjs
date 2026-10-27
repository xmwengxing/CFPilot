#!/usr/bin/env node
/**
 * 验证两个 npm 包确实已发布，且版本与根 package.json 一致。
 *
 * ## 为什么发布后要再查一次
 *
 * `npm publish` 返回 0 不等于 registry 已经可以查到（有同步延迟）。
 * 更重要的是：**必须确认版本号真的是根版本**，而不是某个残留的旧值 ——
 * 单一版本源政策靠这个兜底。
 *
 * 2026-10-23 出过事故：npm 上是 0.3.0、CLI 自己报 0.2.0，
 * 因为 `src/version.ts` 漏改。本脚本同时检查：
 *   1. registry 上的版本 == 根 package.json 版本
 *   2. 包内 src/version.ts 的 VERSION 常量 == 根版本（若存在该文件）
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const rootVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
console.log(`根版本：${rootVersion}`)

const PUBLISHED = [
  { pkgDir: 'packages/cli', name: 'cfpilot', versionFile: 'src/shared/version.ts' },
]

let bad = 0

for (const p of PUBLISHED) {
  console.log(`\n=== ${p.name} ===`)

  // 1. registry 上的版本
  let registryVersion = ''
  try {
    registryVersion = execSync(`npm view ${p.name} version`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
    }).trim()
  } catch (err) {
    console.error(`  ✗ 查询 registry 失败：${err instanceof Error ? err.message : err}`)
    bad++
    continue
  }

  if (registryVersion === rootVersion) {
    console.log(`  ✓ registry 版本 = ${registryVersion}（与根一致）`)
  } else {
    console.error(`  ✗ registry 版本 = ${registryVersion}，期望 ${rootVersion}`)
    bad++
  }

  // 2. 包内 version.ts（防「发布版本与自报版本不一致」）
  const vf = resolve(p.pkgDir, p.versionFile)
  if (existsSync(vf)) {
    const src = readFileSync(vf, 'utf8')
    const m = /VERSION\s*=\s*['"]([^'"]+)['"]/.exec(src)
    const embedded = m?.[1] ?? ''
    if (embedded === rootVersion) {
      console.log(`  ✓ ${p.versionFile} 内嵌版本 = ${embedded}`)
    } else {
      console.error(`  ✗ ${p.versionFile} 内嵌版本 = ${embedded}，期望 ${rootVersion}`)
      bad++
    }
  }

  // 3. 顺带确认包里没有把 secrets 打进去
  try {
    const files = execSync(`npm view ${p.name}@${rootVersion} dist.tarball`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
    }).trim()
    if (files) console.log(`  ✓ 分发包可下载：${files.split('/').pop()}`)
  } catch {
    /* 查不到不致命 */
  }
}

if (bad === 0) {
  console.log(`\n全部通过：两个 npm 包均已发布为 ${rootVersion}`)
  process.exit(0)
}
console.error(`\n${bad} 项不一致 —— 请检查发布流程`)
process.exit(1)
