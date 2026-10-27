#!/usr/bin/env node
/**
 * 幂等发布一个 npm 包。
 *
 * ## 为什么需要这个脚本
 *
 * npm **不允许覆盖已发布的版本号**。如果 CI 重跑（比如修 CI 配置后重新触发），
 * 直接 `npm publish` 会报 `403 You cannot publish over the previously published versions`，
 * 整个工作流失败 —— 但其实包已经发好了，用户没受影响。
 *
 * 本脚本先查 registry，该版本已存在就跳过并返回 0，让 CI 保持绿色。
 *
 * ## 用法
 *
 *   node scripts/publish-npm.mjs <包名>
 *
 * 需要环境变量 NODE_AUTH_TOKEN（GitHub Secrets 里的 NPM_TOKEN）。
 *
 * ## 关于 2FA
 *
 * npm 账号开了 2FA 时，`npm publish` 在本地会要求输 OTP。
 * CI 里没法交互输入，所以必须用 **Automation** 类型的 token：
 *   npmjs.com → Access Tokens → Generate New Token → 选 **Automation**
 *
 * Automation token 的权限足以发布，且不要求 OTP。
 * （Classic 的 "Publish" 类型仍然会要 OTP，别选错。）
 */
import { execSync } from 'node:child_process'

// 用 execSync + shell 模式：Windows 上 npm 是 .cmd，execFileSync 会 ENOENT/EINVAL
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pkgName = process.argv[2]
if (!pkgName) {
  console.error('用法: node scripts/publish-npm.mjs <包名>')
  process.exit(1)
}

// 找到该包所在目录
//
// 包名与目录名不一定相同（cfpilot-scanner 在 packages/scanner-cli），
// 所以用一个显式映射表，而不是猜。
const DIR_MAP = {
  cfpilot: 'cli',
}
const dirName = DIR_MAP[pkgName]
if (!dirName) {
  console.error(`未知包名：${pkgName}（已知：${Object.keys(DIR_MAP).join(', ')}）`)
  process.exit(1)
}
const dir = resolve('packages', dirName)
let pkg
try {
  pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
} catch {
  console.error(`找不到 ${pkgName} 的 package.json（在 ${dir}）`)
  process.exit(1)
}

const name = pkg.name
const version = pkg.version
console.log(`\n=== ${name}@${version} ===`)

/**
 * 查暂存区里是否已有该版本。
 *
 * npm 对「已暂存的版本」再次 `npm stage publish` 会报：
 *   409 Conflict - Cannot stage previously published version "0.7.3"
 *
 * 典型场景：同一个 tag 被推送两次（重打 tag、或误操作），
 * 第一次已经进暂存区，第二次就不该再失败 ——
 * 包其实已经在暂存区等着批准了，用户没受影响。
 */
function versionStaged() {
  try {
    const out = execSync('npm stage list --json', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
    })
    const list = JSON.parse(out)
    const items = Array.isArray(list) ? list : list?.packages ?? []
    return items.some((it) => {
      // `npm stage list --json` 的真实字段：packageName / version
      const n = it?.packageName ?? it?.name ?? it?.package?.name
      const v = it?.version ?? it?.package?.version
      return n === name && v === version
    })
  } catch {
    return false
  }
}

/** 查 registry 上是否已存在该版本。 */
function versionExists() {
  try {
    const out = execSync(`npm view ${name}@${version} version`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
    })
    return out.trim() === version
  } catch {
    // `npm view` 对不存在的版本返回非零退出码
    return false
  }
}

if (!process.env.NODE_AUTH_TOKEN) {
  console.error('缺少 NODE_AUTH_TOKEN 环境变量（GitHub Secrets 里的 NPM_TOKEN）')
  process.exit(1)
}

if (versionExists()) {
  console.log(`✓ ${name}@${version} 已存在于 npm，跳过发布`)
  process.exit(0)
}

// 已暂存但未上线：同样跳过（包在暂存区等着批准，不需要重复 stage）
if (versionStaged()) {
  console.log(`✓ ${name}@${version} 已在 npm 暂存区（等待批准上线），跳过重复暂存`)
  process.exit(0)
}

/**
 * 用哪种方式发布。
 *
 * ## 为什么用 `npm stage publish` 而不是 `npm publish`（2026-10-27）
 *
 * npm 在 2025 收紧了令牌权限：新建的 token 只能拿到
 * **Staged Publish** 类型，直接 `npm publish` 会报：
 *
 *     403 This token can only publish to a staging area.
 *         Run `npm stage publish` ...
 *
 * 这实际上是**更好的流程**：CI 只负责「把包推到暂存区」，
 * 真正的 2FA 批准由维护者在本地 `npm stage approve` 做一次。
 * 2FA 仍然掌握在人手里，而 CI 不需要交互输入 OTP。
 *
 * ## 两种方式都支持
 *
 * - 环境变量 `NPM_USE_STAGE=1` → 强制用 stage
 * - 否则先试普通 publish，遇到 403 staging 错误自动回退到 stage
 */
function runPublish(useStage) {
  const cmd = useStage
    ? 'npm stage publish --access public'
    : 'npm publish --access public'
  execSync(cmd, {
    cwd: dir,
    stdio: 'inherit',
    env: {
      ...process.env,
      // 明确告诉 npm 用这个 token，不要尝试交互式登录
      NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
    },
    timeout: 180000,
  })
}

console.log(`正在发布 ${name}@${version} …`)
const forceStage = process.env.NPM_USE_STAGE === '1'
try {
  runPublish(forceStage)
  console.log(
    forceStage
      ? `✅ ${name}@${version} 已推送到暂存区（需本地 npm stage approve 批准上线）`
      : `✅ ${name}@${version} 发布成功`
  )
} catch (err) {
  // 竞态：两个 job 同时发同一个版本时，后到的会 403。
  // 这种情况再查一次，确认是「已被别人发了」就当作成功。
  if (versionExists()) {
    console.log(`✓ ${name}@${version} 已存在（可能是并发发布），视为成功`)
    process.exit(0)
  }

  const msg = err instanceof Error ? err.message : String(err)
  const isStagingOnly = /only publish to a staging area|stage publish/i.test(msg)

  // 已被暂存（重复触发同一个 tag）：视为成功
  if (/Cannot stage previously published version|409 Conflict/i.test(msg) && versionStaged()) {
    console.log(`✓ ${name}@${version} 已在 npm 暂存区（等待批准上线），视为成功`)
    process.exit(0)
  }

  // 令牌是 Staged Publish 类型：自动回退到 stage 流程
  if (!forceStage && isStagingOnly) {
    console.log('检测到令牌仅支持暂存发布，改用 npm stage publish …')
    try {
      runPublish(true)
      console.log(`✅ ${name}@${version} 已推送到暂存区`)
      console.log('   接下来需在本地执行：npm stage approve <stage-id>')
      process.exit(0)
    } catch (err2) {
      console.error(`❌ 暂存发布也失败：${err2 instanceof Error ? err2.message : String(err2)}`)
      process.exit(1)
    }
  }

  console.error(`❌ 发布失败：${msg}`)
  process.exit(1)
}
