/**
 * CFPilot GUI 主进程
 *
 * 职责：创建窗口、注册 IPC、把渲染层请求转给 bridge。
 * 所有网络行为只有两类：
 *   1. Cloudflare 官方 API（部署必需）
 *   2. 渲染层用户主动点开的链接（用系统浏览器打开）
 * 不存在任何「把令牌发到第三方」的路径。
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import {
  runDeploy,
  checkDeployed,
  saveCredentials,
  wipeCredentials,
  credentialsState,
  runScanJob,
  detectAccount,
  listKvOptions,
  createKvNamespace,
  checkNetworkEnvironment,
  detectDataPlaneHost,
  detectDataPlanePath,
  listScanCountries,
  type DeployParams,
  type ScanParams,
} from './bridge'
import { checkForUpdate, downloadUpdate, applyUpdate, cleanupUpdateFiles } from './updater'

// 产物是 CJS，直接用 __dirname（不要用 import.meta.url，esbuild 会告警）
const here: string = __dirname

/**
 * GPU 相关的启动开关 —— 必须在创建窗口之前设置。
 *
 * ## 为什么必须放在这里
 *
 * 部分 Windows 环境（远程桌面 / 虚拟机 / 显卡驱动异常）下 Chromium 的 GPU 进程
 * 起不来，报：
 *   `GPU process launch failed: error_code=18`
 *   `FATAL:gpu_data_manager_impl_private.cc GPU process isn't usable. Goodbye.`
 * 然后**整个进程直接退出，窗口根本不出现**。
 * 用户看到的现象是「双击没反应」，很容易误判成缺少管理员权限
 * （提权后安全上下文变化，GPU 沙箱有时恰好能通过，于是形成「必须管理员」的错觉）。
 *
 * ## 为什么不能用 app.disableHardwareAcceleration() 代替
 *
 * 那个 API 只关硬件加速，不关 GPU **沙箱**；而 error_code=18 正是沙箱初始化失败。
 * 两者都要设。
 *
 * ## 适用范围
 *
 * 本工具的界面是纯 DOM + CSS，不用 WebGL / Canvas / 视频，
 * 禁用 GPU 没有任何功能损失，因此**无条件启用**，不开可选项。
 * 这样打包后的 exe 在远程桌面里也能直接双击运行。
 */
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.disableHardwareAcceleration()

/** 单窗口应用：复用同一个 window */
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 820,
    minWidth: 900,
    minHeight: 700,
    title: 'CFPilot 部署与维护工具',
    backgroundColor: '#0d1430',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 只允许 https 外链用系统浏览器打开，站内链接走窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServer = process.env.VITE_DEV_SERVER_URL
  if (devServer) {
    void mainWindow.loadURL(devServer)
  } else {
    void mainWindow.loadFile(join(here, '../renderer/index.html'))
  }
}

/* ---------------- IPC ---------------- */

ipcMain.handle('deploy:run', (_event, params: DeployParams, kvNamespaceId?: string) =>
  runDeploy(mainWindow, params, kvNamespaceId)
)
ipcMain.handle('deploy:check', (_event, kvNamespaceId?: string) =>
  checkDeployed(mainWindow, kvNamespaceId)
)

ipcMain.handle('cred:save', (_event, input: Parameters<typeof saveCredentials>[0]) => saveCredentials(input))
ipcMain.handle('cred:wipe', () => wipeCredentials())
ipcMain.handle('cred:state', () => credentialsState())

ipcMain.handle('scan:run', (_event, params: ScanParams) => runScanJob(mainWindow, params))
ipcMain.handle('env:check', () => checkNetworkEnvironment(mainWindow))
// 自动识别数据面域名（优先自定义域名，回落 pages.dev）
ipcMain.handle('scan:detectHost', () => detectDataPlaneHost(mainWindow))
// 自动识别数据面 WS 路径（读 KV 的 CONFIG，回落环境变量 WS_PATH）
ipcMain.handle('scan:detectPath', () => detectDataPlanePath(mainWindow))
// 优选器支持的国家列表（面板 / CLI / GUI 同源）
ipcMain.handle('scan:countries', () => listScanCountries())
ipcMain.handle('account:detect', () => detectAccount(mainWindow))
ipcMain.handle('kv:list', (_event, accountId: string) => listKvOptions(mainWindow, accountId))
ipcMain.handle('kv:create', (_event, accountId: string, title?: string) =>
  createKvNamespace(mainWindow, accountId, title)
)

ipcMain.handle('update:check', () => checkForUpdate())
ipcMain.handle('update:download', async (_event, url: string) => {
  const file = await downloadUpdate(
    url,
    mainWindow,
    (progress) => {
      // 进度：received / total / 当前源 / 第几次尝试
      mainWindow?.webContents.send('update-progress', progress)
    },
    (message, level) => {
      // 镜像回退过程要让用户看到（软件源域名可能在客户端日志里更可信）
      mainWindow?.webContents.send('log', { message, level, at: Date.now() })
    }
  )
  return { ok: true, file }
})
ipcMain.handle('update:apply', async (_event, file: string) => applyUpdate(file, mainWindow))

ipcMain.handle('app:openExternal', (_event, url: string) => {
  // 仅放行 https，避免被构造出 file:// / 其他协议
  if (/^https:\/\//i.test(url)) return shell.openExternal(url)
  return Promise.resolve()
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
