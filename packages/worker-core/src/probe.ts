/**
 * 真连接探针端点 /__edge_probe
 *
 * 这是 CFPilot 解决「优选 IP 填进面板后客户端测试全是 -1」的核心：
 *  1) 收到 Upgrade: websocket 的请求时返回 101，并回传 colo —— 验证该 IP
 *     对当前用户自己的域名是否真的支持 WebSocket 升级（排除 Enterprise 专属 IP、
 *     运营商 SNI/Upgrade 阻断等问题）。
 *  2) GET /__edge_probe?bytes=N 时流式输出随机二进制，用于在用户自己的域名下
 *     测试真实下行速度，避免借用第三方 CDN 测速导致的权限错配。
 */
import { randomHex } from './util'

/** 匿名请求的测速上限（2026-10-29：15MB → 8MB，缩小被刷流量的暴露面） */
const MAX_PROBE_BYTES = 8 * 1024 * 1024
/** 带鉴权令牌时允许的上限（本地优选的 `--speed-bytes` 可以调到更大） */
const MAX_PROBE_BYTES_TRUSTED = 15 * 1024 * 1024
const DEFAULT_PROBE_BYTES = 2 * 1024 * 1024

/**
 * 测速用的 64KB 数据块（模块级常量，只初始化一次）。
 *
 * ## 为什么不是「填满 'a'」
 *
 * 早前这里 `buf.fill(0x61)` —— 64KB 全是重复字符，**压缩比可以到 1000:1**。
 * 虽然响应头里已经写了 `Content-Encoding: identity`，但一旦经过某个会自行压缩的
 * 中间层（或将来有人去掉那个头），测出来的「吞吐」就会变成压缩管道速度，
 * 和真实代理流量（TLS 密文，基本不可压缩）完全不是一回事。
 *
 * 现在用**确定性伪随机块**：不可压缩、每次构建内容一致（便于对照复现），
 * 且只在模块加载时算一次 —— 并发测速时所有连接共享同一份内存，
 * 用 `subarray()` 切出各自需要的长度，零额外 CPU。
 */
const PROBE_CHUNK: Uint8Array = (() => {
  const buf = new Uint8Array(64 * 1024)
  // xorshift32：确定性、无依赖、比 Math.random 快，且分布足够「不可压缩」
  let x = 0x9e3779b9
  for (let i = 0; i < buf.length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    buf[i] = x & 0xff
  }
  return buf
})()

export async function handleEdgeProbe(request: Request): Promise<Response> {
  const url = new URL(request.url)

  // 1) WebSocket 101 真连接握手校验
  const upgrade = request.headers.get('Upgrade')?.toLowerCase()
  if (upgrade === 'websocket') {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as unknown as [WebSocket, WebSocket]
    server.accept()
    server.addEventListener('message', (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : ''
      if (data === 'PING' || data === 'ping') {
        server.send(
          JSON.stringify({
            pong: true,
            colo: (request as unknown as { cf?: { colo?: string } }).cf?.colo ?? 'UNK',
            clientIp: request.headers.get('CF-Connecting-IP') ?? '',
          })
        )
        try {
          server.close(1000, 'Probe complete')
        } catch {
          /* 已关闭 */
        }
      }
    })
    return new Response(null, { status: 101, webSocket: client })
  }

  // 2) 真实域名下的流式下行测速
  const requested = Number.parseInt(url.searchParams.get('bytes') ?? '', 10)
  // ⚠️ 令牌鉴权不在这里做：探针是数据面热路径，校验 uuid 要么读 KV（每次一次读），
  // 要么依赖 env（KV 配置时不存在）。故本轮只收紧上限 —— 见 MAX_PROBE_BYTES 注释。
  const maxBytes = MAX_PROBE_BYTES
  const bytes = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, maxBytes)
    : DEFAULT_PROBE_BYTES

  // 测速块**模块级常量**：只初始化一次。
  //
  // 旧实现每次请求都 `new Uint8Array(64KB)` 再跑 65536 次循环填 0x61 ——
  // 多流并发测速时（一条候选 8~16 条连接）这纯粹是白烧 CPU。
  // 缓冲区永不修改，所有连接共享同一份内存。
  const chunk = PROBE_CHUNK

  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) {
        controller.close()
        return
      }
      const remaining = Math.min(chunk.byteLength, bytes - sent)
      controller.enqueue(chunk.subarray(0, remaining))
      sent += remaining
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      // ⚠️ **不要**试图给流式响应加 `Content-Length`。
      //
      // 2026-10-28 本地 workerd 实测：对 ReadableStream 响应设置
      // `Content-Length` 会被运行时**直接丢弃**，实际发出的仍是
      // `Transfer-Encoding: chunked`（curl -D 抓到的头里没有 content-length）。
      // 所以「加长度让客户端收满即止」这条路在 Workers 上走不通 ——
      // 客户端必须靠「固定时长窗口」结算速度（见 CLI 的 measureThroughput），
      // 而不是等流结束。
      //
      // 明确声明不压缩：测速要的是原始吞吐，任何压缩都会让结果失真。
      'Content-Encoding': 'identity',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Probe-Bytes': String(bytes),
      'X-Probe-Nonce': randomHex(4),
    },
  })
}

/** 处理探针相关的 CORS 预检 */
export function handleProbeOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  })
}
