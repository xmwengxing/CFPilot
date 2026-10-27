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
  'cfpilot-scanner': 'scanner-cli',
  'cfpilot-deploy': 'deploy-wizard',
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

console.log(`正在发布 ${name}@${version} …`)
try {
  execSync('npm publish --access public', {
    cwd: dir,
    stdio: 'inherit',
    env: {
      ...process.env,
      // 明确告诉 npm 用这个 token，不要尝试交互式登录
      NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
    },
    timeout: 180000,
  })
  console.log(`✅ ${name}@${version} 发布成功`)
} catch (err) {
  // 竞态：两个 job 同时发同一个版本时，后到的会 403。
  // 这种情况再查一次，确认是「已被别人发了」就当作成功。
  if (versionExists()) {
    console.log(`✓ ${name}@${version} 已存在（可能是并发发布），视为成功`)
    process.exit(0)
  }
  console.error(`❌ 发布失败：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
