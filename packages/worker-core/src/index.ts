/**
 * CFPilot Worker 内核 —— 单一部署入口（控制面 + 数据面）。
 *
 * 路由顺序：
 *   1. 控制面：/__edge_probe、/api/v1/*、/sub/<token>、/<panelPath>
 *   2. 数据面：VLESS-WS / Trojan-WS / VLESS-XHTTP
 *
 * ## 单 Worker 合并部署（Workers 通道）
 *
 * 真机结论（2026-10-24）：**合并版可以在 Workers 上跑通**，
 * 前提是不使用静态 `import { connect } from 'cloudflare:sockets'`
 * —— 静态导入会让 isolate 启动失败（对外 HTTP 522）。
 * 详见 `entry-data.ts` 顶部与 `scripts/build.mjs` 的 `vendorSocketsShim`。
 *
 * 因此这里与数据面入口一样，在每个请求里注入 `request.fetcher.connect`。
 * Pages 通道上 `request.fetcher` 不存在，自动回落到 `cloudflare:sockets`。
 */
import type { Env } from './types'
import { routeControlPlane } from './routes/control'
import { routeDataPlane } from './routes/data'
import { neutralPage } from './ui/neutral'
import { setConnectOverride } from './outbound/dial'
import type { DialLike } from './protocols/websocket-self'

/** `request.fetcher.connect` 的参数形状（与 SocketOptions 一致） */
interface SocketOptionsLike {
  secureTransport?: 'off' | 'on' | 'starttls'
  allowHalfOpen?: boolean
}

/** `request.fetcher` 的最小形状（只用到 connect） */
interface RequestFetcher {
  connect?: (
    address: { hostname: string; port: number },
    options?: SocketOptionsLike
  ) => unknown
}

/** 注入出站 connect（Workers 用 fetcher；Pages 回落 sockets） */
function installConnect(request: Request): void {
  const fetcher = (request as unknown as { fetcher?: RequestFetcher }).fetcher
  const fn = fetcher?.connect
  if (typeof fn === 'function') {
    const bound = fn.bind(fetcher) as NonNullable<RequestFetcher['connect']>
    setConnectOverride(
      ((address: { hostname: string; port: number }, options?: SocketOptionsLike) =>
        options === undefined ? bound(address) : bound(address, options)) as never
    )
  } else {
    setConnectOverride(null)
  }

  // 同时注入 dial，避免 `websocket-self` 静态依赖 outbound/dial
  // （静态依赖会让 Workers 通道 522，详见 `websocket-self.ts` 文件头）
  const g = globalThis as unknown as { __cfpDial?: DialLike }
  if (typeof g.__cfpDial !== 'function') {
    dialPromise ??= (async () => {
      const mod = (await import('./outbound/dial')) as { dial: DialLike }
      return mod.dial
    })()
    void dialPromise.then((dial) => {
      const cur = globalThis as unknown as { __cfpDial?: DialLike }
      if (typeof cur.__cfpDial !== 'function') cur.__cfpDial = dial
    })
  }
}

/** 拨号模块的加载 Promise（isolate 内只加载一次） */
let dialPromise: Promise<DialLike> | null = null

export default {
  /**
   * 捕获路由调用中的异常；不覆盖模块初始化、后台任务或响应流阶段的错误。
   */
  async fetch(
    request: Request,
    env: Env,
    ctx?: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> {
    try {
      // 必须早于任何出站调用
      installConnect(request)

      return (
        (await routeControlPlane(request, env)) ??
        (await routeDataPlane(request, env, ctx)) ??
        neutralPage(200)
      )
    } catch {
      return neutralPage(500)
    }
  },
}
