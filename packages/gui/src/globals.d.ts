/**
 * 跨包动态导入的类型垫片。
 *
 * bridge.ts 在运行时按多个候选路径动态 import deploy-wizard 的源码
 * （开发时走 TS 源码，打包后走 dist）。tsc 无法解析这些猜测路径，
 * 这里用模块声明让类型检查通过，运行时由 esbuild 打包成真实 import。
 */
declare module '../../deploy-wizard/src/pages-deploy' {
  export function deployPagesSplit(options: {
    token: string
    accountId: string
    kvNamespaceId: string
    controlProject: string
    dataProject: string
    panelPath: string
    panelPassword: string
    uuid: string
    trojanPassword: string
    wsPath: string
    enableTrojan: boolean
    enableXhttp: boolean
    mode?: 'auto' | 'fresh' | 'update'
    keepCredentials?: boolean
    skipSameVersion?: boolean
    localBuild?: string
    bundles?: { control?: string; data?: string }
    wait?: { timeoutMs: number; intervalMs: number }
    log?: (m: string) => void
  }): Promise<{
    control: { name: string; subdomain: string; deploymentId?: string }
    data: { name: string; subdomain: string; deploymentId?: string }
    panelPath?: string
    uuid?: string
    wsPath?: string
    warnings: string[]
  }>
}

declare module '../../deploy-wizard/src/cf-api' {
  export class CloudflareClient {
    constructor(options: { token: string; apiBase?: string })
    getKvValue(accountId: string, namespaceId: string, key: string): Promise<string | null>
  }
}

/** 渲染层的 window.cfpilot（由 preload 通过 contextBridge 注入） */
interface CFPilotLogEntry {
  message: string
  level: string
  at: number
}

interface CFPilotDeployStatus {
  hasDeploy: boolean
  build?: string
  at?: string
  controlProject?: string
  dataProject?: string
}

/**
 * KV 候选列表项。
 *
 * ownership 标明该命名空间当前归谁，供界面提示用户选择。
 */
interface CFPilotKvOption {
  id: string
  title: string
  ownership: 'instance' | 'cfnext' | 'cfpilot' | 'empty'
  controlProject?: string
  dataProject?: string
  at?: string
  build?: string
  controlSubdomain?: string
  dataSubdomain?: string
}

interface Window {
  cfpilot: {
    runDeploy(
      params: {
        mode: 'auto' | 'fresh' | 'update'
        force: boolean
        forceKv: boolean
        newCredentials: boolean
        controlProject: string
        dataProject: string
        panelPath: string
        wsPath: string
        dataPlane: 'self' | 'vendor'
      },
      kvNamespaceId?: string
    ): Promise<{ ok: boolean; error?: string }>
    checkDeployed(kvNamespaceId?: string): Promise<void>
    runScan(params: {
      host: string
      port: number
      wsPath: string
      probePath: string
      skipSpeed: boolean
      sample: number
      top: number
      speedMode?: 'auto' | 'probe' | 'url'
      speedUrl?: string
      speedConnections?: number
      speedDurationMs?: number
    }): Promise<{ ok: boolean; count?: number; copyable?: string; error?: string }>
    detectAccount(): Promise<{ accountId: string; accountName: string }>
    listKvOptions(accountId: string): Promise<{
      options: CFPilotKvOption[]
    }>
    createKvNamespace(accountId: string, title?: string): Promise<{ id: string; title: string } | null>
    checkEnvironment(): Promise<{ clean: boolean; findings: string[] }>
    saveCredentials(input: {
      cfToken?: string
      accountId?: string
      kvNamespaceId?: string
      panelPassword?: string
    }): Promise<{ saved: boolean }>
    wipeCredentials(): Promise<{ wiped: boolean }>
    credentialsState(): Promise<{ hasToken: boolean; accountId: string; kvNamespaceId: string }>
    openExternal(url: string): Promise<void>
    onLog(cb: (entry: CFPilotLogEntry) => void): () => void
    onDeployStatus(cb: (status: CFPilotDeployStatus) => void): () => void
    onScanResult(cb: (payload: CFPilotScanResult) => void): () => void
    onUpdateProgress(cb: (p: { received: number; total: number }) => void): () => void
    checkUpdate(): Promise<{
      current: string
      latest: string | null
      hasUpdate: boolean
      downloadUrl: string | null
      notes: string
      error?: string
    }>
    downloadUpdate(url: string): Promise<{ ok: boolean; file: string }>
    applyUpdate(file: string): Promise<{ ok: boolean; error?: string }>
  }
}

interface CFPilotScanResult {
  entries: Array<{ ip: string; port: number; colo: string; latency: number; speed: number }>
  copyable: string
  stats: Record<string, number>
  skippedSpeed?: boolean
}
