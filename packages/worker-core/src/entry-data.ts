/**
 * 数据面入口：VLESS/Trojan over WebSocket + XHTTP + 真连接探针。
 *
 * 不含面板与订阅，部署在用户实际连接的域名上。
 * 与控制面分开部署的原因见 `routes/control.ts` 顶部说明。
 *
 * ## ⚠️ Workers 通道：必须注入 `request.fetcher.connect`
 *
 * 真机实测（2026-10-24，两个账号，同一份字节内容、同一时刻）：
 *
 * | connect 来源                                     | Pages  | Workers  |
 * |--------------------------------------------------|--------|----------|
 * | `import { connect } from 'cloudflare:sockets'`   | 200 ✅ | **522** ❌ |
 * | `request.fetcher.connect(...)`                   | 200 ✅ | **200** ✅ |
 *
 * 静态导入 `cloudflare:sockets` 会让 Workers 的 isolate **在启动阶段就失败**，
 * 对外表现为 HTTP 522（边缘拿不到 Worker 的响应，控制台也看不到运行日志）。
 * 同类项目 edgetunnel 能稳定跑在 Workers 上，正因为它从不 import sockets，
 * 而是走 `request.fetcher.connect()`。
 *
 * 因此这里在**每个请求**里优先用 fetcher 注入；
 * Pages 上 `request.fetcher` 不存在，自动回落到 `cloudflare:sockets`。
 */
import type { Env } from './types'
import { routeDataPlane } from './routes/data'
import { neutralPage } from './ui/neutral'
import { VERSION_PATH, versionResponse } from './version'
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

/**
 * 把 `request.fetcher.connect` 注入出站拨号层。
 *
 * 为什么每次请求都做：`connectOverride` 是 isolate 级状态，
 * 而 `request.fetcher` 是**逐请求**对象 —— 显式重设成本极低、语义更干净。
 *
 * 拿不到 fetcher（Pages / 本地 workerd）时清除覆盖，
 * 让 `getConnect()` 回落到 `cloudflare:sockets`，即 Pages 的正常路径。
 */
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

  // ⚠️ 同时把 dial 挂到 globalThis，供 `websocket-self` 的 `resolveDial()` 取用。
  //
  // 为什么必须这样做：`websocket-self` **不能**静态 `import { dial } from
  // '../outbound/dial'` —— 静态依赖会让 Workers 通道的 isolate 启动失败
  // （HTTP 522），而 Pages 通道完全正常（真机对照见 `websocket-self.ts` 文件头）。
  //
  // 这里在入口完成注入，本模块的 `outbound/dial` 就只在**数据面入口**这
  // 一层被静态引用，深层模块保持零静态依赖 —— 这正是 edgetunnel 稳定跑在
  // Workers 上的做法。
  const g = globalThis as unknown as { __cfpDial?: DialLike }
  if (typeof g.__cfpDial !== 'function') {
    // 动态 import 的结果缓存住，避免每次请求重复加载
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
  async fetch(
    request: Request,
    env: Env,
    ctx?: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> {
    try {
      // 必须早于任何出站调用
      installConnect(request)

      if (new URL(request.url).pathname === VERSION_PATH) return versionResponse()
      return (await routeDataPlane(request, env, ctx)) ?? neutralPage(200)
    } catch {
      return neutralPage(500)
    }
  },
}
