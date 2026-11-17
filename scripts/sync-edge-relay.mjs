#!/usr/bin/env node
/**
 * 把权威源码 packages/edge-relay/ 同步到两个消费副本：
 *   - CFPilot/edge
 *   - MobiHop/edge（可选，路径由 MOBIHOP_EDGE_DIR 指定，默认 ../MobiHop/edge）
 *
 * 只覆盖 FILELIST.json 里列出的文件，不碰 node_modules、.wrangler 等运行期产物。
 * 同步后自动刷新哈希清单并跑一次校验（除非 --no-check）。
 *
 * 用法：
 *   node scripts/sync-edge-relay.mjs                 # 同步到 CFPilot/edge + MobiHop/edge（若存在）
 *   node scripts/sync-edge-relay.mjs --authority-only  # 只刷新权威清单，不写任何副本
 *   node scripts/sync-edge-relay.mjs --dry-run        # 只打印将要做的动作
 *   MOBIHOP_EDGE_DIR=<path> node scripts/sync-edge-relay.mjs
 *
 * ⚠️ 同步是**覆盖写**。执行前确认 MobiHop/edge 没有未提交的在途改动
 *    （git -C <MobiHop> status --short -- edge/）。本脚本不会自动 stash 或备份。
 */
import { existsSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const authorityDir = join(repoRoot, 'packages', 'edge-relay')
const listPath = join(authorityDir, 'FILELIST.json')
const targets = [
  join(repoRoot, 'edge'),
  resolve(process.env.MOBIHOP_EDGE_DIR || join(repoRoot, '..', 'MobiHop', 'edge')),
]

const manifest = JSON.parse(readFileSync(listPath, 'utf8'))
const files = manifest.files
const dryRun = process.argv.includes('--dry-run')
const authorityOnly = process.argv.includes('--authority-only')

const activeTargets = authorityOnly ? [] : targets.filter((t) => existsSync(t))
for (const t of targets) {
  if (!existsSync(t) && !authorityOnly) {
    process.stdout.write(`[edge-relay] 目标不存在，跳过：${t}\n`)
  }
}

for (const target of activeTargets) {
  for (const rel of files) {
    const src = join(authorityDir, ...rel.split('/'))
    const dst = join(target, ...rel.split('/'))
    mkdirSync(dirname(dst), { recursive: true })
    if (dryRun) {
      process.stdout.write(`[dry-run] ${src} -> ${dst}\n`)
      continue
    }
    copyFileSync(src, dst)
  }
  process.stdout.write(`[edge-relay] 已同步 ${files.length} 文件 → ${target}\n`)
}

if (!dryRun && !authorityOnly) {
  process.stdout.write('[edge-relay] 请运行 `node scripts/check-edge-relay.mjs` 确认三处一致\n')
}
