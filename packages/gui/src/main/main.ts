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
  type DeployParams,
  type ScanParams,
} from './bridge'
import { checkForUpdate, downloadUpdate, applyUpdate, cleanupUpdateFiles } from './updater'

// 产物是 CJS，直接用 __dirname（不要用 import.meta.url，esbuild 会告警）
const here: string = __dirname

/**
 * 注意：GPU 加速必须通过**命令行参数**禁用，不能在这里调用
 * `app.disableHardwareAcceleration()`。
 *
 * 原因：Electron 的 GPU 进程在 JS 入口执行之前就已启动
 * （electron/electron#14273：The first JS entry point is too late），
 * 因此代码内调用无效，仍会抛 `GPU process launch failed: error_code=18`。
 *
 * 真正的处理在 scripts/start.mjs：它以 `--disable-gpu-sandbox` 等参数
 * 逐级降级重启 Electron。
 */

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

ipcMain.handle('deploy:run', (_event, params: DeployParams) => runDeploy(mainWindow, params))
ipcMain.handle('deploy:check', () => checkDeployed(mainWindow))

ipcMain.handle('cred:save', (_event, input: Parameters<typeof saveCredentials>[0]) => saveCredentials(input))
ipcMain.handle('cred:wipe', () => wipeCredentials())
ipcMain.handle('cred:state', () => credentialsState())

ipcMain.handle('scan:run', (_event, params: ScanParams) => runScanJob(mainWindow, params))
ipcMain.handle('account:detect', () => detectAccount(mainWindow))

ipcMain.handle('update:check', () => checkForUpdate())
ipcMain.handle('update:download', async (_event, url: string) => {
  const file = await downloadUpdate(url, mainWindow, (received, total) => {
    mainWindow?.webContents.send('update-progress', { received, total })
  })
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
