/**
 * Windows 产物代码签名（Authenticode）。
 *
 * ## 为什么需要
 *
 * 未签名的 exe 云信誉天然偏低：用户下载刚发布的版本时，SmartScreen 会提示
 * 「未知发布者」，部分安全软件还会按启发式直接判毒（本项目实测过
 * `Trojan:Win32/Sonbokli.A!cl`）。签名解决两件事：
 *
 *  1. 用户能看到「发布者：<公司名>」，而不是「未知发布者」；
 *  2. 信誉按**证书主体**累积，而不是按每个新文件的哈希从零开始。
 *
 * ## 为什么在 Linux CI 上签
 *
 * 发布流水线跑在 ubuntu-latest，没有 Windows SDK 的 signtool，
 * 因此 Linux / macOS 用 `osslsigncode`（apt install osslsigncode），
 * Windows 本机用 signtool。两者产出同一种 Authenticode 签名。
 *
 * ## 证书从哪来
 *
 * 只认环境变量，不落任何密钥到仓库：
 *
 *  - `CFPILOT_WIN_CERT_PFX_BASE64` —— PFX 的 base64（CI 里放 secrets）
 *  - `CFPILOT_WIN_CERT_PASSWORD` —— PFX 密码
 *  - 或 `CFPILOT_WIN_CERT_PFX` —— 本机 PFX 路径
 *
 * 没配置就**跳过并提示**，不阻断发布：签名是加固项，缺证书不该让发版挂掉。
 *
 * ## 顺序纪律（很重要）
 *
 * 签名改的是 exe 字节，因此必须满足两条：
 *
 *  1. 签名发生在**生成摘要清单之前** —— 否则 `cfpilot-desktop-SHA256SUMS`
 *     记的是签名前的哈希，应用内更新会一律校验失败；
 *  2. 便携包 zip 必须在签名**之后**重打 —— 否则 zip 里装的是未签名的 exe，
 *     用户解压出来的还是「未知发布者」。
 *
 * 这两条都在本脚本里完成，调用方只要保证它排在摘要清单之前即可。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '..')
const dist = join(repoRoot, 'packages', 'desktop', 'dist')

// RFC3161 时间戳：证书到期后签名仍然有效。
// 主机不可达时签名会失败 —— 换备用主机重试一次，两个都不行就报错退出
// （宁可让发布失败，也不要产出「没有时间戳」的签名：证书一换就得重签）。
const TIMESTAMP_URLS = ['http://timestamp.digicert.com', 'http://timestamp.sectigo.com']

const log = (m) => console.log(`[sign] ${m}`)

function readCert() {
  const b64 = process.env.CFPILOT_WIN_CERT_PFX_BASE64?.trim()
  const pfxPath = process.env.CFPILOT_WIN_CERT_PFX?.trim()
  const password = process.env.CFPILOT_WIN_CERT_PASSWORD ?? ''
  if (b64) {
    const dir = mkdtempSync(join(tmpdir(), 'cfp-sign-'))
    const file = join(dir, 'cert.pfx')
    writeFileSync(file, Buffer.from(b64, 'base64'))
    return { pfx: file, password, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }
  if (pfxPath && existsSync(pfxPath)) {
    return { pfx: pfxPath, password, cleanup: () => {} }
  }
  return null
}

function has(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 找签名工具：Windows 用 signtool，其它平台用 osslsigncode。 */
function findSigner() {
  if (process.platform === 'win32') {
    // signtool 不在 PATH 里（Windows SDK 装在 Program Files），探测最近的 x64 版本
    const kitRoot = 'C:/Program Files (x86)/Windows Kits/10/bin'
    if (existsSync(kitRoot)) {
      const versions = readdirSync(kitRoot)
        .filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
        .reverse()
      for (const v of versions) {
        const p = join(kitRoot, v, 'x64', 'signtool.exe').replace(/\//g, '\\')
        if (existsSync(p)) return { kind: 'signtool', cmd: p }
      }
    }
    if (has('signtool', ['/?']) || has('where', ['signtool'])) return { kind: 'signtool', cmd: 'signtool' }
  }
  if (has('osslsigncode', ['--version'])) return { kind: 'osslsigncode', cmd: 'osslsigncode' }
  return null
}

function signWithSigntool(tool, pfx, password, file) {
  for (const ts of TIMESTAMP_URLS) {
    try {
      execFileSync(tool, [
        'sign', '/fd', 'sha256', '/td', 'sha256', '/tr', ts,
        '/f', pfx, '/p', password, '/d', 'CFPilot', file,
      ], { stdio: 'pipe' })
    } catch (err) {
      log(`  签名失败（时间戳 ${ts}）：${String(err.stderr ?? err).trim().slice(0, 200)}`)
      continue
    }
    verifySigner(tool, file)
    return ts
  }
  throw new Error(`签名失败：${file}`)
}

/**
 * 签名后自检。
 *
 * 判定要分清两种情况：
 *  - 「没有签名 / 签名数据损坏」= 我们的问题，必须失败；
 *  - 「证书链不受信任」= 本机没装该证书的根，自签证书必然如此，
 *    不能因此让发布失败（公信 CA 证书在 CI 上不会走到这里）。
 */
function verifySigner(tool, file) {
  try {
    execFileSync(tool, ['verify', '/pa', file], { stdio: 'pipe' })
  } catch (err) {
    const msg = String(err.stdout ?? '') + String(err.stderr ?? '')
    if (/No signature found|cannot be decoded|is not signed|invalid signature/i.test(msg)) {
      throw new Error(`签名后自检失败（产物未携带有效签名）：${file}`)
    }
    log('  ⚠ 签名已写入，但本机无法校验证书链（自签证书或未安装根证书时属正常）')
  }
}

function signWithOsslsigncode(tool, pfx, password, file) {
  const out = file + '.signed'
  for (const ts of TIMESTAMP_URLS) {
    rmSync(out, { force: true })
    try {
      execFileSync(tool, [
        'sign', '-pkcs12', pfx, '-pass', password, '-n', 'CFPilot',
        '-h', 'sha256', '-ts', ts, '-in', file, '-out', out,
      ], { stdio: 'pipe' })
      copyFileSync(out, file)
      rmSync(out, { force: true })
      return ts
    } catch (err) {
      rmSync(out, { force: true })
      log(`  签名失败（时间戳 ${ts}）：${String(err.stderr ?? err).trim().slice(0, 200)}`)
      continue
    }
    // osslsigncode 只有真的写出签名才会返回 0，这里再确认文件非空。
    if (!existsSync(file) || statSync(file).size === 0) {
      throw new Error(`签名后产物异常：${file}`)
    }
    return ts
  }
  throw new Error(`签名失败：${file}`)
}

/** 签名后重打便携包：zip 里的 exe 必须是已签名的版本。 */
function rebuildLoaderZip(exePath) {
  const dir = join(dist, '.sign-zip-stage')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const exeName = exePath.split(/[\\/]/).pop()
  copyFileSync(exePath, join(dir, exeName))
  const dll = join(dist, 'cfpilot-webview2loader-windows-amd64.dll')
  if (!existsSync(dll)) {
    rmSync(dir, { recursive: true, force: true })
    return
  }
  copyFileSync(dll, join(dir, 'WebView2Loader.dll'))
  const zip = join(dist, exeName.replace(/\.exe$/, '') + '+loader.zip')
  rmSync(zip, { force: true })
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path '${join(dir, '*')}' -DestinationPath '${zip}' -Force`,
    ], { stdio: 'pipe' })
  } else {
    execFileSync('zip', ['-j', '-q', zip, join(dir, exeName), join(dir, 'WebView2Loader.dll')], { stdio: 'pipe' })
  }
  rmSync(dir, { recursive: true, force: true })
  log(`  便携包已按签名后的 exe 重打：${zip.split(/[\\/]/).pop()} (${(statSync(zip).size / 1024).toFixed(0)} KB)`)
}

function main() {
  if (!existsSync(dist)) {
    log('没有 dist 目录，跳过')
    return
  }
  const cert = readCert()
  if (!cert) {
    log('未配置签名证书（CFPILOT_WIN_CERT_PFX_BASE64 / CFPILOT_WIN_CERT_PFX），跳过签名')
    log('提示：未签名的 exe 会显示「未知发布者」，SmartScreen 与部分安全软件会更激进')
    return
  }
  const signer = findSigner()
  if (!signer) {
    log('找不到签名工具（Windows 需 signtool，Linux/macOS 需 osslsigncode），跳过签名')
    return
  }

  // 只签**当前版本**的 Windows 可执行产物：普通版 exe、+mesh 安装器。
  //
  // 按版本号精确匹配，不按通配符：dist 里常留有历史版本的 exe，
  // 无差别签名会把它们一并改掉，之后上传/算清单时真假难辨。
  // DLL 不签（微软已签），deb/apk/dmg 各有自己的机制。
  const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
  const wanted = [
    `cfpilot-${version}-windows-amd64.exe`,
    `cfpilot-${version}+mesh-windows-amd64-setup.exe`,
  ]
  const targets = wanted.map((n) => join(dist, n)).filter((p) => existsSync(p))

  if (targets.length === 0) {
    log('dist 里没有 Windows exe，跳过')
    cert.cleanup()
    return
  }

  log(`使用 ${signer.kind} 签名 ${targets.length} 个产物`)
  try {
    for (const file of targets) {
      const name = file.split(/[\\/]/).pop()
      const ts =
        signer.kind === 'signtool'
          ? signWithSigntool(signer.cmd, cert.pfx, cert.password, file)
          : signWithOsslsigncode(signer.cmd, cert.pfx, cert.password, file)
      log(`✅ ${name}（时间戳 ${ts}）`)
      if (/-windows-amd64\.exe$/.test(name) && !name.includes('+mesh')) {
        rebuildLoaderZip(file)
      }
    }
  } finally {
    cert.cleanup()
  }
  log('完成。摘要清单必须在本次运行之后生成。')
}

main()
