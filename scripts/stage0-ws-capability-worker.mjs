/**
 * 能力探测用的最小 Worker（不含任何代理代码、不读 KV、不联网）。
 *
 * ## 用途
 *
 * 回答一个纯 API 表面问题：Workers 运行时从 `WebSocketPair` 拿到的 server 端
 * WebSocket，到底有没有 `bufferedAmount` 属性？
 *
 * - 有 → 下行背压可以按「响应式高低水位」实现；
 * - 没有 → 基于该属性的等待逻辑恒等于空操作，只能改为出站读取节流。
 *
 * ## 用法
 *
 *   npx wrangler dev scripts/stage0-ws-capability-worker.mjs --local --port 8787
 *
 * 随后用 WS 客户端连 ws://127.0.0.1:8787/__ws_capability 并发送任意一条消息，
 * 会收到一条 JSON，包含 server 侧 `typeof bufferedAmount` 与实际值。
 * 普通 HTTP 请求返回 200，用于确认服务已起。
 */
export default {
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path !== '/__ws_capability') {
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
    }

    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 })
    }

    const pair = new WebSocketPair()
    const server = pair[1]
    server.accept()

    server.addEventListener('message', () => {
      let value = null
      let type = 'undefined'
      try {
        type = typeof server.bufferedAmount
        value = type === 'number' ? server.bufferedAmount : null
      } catch {
        type = 'throws'
      }
      // 连发若干帧后再采一次：若属性存在，数值应随未消费数据增长
      let afterBurst = null
      try {
        for (let i = 0; i < 8; i++) server.send(new Uint8Array(16 * 1024))
        afterBurst = typeof server.bufferedAmount === 'number' ? server.bufferedAmount : null
      } catch {
        /* 只记录可读到的部分 */
      }
      try {
        server.send(
          JSON.stringify({
            typeofBufferedAmount: type,
            bufferedAmount: value,
            bufferedAmountAfterBurst: afterBurst,
            readyState: server.readyState,
            ownKeys: Object.keys(server),
          })
        )
      } catch {
        /* 客户端已断开 */
      }
    })

    return new Response(null, { status: 101, webSocket: pair[0] })
  },
}
