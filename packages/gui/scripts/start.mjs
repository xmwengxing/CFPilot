/**
 * 启动 CFPilot GUI。
 *
 * 为什么不直接写 `electron .`：
 *   npm 的 lifecycle script 通过 cmd.exe 执行，`electron` 依赖 PATH 能解析到
 *   node_modules/.bin。Windows 上 workspace 提升后 .bin 在**根** node_modules，
 *   在子包目录跑经常找不到。
 *
 *   这里直接定位本机真实的 electron 可执行文件并 spawn，
 *   路径按 workspace 提升的几种可能逐一尝试。
 *
 * 自动降级：
 *   第一次不带参数启动；若因 GPU 进程起不来而退出（Chromium 打印
 *   `GPU process isn't usable. Goodbye.` 并以 2147483651 退出），
 *   就带上 --disable-gpu --disable-software-rasterizer 再试一次。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const guiDir = resolve(here, '..')
const repoRoot = resolve(guiDir, '../..')

/** 候选的 electron 可执行文件位置（workspace 提升后通常在根） */
const candidates = [
  resolve(repoRoot, 'node_modules/electron/dist/electron.exe'),
  resolve(guiDir, 'node_modules/electron/dist/electron.exe'),
  resolve(repoRoot, 'node_modules/.bin/electron.cmd'),
  resolve(guiDir, 'node_modules/.bin/electron.cmd'),
]

const exe = candidates.find((p) => existsSync(p))
if (!exe) {
  console.error('未找到 Electron 可执行文件，请先执行 npm install')
  console.error('试过：')
  for (const c of candidates) console.error('  ' + c)
  process.exit(1)
}

// 诊断信息：帮助区分「GUI 真的失败了」与「运行环境不允许建窗口」
const session = process.env.SESSIONNAME || '(未设置)'
console.log('启动 GUI：' + exe)
console.log('应用目录：' + guiDir)
console.log('当前会话：' + session + (session ? '' : '  ← 空，可能在 Session 0（服务会话），该会话禁止创建窗口'))

/**
 * 启动参数组合。
 *
 * 为什么必须用命令行参数而不是 `app.disableHardwareAcceleration()`：
 *   Electron 的 GPU 进程在 JS 入口执行**之前**就已启动（electron#14273 明确
 *   指出 "The first JS entry point is too late"），所以代码里调用无效。
 *   必须通过命令行开关让 Chromium 在初始化阶段就禁用 GPU。
 *
 * `--disable-gpu-sandbox` 是关键：Windows 上 GPU 进程跑在沙箱里，
 * RDP / 虚拟机 / 驱动异常时沙箱初始化失败即报 error_code=18
 * （见 electron#36698 与 StackOverflow 的同名问题）。
 */
const attempts = [
  {
    label: '默认（硬件加速）',
    args: [],
  },
  {
    label: '禁用 GPU 沙箱',
    args: ['--disable-gpu-sandbox'],
  },
  {
    label: '禁用 GPU 沙箱 + 软件渲染',
    args: ['--disable-gpu-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--disable-gpu-compositing'],
  },
  {
    label: '关闭全部沙箱 + 软件渲染',
    args: ['--no-sandbox', '--disable-gpu-sandbox', '--disable-gpu', '--disable-software-rasterizer'],
  },
]

let attemptIndex = 0

function launch() {
  const attempt = attempts[attemptIndex]
  if (attemptIndex > 0) {
    console.log('')
    console.log('↻ 改用' + attempt.label + '重试…')
  }
  const child = spawn(exe, [guiDir, ...attempt.args], {
    cwd: guiDir,
    stdio: 'inherit',
    windowsHide: false,
  })

  child.on('error', (err) => {
    console.error('启动失败：' + err.message)
    process.exit(1)
  })

  child.on('exit', (code) => {
    // GPU 进程起不来时 Chromium 以 2147483651 退出；
    // 这类失败在换一组参数后可能成功，因此逐级降级重试。
    const gpuFailure = code === 2147483651

    if (gpuFailure && attemptIndex < attempts.length - 1) {
      attemptIndex++
      launch()
      return
    }

    if (gpuFailure) {
      console.error('')
      console.error('GUI 未能启动（退出码 2147483651），已尝试全部降级组合：')
      for (const a of attempts) console.error('  · ' + a.label)
      console.error('')
      console.error('该错误通常来自 GPU 进程无法启动，常见于：')
      console.error('  1. 远程桌面 / 虚拟机 —— 缺少图形加速支持（可加 --disable-gpu-sandbox）')
      console.error('  2. 显卡驱动异常 —— 更新或回退驱动')
      console.error('  3. 第三方安全软件拦截 —— 临时关闭其应用沙箱/隔离功能')
      console.error('')
      console.error('若确认是本机环境限制，可改用 WebView2 版本（体积更小、无 GPU 依赖）。')
      process.exit(code)
    }
    if (code && code !== 0) {
      console.error('GUI 退出，代码 ' + code)
    }
    process.exit(code ?? 0)
  })
}

launch()
