/**
 * 预加载脚本：以 contextBridge 暴露最小 API 给渲染层。
 *
 * 渲染层拿不到 Node 能力，也拿不到令牌明文——
 * 令牌只存在于主进程，UI 只能通过 cred:state 问「有没有」。
 */
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // 部署
  runDeploy: (params: {
    mode: 'auto' | 'fresh' | 'update'
    force: boolean
    newCredentials: boolean
    controlProject: string
    dataProject: string
    panelPath: string
    wsPath: string
  }) => ipcRenderer.invoke('deploy:run', params),
  checkDeployed: () => ipcRenderer.invoke('deploy:check'),

  // 凭据
  saveCredentials: (input: {
    cfToken?: string
    accountId?: string
    kvNamespaceId?: string
    panelPassword?: string
  }) => ipcRenderer.invoke('cred:save', input),
  wipeCredentials: () => ipcRenderer.invoke('cred:wipe'),
  credentialsState: () =>
    ipcRenderer.invoke('cred:state') as Promise<{
      hasToken: boolean
      accountId: string
      kvNamespaceId: string
    }>,

  // 本地真连接优选
  runScan: (params: {
    host: string
    port: number
    wsPath: string
    probePath: string
    skipSpeed: boolean
    sample: number
    top: number
  }) =>
    ipcRenderer.invoke('scan:run', params) as Promise<{
      ok: boolean
      count?: number
      copyable?: string
      error?: string
    }>,

  // 账号与 KV 自动检测
  detectAccount: () =>
    ipcRenderer.invoke('account:detect') as Promise<{
      accountId: string
      accountName: string
      kvId: string
    }>,

  // 应用内更新
  checkUpdate: () =>
    ipcRenderer.invoke('update:check') as Promise<{
      current: string
      latest: string | null
      hasUpdate: boolean
      downloadUrl: string | null
      notes: string
      error?: string
    }>,
  downloadUpdate: (url: string) =>
    ipcRenderer.invoke('update:download', url) as Promise<{ ok: boolean; file: string }>,
  applyUpdate: (file: string) =>
    ipcRenderer.invoke('update:apply', file) as Promise<{ ok: boolean; error?: string }>,

  // 网络环境检测（识别代理工具干扰）
  checkEnvironment: () =>
    ipcRenderer.invoke('env:check') as Promise<{ clean: boolean; findings: string[] }>,

  // 打开外链
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),

  // 日志推送
  onLog: (cb: (entry: { message: string; level: string; at: number }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, entry: { message: string; level: string; at: number }): void =>
      cb(entry)
    ipcRenderer.on('log', listener)
    return () => {
      ipcRenderer.off('log', listener)
    }
  },
  onDeployStatus: (
    cb: (status: { hasDeploy: boolean; build?: string; at?: string; controlProject?: string; dataProject?: string }) => void
  ) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      status: { hasDeploy: boolean; build?: string; at?: string; controlProject?: string; dataProject?: string }
    ): void => cb(status)
    ipcRenderer.on('deploy-status', listener)
    return () => {
      ipcRenderer.off('deploy-status', listener)
    }
  },
  onScanResult: (
    cb: (payload: {
      entries: Array<{ ip: string; port: number; colo: string; latency: number; speed: number }>
      copyable: string
      stats: Record<string, number>
      skippedSpeed?: boolean
    }) => void
  ) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: {
        entries: Array<{ ip: string; port: number; colo: string; latency: number; speed: number }>
        copyable: string
        stats: Record<string, number>
        skippedSpeed?: boolean
      }
    ): void => cb(payload)
    ipcRenderer.on('scan-result', listener)
    return () => {
      ipcRenderer.off('scan-result', listener)
    }
  },
  onUpdateProgress: (cb: (p: { received: number; total: number }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: { received: number; total: number }): void => cb(p)
    ipcRenderer.on('update-progress', listener)
    return () => {
      ipcRenderer.off('update-progress', listener)
    }
  },
}

contextBridge.exposeInMainWorld('cfpilot', api)

export type CFPilotApi = typeof api
