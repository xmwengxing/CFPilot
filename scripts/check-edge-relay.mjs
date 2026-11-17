#!/usr/bin/env node
/**
 * CFPilot edge-relay 权威源码漂移校验。
 *
 * 背景（见 docs/mesh-integration-plan.md Phase 0）：
 *   盲中继 / 云监测台工程的权威源码在 packages/edge-relay/。
 *   CFPilot/edge 与 MobiHop/edge 都是它的**同步副本**，禁止两边手改。
 *   本脚本用 FILELIST.json 的 SHA256 清单校验三处逐字节一致，防止漂移。
 *
 * 用法：
 *   node scripts/check-edge-relay.mjs --write     # 从权威目录刷新哈希清单（仅在源码正式改动后执行）
 *   node scripts/check-edge-relay.mjs             # 校验（默认，已挂进 npm run verify）
 *   MOBIHOP_EDGE_DIR=<path> node scripts/check-edge-relay.mjs   # 指定 MobiHop 侧 edge 路径
 *
 * MobiHop 仓库不存在时（如 CI 只 checkout 了 CFPilot）只校验权威目录与 CFPilot/edge，
 * 并打印一行说明；不等于把 MobiHop 漂移放行 —— MobiHop 侧自己的 CI 应另跑本脚本。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const authorityDir = join(repoRoot, 'packages', 'edge-relay')
const cfEdgeDir = join(repoRoot, 'edge')
const mobihopEdgeDir = resolve(
  process.env.MOBIHOP_EDGE_DIR || join(repoRoot, '..', 'MobiHop', 'edge')
)
const listPath = join(authorityDir, 'FILELIST.json')

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase()
}

function hashDir(base, files) {
  const out = {}
  for (const rel of files) {
    const f = join(base, ...rel.split('/'))
    out[rel] = existsSync(f) ? sha256(f) : null
  }
  return out
}

const write = process.argv.includes('--write')
const manifest = JSON.parse(readFileSync(listPath, 'utf8'))
const files = manifest.files

if (write) {
  manifest.hashes = hashDir(authorityDir, files)
  writeFileSync(listPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  process.stdout.write(`[edge-relay] 已刷新 ${files.length} 个文件的哈希清单\n`)
  process.exit(0)
}

let failed = false
function compare(label, base, expected) {
  if (!existsSync(base)) {
    process.stdout.write(`[edge-relay] ${label} 不存在（${base}），跳过\n`)
    return
  }
  const actual = hashDir(base, files)
  const diffs = files.filter((rel) => actual[rel] !== expected[rel])
  if (diffs.length === 0) {
    process.stdout.write(`[edge-relay] ${label} 与权威一致（${files.length} 文件）\n`)
  } else {
    failed = true
    for (const rel of diffs) {
      process.stderr.write(
        `[edge-relay] ${label} 漂移: ${rel} — 期望 ${expected[rel] ?? '缺失'}，实际 ${actual[rel] ?? '缺失'}\n`
      )
    }
  }
}

// 1) 权威目录自身哈希（防止手改源码不改清单）
compare('packages/edge-relay', authorityDir, manifest.hashes)
// 2) CFPilot 侧同步副本
compare('CFPilot/edge', cfEdgeDir, manifest.hashes)
// 3) MobiHop 侧同步副本
compare('MobiHop/edge', mobihopEdgeDir, manifest.hashes)

if (failed) {
  process.stderr.write(
    '[edge-relay] 检测到漂移。请从 packages/edge-relay 重新同步（见 packages/edge-relay/README.md），' +
    '或在正式改动源码后运行 `node scripts/check-edge-relay.mjs --write` 刷新清单。\n'
  )
  process.exit(1)
}
