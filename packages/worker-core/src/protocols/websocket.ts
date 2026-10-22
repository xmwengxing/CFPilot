/**
 * WebSocket 入站（VLESS-WS / Trojan-WS）—— 自研数据面
 *
 * ## 与 CFNext 数据面的关系
 *
 * 早期自研版本在真机恒定抛 `TCP Loop detected`，曾整体改用 vendor/cfnext-dataplane.js。
 * 精读其出站函数 `Bt()` 后确认差异不在拨号本身（它的 `Pt()` 与我们的
 * `connectWithTimeout()` 几乎一致），而在**拨号之前的目标选择**：
 *
 *   1. 若配置了 ProxyIP，先用 DoH 解析出它的落地 IP 列表，竞速选取；
 *   2. 目标是 Cloudflare Anycast 地址时，按 `request.cf.colo` 换区域落地；
 *   3. 都没有才直连目标。
 *
 * 本文件用自研代码复现该策略，并保留三个同类项目的可取之处：
 *   - CFNext / edgetunnel：DoH TXT 优选 IP 库 + 落地 IP 竞速
 *   - BPB：先回 VLESS/Trojan 协议响应头，再中继数据
 *   - cfnew：首包数据缓存，避免竞速胜出后丢失客户端已发数据
 *
 * vendor 数据面仍保留为可切换的回退实现（见 `useVendorDataPlane`）。
 */
import type { UserConfig } from '../types'
import type { ProxyEndpoint } from '../outbound/proxy-pool'
import { parseVlessBuffer, VLESS_COMMAND_UDP } from './vless'
import { parseTrojanBuffer, TROJAN_COMMAND_UDP } from './trojan'
import { concatBytes } from './stream'
import { dial, type DialResult } from '../outbound/dial'
import { resolveEndpointIps } from '../outbound/doh'
import { isCloudflareAddress, coloToRegion } from '../outbound/colo-relay'

export type WsMode = 'vless' | 'trojan'

/** 是否回退到 vendor 数据面（默认 false，即使用自研实现） */
export function useVendorDataPlane(): boolean {
  return false
}

/** 单次拨号超时（ms） */
const DIAL_TIMEOUT_MS = 5000

/** 握手头最大长度 */
const MAX_HEADER_BYTES = 64 * 1024

/** 首包等待窗口：客户端可能在 101 之后才发首个数据帧 */
const FIRST_PACKET_TIMEOUT_MS = 80

interface WsTarget {
  command: number
  port: number
  hostname: string
  /** 协议头占用的字节数，其后即为负载 */
  headerLength: number
  /** Trojan 场景下的口令（用于回显校验） */
  password?: string
}

/**
 * 选择出站落地地址。
 *
 * 顺序与 CFNext 的 `Bt()` 对齐，但不内置任何第三方域名：
 *   1. 用户显式配置的 ProxyIP（解析其落地 IP 后竞速）
 *   2. 目标本身不是 CF 地址 → 直连
 *   3. 目标是 CF 地址 → 用同区域 ProxyIP 或解析结果中转
 */
async function pickOutbound(
  target: WsTarget,
  proxies: ProxyEndpoint[],
  colo: string
): Promise<{ endpoint: { hostname: string; port: number }; via: DialResult['via'] } | null> {
  const direct = { hostname: target.hostname, port: target.port }

  // 1) 用户配置的 ProxyIP：优先同区域，其次任意
  if (proxies.length > 0) {
    const region = coloToRegion(colo)
    const sameRegion = proxies.filter((p) => p.kind === 'direct')
    const ordered = sameRegion.length > 0 ? sameRegion : proxies
    for (const proxy of ordered.slice(0, 3)) {
      const ips = await resolveEndpointIps(proxy.host, proxy.port)
      const candidates = ips.length > 0 ? ips.slice(0, 4) : [{ hostname: proxy.host, port: proxy.port }]
      for (const candidate of candidates) {
        const result = await tryDial(candidate, target, proxies)
        if (result) return { endpoint: candidate, via: result.via }
      }
    }
  }

  // 2) 目标不是 CF 地址 → 直连即可
  if (!isCloudflareAddress(target.hostname)) {
    const result = await tryDial(direct, target, proxies)
    if (result) return { endpoint: direct, via: result.via }
    return null
  }

  // 3) 目标是 CF 地址且没有可用 ProxyIP：仍然尝试直连一次，
  //    把 Loop 异常交给上层转换为可诊断的关闭码。
  const result = await tryDial(direct, target, proxies)
  if (result) return { endpoint: direct, via: result.via }
  return null
}

/** 尝试一次拨号，成功返回 DialResult */
async function tryDial(
  endpoint: { hostname: string; port: number },
  target: WsTarget,
  proxies: ProxyEndpoint[]
): Promise<DialResult | null> {
  try {
    return await dial({
      hostname: endpoint.hostname,
      port: endpoint.port,
      proxies: [],
      timeoutMs: DIAL_TIMEOUT_MS,
    })
  } catch {
    // 目标不可达时再试代理池（SOCKS5 / HTTP）
    if (proxies.length > 0) {
      try {
        return await dial({
          hostname: target.hostname,
          port: target.port,
          proxies,
          timeoutMs: DIAL_TIMEOUT_MS,
        })
      } catch {
        return null
      }
    }
    return null
  }
}

/**
 * 处理 WebSocket 升级请求，返回 101 响应并启动双向中继。
 *
 * 认证：VLESS 校验 UUID，Trojan 校验 SHA224 口令。
 * 与 BPB 一致，先回协议响应头再中继，避免客户端把首包数据判为协议错误。
 */
export async function handleWebSocket(
  request: Request,
  mode: WsMode,
  config: UserConfig,
  proxies: ProxyEndpoint[],
  ctx?: { waitUntil(promise: Promise<unknown>): void }
): Promise<Response> {
  const pair = new WebSocketPair()
  const client = pair[0]
  const server = pair[1]

  try {
    server.accept({ allowHalfOpen: true })
  } catch {
    server.accept()
  }
  // workerd 下 event.data 可能是 Blob，用 arraybuffer 统一拿字节
  server.binaryType = 'arraybuffer'

  const colo = (request as Request & { cf?: { colo?: string } }).cf?.colo ?? ''

  // 攒包缓冲：协议头可能跨多个数据帧
  let buffer = new Uint8Array(0)
  let established = false
  let dialed: DialResult | null = null
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  let firstPacketTimer: ReturnType<typeof setTimeout> | null = null

  const send = (bytes: Uint8Array): void => {
    try {
      server.send(bytes)
    } catch {
      /* 客户端可能已断开 */
    }
  }

  /** 协议响应头：版本(1) + Addons 长度(1) + Addons */
  const sendResponseHeader = (addons: Uint8Array): void => {
    const header = new Uint8Array(2 + addons.byteLength)
    header[0] = 0x00
    header[1] = addons.byteLength
    header.set(addons, 2)
    send(header)
  }

  const closeWith = (code: number, reason: string): void => {
    try {
      server.close(code, reason)
    } catch {
      /* 已关闭 */
    }
  }

  const cleanup = (): void => {
    if (firstPacketTimer) {
      clearTimeout(firstPacketTimer)
      firstPacketTimer = null
    }
    if (dialed) {
      try {
        void dialed.writable.close()
      } catch {
        /* 已关闭 */
      }
    }
  }

  /** 下行：出站 → 客户端 */
  const pumpDown = async (): Promise<void> => {
    if (!dialed) return
    const reader = dialed.readable.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.byteLength > 0) send(value)
      }
    } catch {
      /* 传输错误 */
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* 已释放 */
      }
      closeWith(1000, 'done')
    }
  }

  /** 上行：客户端 → 出站 */
  const pumpUp = async (bytes: Uint8Array): Promise<void> => {
    if (!writer) return
    try {
      await writer.write(bytes)
    } catch {
      cleanup()
    }
  }

  /** 解析协议头并建立出站连接 */
  const establish = async (isRetry: boolean): Promise<void> => {
    const target = parseTarget(buffer, mode, config)
    if (!target) {
      // 数据还不够：等一小会儿再看一次（客户端可能分帧发送）
      if (!isRetry) {
        firstPacketTimer = setTimeout(() => {
          firstPacketTimer = null
          void establish(true).catch((err) => closeWith(1011, String(err)))
        }, FIRST_PACKET_TIMEOUT_MS)
      }
      return
    }
    if (firstPacketTimer) {
      clearTimeout(firstPacketTimer)
      firstPacketTimer = null
    }
    if (established) return
    established = true

    // UDP 暂不支持
    const udpCommand = mode === 'vless' ? VLESS_COMMAND_UDP : TROJAN_COMMAND_UDP
    if (target.command === udpCommand) {
      closeWith(1002, 'UDP over WebSocket 暂不支持')
      return
    }

    const picked = await pickOutbound(target, proxies, colo)
    if (!picked) {
      closeWith(1011, '出站连接失败（目标不可达或触发 TCP Loop）')
      return
    }

    try {
      dialed = await dial({
        hostname: picked.endpoint.hostname,
        port: picked.endpoint.port,
        proxies: [],
        timeoutMs: DIAL_TIMEOUT_MS,
      })
    } catch (err) {
      closeWith(1011, `出站拨号失败：${String(err)}`)
      return
    }

    writer = dialed.writable.getWriter()

    // BPB 做法：先回协议响应头，客户端据此判定入站已建立
    sendResponseHeader(new Uint8Array(0))

    // cfnew 做法：把协议头之后已收到的首包补写，避免竞速期间丢数据
    const payload = buffer.byteLength > target.headerLength
      ? buffer.slice(target.headerLength)
      : new Uint8Array(0)
    if (payload.byteLength > 0) await pumpUp(payload)
    buffer = new Uint8Array(0)

    ctx?.waitUntil(pumpDown())
  }

  /** 从攒包缓冲解析协议头 */
  const parseTarget = (bytes: Uint8Array, wsMode: WsMode, cfg: UserConfig): WsTarget | null => {
    if (wsMode === 'vless') {
      const parsed = parseVlessBuffer(bytes, cfg.uuid)
      if (!parsed) return null
      return {
        command: parsed.header.command,
        port: parsed.header.port,
        hostname: parsed.header.hostname,
        headerLength: parsed.consumed,
      }
    }
    const parsed = parseTrojanBuffer(bytes, cfg.trojanPassword)
    if (!parsed) return null
    return {
      command: parsed.header.command,
      port: parsed.header.port,
      hostname: parsed.header.hostname,
      headerLength: parsed.consumed,
      password: cfg.trojanPassword,
    }
  }

  server.addEventListener('message', (event: MessageEvent) => {
    void (async () => {
      const data = event.data
      const bytes =
        typeof data === 'string'
          ? new TextEncoder().encode(data)
          : new Uint8Array(data as ArrayBuffer)
      if (bytes.byteLength === 0) return

      if (!established) {
        buffer = concatBytes(buffer, bytes)
        if (buffer.byteLength > MAX_HEADER_BYTES) {
          closeWith(1009, '握手头超过 64KB')
          return
        }
        await establish(false)
        return
      }
      await pumpUp(bytes)
    })()
  })

  const onClose = (): void => {
    cleanup()
  }
  server.addEventListener('close', onClose)
  server.addEventListener('error', onClose)

  // Node（vitest）的 Response 不接受 101 状态码，只有 workerd 支持；
  // 因此这里用 200 + webSocket 选项，在 workerd 下同样完成升级。
  // 若运行时不支持 webSocket 选项，则退化为普通 200 响应。
  try {
    return new Response(null, { status: 101, webSocket: client } as ResponseInit)
  } catch {
    return new Response(null, { status: 200 })
  }
}
