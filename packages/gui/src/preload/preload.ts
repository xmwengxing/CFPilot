/**
 * 预加载脚本：以 contextBridge 暴露最小 API 给渲染层。
 *
 * 渲染层拿不到 Node 能力，也拿不到令牌明文——
 * 令牌只存在于主进程，UI 只能通过 cred:state 问「有没有」。
 */
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // 部署
  runDeploy: (
    params: {
      mode: 'auto' | 'fresh' | 'update'
      force: boolean
      forceKv: boolean
      newCredentials: boolean
      controlProject: string
      dataProject: string
      panelPath: string
      wsPath: string
    },
    kvNamespaceId?: string
  ) => ipcRenderer.invoke('deploy:run', params, kvNamespaceId),
  checkDeployed: (kvNamespaceId?: string) => ipcRenderer.invoke('deploy:check', kvNamespaceId),

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

  // ---- 多账户（profile）管理 ----
  // 渲染层永远拿不到 Token 明文，只能看到 hasToken 布尔值。
  listProfiles: () => ipcRenderer.invoke('profile:list') as Promise<CFPilotProfileView[]>,
  createProfile: (name?: string) =>
    ipcRenderer.invoke('profile:create', name) as Promise<CFPilotProfileView>,
  updateProfile: (
    id: string,
    patch: {
      name?: string
      cfToken?: string
      accountId?: string
      accountName?: string
      kvNamespaceId?: string
      panelPassword?: string
    }
  ) => ipcRenderer.invoke('profile:update', id, patch) as Promise<{ ok: boolean; error?: string }>,
  deleteProfile: (id: string) =>
    ipcRenderer.invoke('profile:delete', id) as Promise<{ deleted: boolean; activeId: string }>,
  switchProfile: (id: string) =>
    ipcRenderer.invoke('profile:switch', id) as Promise<{ ok: boolean; activeId: string }>,
  currentProfile: () =>
    ipcRenderer.invoke('profile:current') as Promise<CFPilotProfileView | null>,

  // 本地真连接优选
  runScan: (params: {
    host: string
    wsPath: string
    probePath: string
    skipSpeed: boolean
    sample: number
    top: number
    /** 机房国家筛选（可多选，空 = 不筛选） */
    countries?: string[]
    speedMode?: 'auto' | 'probe' | 'url'
    speedUrl?: string
    speedConnections?: number
    speedDurationMs?: number
  }) =>
    ipcRenderer.invoke('scan:run', params) as Promise<{
      ok: boolean
      count?: number
      copyable?: string
      error?: string
    }>,

  /** 自动识别数据面域名（优先自定义域名，回落 pages.dev） */
  detectScanHost: () =>
    ipcRenderer.invoke('scan:detectHost') as Promise<{
      ok: boolean
      host?: string
      source?: 'custom' | 'pages'
      error?: string
    }>,

  /** 自动识别数据面 WS 路径（读 KV 的 CONFIG，回落环境变量 WS_PATH） */
  detectScanPath: () =>
    ipcRenderer.invoke('scan:detectPath') as Promise<{
      ok: boolean
      path?: string
      source?: 'kv' | 'env'
      error?: string
    }>,

  /** 优选器支持的国家列表（与面板 / 命令行版同源） */
  listScanCountries: () =>
    ipcRenderer.invoke('scan:countries') as Promise<Array<{ code: string; name: string }>>,

  // 账号与 KV
  detectAccount: () =>
    ipcRenderer.invoke('account:detect') as Promise<{
      accountId: string
      accountName: string
    }>,

  /** 列出账号下的 KV 候选（供用户选择归属） */
  listKvOptions: (accountId: string) =>
    ipcRenderer.invoke('kv:list', accountId) as Promise<{
      options: Array<{
        id: string
        title: string
        ownership: 'instance' | 'foreign' | 'cfpilot' | 'empty'
        controlProject?: string
        dataProject?: string
        at?: string
        build?: string
        controlSubdomain?: string
        dataSubdomain?: string
      }>
    }>,

  /** 新建 KV 命名空间（用于部署新的实例） */
  createKvNamespace: (accountId: string, title?: string) =>
    ipcRenderer.invoke('kv:create', accountId, title) as Promise<{
      id: string
      title: string
    } | null>,

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
    cb: (status: {
      hasDeploy: boolean
      state: 'none' | 'outdated' | 'latest' | 'blocked'
      reason?: 'no-token' | 'no-account' | 'no-kv'
      build?: string
      localBuild?: string
      at?: string
      controlProject?: string
      dataProject?: string
      controlSubdomain?: string
      dataSubdomain?: string
    }) => void
  ) => {
    type S = Parameters<typeof cb>[0]
    const listener = (_e: Electron.IpcRendererEvent, status: S): void => cb(status)
    ipcRenderer.on('deploy-status', listener)
    return () => {
      ipcRenderer.off('deploy-status', listener)
    }
  },
  onScanResult: (
    cb: (payload: {
      entries: Array<{ ip: string; port: number; colo: string; latency: number; tlsMs: number; speed: number }>
      copyable: string
      stats: Record<string, number>
      skippedSpeed?: boolean
    }) => void
  ) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: {
        entries: Array<{ ip: string; port: number; colo: string; latency: number; tlsMs: number; speed: number }>
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
  onUpdateProgress: (
    cb: (p: { received: number; total: number; source: string; attempt: number }) => void
  ) => {
    type P = { received: number; total: number; source: string; attempt: number }
    const listener = (_e: Electron.IpcRendererEvent, p: P): void => cb(p)
    ipcRenderer.on('update-progress', listener)
    return () => {
      ipcRenderer.off('update-progress', listener)
    }
  },
}

contextBridge.exposeInMainWorld('cfpilot', api)

export type CFPilotApi = typeof api
