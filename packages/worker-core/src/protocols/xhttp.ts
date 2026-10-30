/**
 * XHTTP（stream-one）入站处理
 *
 * Xray 的 XHTTP stream-one 模式下，客户端以一个 HTTP 请求承载上行数据：
 *   POST /<path> HTTP/1.1
 *   Content-Type: application/grpc
 *
 * 请求体首字节是 VLESS 协议头，其后是上行负载；
 * 服务端以 200 + 流式响应体返回下行数据。
 */
import type { UserConfig } from '../types'
import { ByteStream } from './stream'
import { parseVless, VLESS_COMMAND_TCP } from './vless'
import type { DialResult, ProxyEndpoint } from '../outbound/dial'
import { relay, TrafficMeter } from '../budget'

import { dial } from '../outbound/dial'

/**
 * XHTTP 请求头读取截止时间。
 *
 * ## 为什么要
 *
 * `parseVless` 从请求体里按需读取，**本身没有超时**：
 * 客户端把 POST body 停在不完整的 VLESS 头上（或扫描器直接发个半截 body），
 * 这个请求就会一直挂到运行时超时才回收 —— 期间占着一个 isolate 与一条子请求。
 *
 * 2 秒与 WebSocket 入站的握手截止时间保持一致（真实客户端都是立即发完整头）。
 */
const HEADER_DEADLINE_MS = 2000

/** 给一个 Promise 加截止时间；超时返回 `null` */
function withDeadline<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

export interface XhttpResult {
  response: Response
  dialResult: DialResult
}

/** 最近一次 XHTTP 出站诊断（isolate 级） */
const XHTTP_DIAGNOSTICS: Array<{ at: number; target: string; kind: string; message: string; candidate: string; summary: string }> = []

/** 记录 XHTTP 出站诊断 */
export function recordXhttpDiagnostics(
  target: string,
  failure: { kind: string; message: string; candidate: string },
  summary: string
): void {
  XHTTP_DIAGNOSTICS.unshift({ at: Date.now(), target, ...failure, summary })
  if (XHTTP_DIAGNOSTICS.length > 20) XHTTP_DIAGNOSTICS.length = 20
}

/** 读取 XHTTP 诊断 */
export function recentXhttpDiagnostics(): typeof XHTTP_DIAGNOSTICS {
  return XHTTP_DIAGNOSTICS
}

/** 解析 XHTTP 请求并建立出站连接，返回流式响应 */
export async function handleXhttp(
  request: Request,
  config: UserConfig,
  proxies: ProxyEndpoint[]
): Promise<Response> {
  const body = request.body
  if (!body) {
    return new Response('缺少请求体', { status: 400 })
  }

  const stream = new ByteStream(body)
  const parsed = await withDeadline(parseVless(stream, config.uuid), HEADER_DEADLINE_MS)
  if (!parsed) {
    // 超时或解析失败：必须由 ByteStream 取消它自己持有的 reader。
    //
    // ⚠️ 直接 `body.cancel()` 是无效的 —— 原始流已被 `getReader()` 锁定，
    // cancel 会抛错（被吞掉），解析任务里的 `reader.read()` 仍然挂着，
    // 直到客户端断开或运行时超时。扫描器发半截 VLESS 头即可持续占用资源。
    await stream.cancel('header timeout')
    return new Response('VLESS 头解析失败', { status: 400 })
  }
  if (parsed.header.command !== VLESS_COMMAND_TCP) {
    return new Response('XHTTP 暂不支持 UDP', { status: 400 })
  }

  let dialResult: DialResult
  try {
    dialResult = await dial({
    hostname: parsed.header.hostname,
    port: parsed.header.port,
    proxies,
    nat64: config.nat64,
    concurrent: config.concurrentDial,
    // 代理调度模式（与 WS 入站路径保持一致）
    proxyMode: config.proxyMode,
    // ⚠️ 这两项必须与 WS 入站路径保持一致：
    // 少了它们，XHTTP 会**用运行时自己的 DNS 解析**目标域名 ——
    // 而运行时的解析结果可能落在 Cloudflare 网段（Worker 不能连回自家 Anycast），
    // 表现为「XHTTP 节点延迟全是 -1」，但服务端看不出任何错误。
    resolvePreferred: config.resolvePreferred,
    relayPool: {
      userEntries: config.relayPool || undefined,
      useBuiltin: config.useBuiltinRelay,
    },
    // 失败分级上报：XHTTP 出站失败此前**完全不可诊断**（表现就是客户端延迟 -1），
    // 排查时看不到任何线索。现在记录到诊断端点。
    onFailure: (failure) => {
      recordXhttpDiagnostics(
        `${parsed.header.hostname}:${parsed.header.port}`,
        failure,
        `XHTTP 出站失败（${failure.candidate}）：${failure.message}`
      )
    },
    })
  } catch (err) {
    // 出站失败此前会抛到最外层、变成无信息的 500。
    // 这里转成受控响应（不暴露目标地址），并记进诊断端点。
    recordXhttpDiagnostics(
      `${parsed.header.hostname}:${parsed.header.port}`,
      { kind: 'dial', message: String(err), candidate: 'all' },
      `XHTTP 出站全部失败：${String(err)}`
    )
    // 同理：上行流是从 ByteStream 释放出来的包装流，取消它才会真正取消底层 reader
    try {
      void parsed.payload.cancel('dial failed').catch(() => {})
    } catch {
      /* 已关闭 */
    }
    return new Response('出站不可用', { status: 502 })
  }

  // 上行：请求体剩余部分 → 出站
  //
  // ⚠️ `closeTarget: false` —— 关闭 socket 的写流等于关闭整个 TCP 连接，
  // 目标站会收到 RST 而来不及把响应发回来。
  // 对比：WebSocket 入站路径只 releaseLock 不 close，是正常的。
  //
  // 实际发起放在下方（响应流建完之后）—— 上行计量器需要那里的作用域。
  // 下行：出站 → 响应体，由下方 combined 流**直接**从 dialResult.readable 拉取。
  // 中间不再套一层 TransformStream：同一份下行少一次拷贝与一对流控制器。

  // VLESS 响应头：版本(1) + Addons 长度(1) + Addons（原样回显请求里的 Addons）。
  // Xray 客户端要求先读到这个头才认为入站已建立，缺失时会把后续下行数据当作协议错误丢弃。
  const addons = parsed.header.addons
  if (addons.byteLength > 255) {
    return new Response('Addons 长度超出 VLESS 协议上限', { status: 400 })
  }
  const header = new Uint8Array(2 + addons.byteLength)
  header[0] = parsed.header.version
  header[1] = addons.byteLength
  header.set(addons, 2)

  // 把响应头与下行流拼接：头部先行，下行数据随后。
  // ⚠️ **不能用 async start 承载整个下行**：
  //
  // `start` 返回的 Promise 未完成时，流的 `pull` 不会被调用，
  // 而消费者（`fetch` / Xray 客户端）会一直等 —— 表现为
  // 「响应头到了，但**永远收不到后续数据**」（客户端侧就是延迟 -1）。
  //
  // 正确做法：`start` 立即返回（只把响应头入队），
  // 后续下行数据在 `pull` 里按需读取。
  let headerSent = false
  let downReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  /**
   * 客户端是否已经取消。
   *
   * pull 是异步的：cancel 之后仍可能有 pending 的 read() 返回/抛错，
   * 那时再去碰 controller 会抛 `ERR_INVALID_STATE`（流已关闭）——
   * 表现为「测试全绿但进程报未处理异常」，真机上则是日志噪音。
   */
  let cancelled = false

  /**
   * 单连接流量计量（上下行合计，0 = 不限制）。
   *
   * 与 WebSocket 入站同一口径，配置项同为 `dataBudgetMB`。
   * 数据面没有任何 CPU 预算约束（`CpuBudget` 只管控制面），
   * 一条超大流量连接能把账号当日配额吃穿，超限主动断流让客户端重连。
   */
  const traffic = new TrafficMeter((config.dataBudgetMB || 0) * 1024 * 1024)

  /** 响应流控制器（流量熔断时用它正常收尾） */
  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null

  /**
   * 流量熔断：关闭出站 Socket + 结束响应流。
   *
   * 用 `close()` 而不是 `error()`：客户端会把异常断流当成目标站报错并停止重试，
   * 而这里我们是主动结束，正常 EOF 才是「可重连」的信号。
   */
  const cutByTraffic = (): void => {
    if (cancelled) return
    cancelled = true
    const reason = `单连接流量超过 ${config.dataBudgetMB}MB 上限`
    recordXhttpDiagnostics(
      `${parsed.header.hostname}:${parsed.header.port}`,
      { kind: 'budget', message: reason, candidate: 'traffic' },
      reason
    )
    if (dialResult.close) {
      try {
        void dialResult.close()
      } catch {
        /* 已关闭 */
      }
    }
    try {
      bodyController?.close()
    } catch {
      /* 已关闭 */
    }
  }

  /** 上行计量：超限即熔断（返回 true 让 relay 停止中继） */
  const onUpstreamChunk = (bytes: number): boolean => {
    if (!traffic.add(bytes)) return false
    cutByTraffic()
    return true
  }

  void relay(parsed.payload, dialResult.writable, undefined, false, onUpstreamChunk).catch(() => {
    /* 客户端取消 / 出站已关闭：写入失败属预期，不构成未处理异常 */
  })

  const combined = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller
      // 只入队响应头（2 字节），立即结束 start
      controller.enqueue(header)
      headerSent = true
    },
    async pull(controller) {
      if (cancelled || !headerSent) return
      if (!downReader) downReader = dialResult.readable.getReader()
      try {
        const { done, value } = await downReader.read()
        if (cancelled) return
        if (done) {
          // 下行结束 = 连接结束：必须关闭出站 Socket。
          // 只 close 响应流的话 TCP 连接仍然开着，一直占着
          // 「单请求 6 条并发出站」里的一个槽位（同 isolate 的其它请求更容易撞上限）。
          if (dialResult.close) {
            try {
              void dialResult.close()
            } catch {
              /* 已关闭 */
            }
          }
          controller.close()
          return
        }
        if (value && value.byteLength > 0) {
          // 流量熔断：超限的那块不再下发，直接收尾
          if (traffic.add(value.byteLength)) {
            cutByTraffic()
            return
          }
          controller.enqueue(value)
        }
      } catch (err) {
        if (cancelled) return
        // 之前这里 controller.close() —— 客户端会把「异常截断」当成正常 EOF，
        // 既不能重试也无法区分。现在把错误传给流，同时保留 Socket 关闭。
        if (dialResult.close) {
          try {
            void dialResult.close()
          } catch {
            /* 已关闭 */
          }
        }
        try {
          controller.error(err)
        } catch {
          /* 已关闭 */
        }
      }
    },
    cancel(reason) {
      cancelled = true
      // 客户端断开（Xray 取消请求）时：取消下行读取，并**关闭底层 Socket**。
      //
      // 只 cancel readable 的话，TCP 连接仍然开着 —— 在 Workers 上它会一直占着
      // 「单请求 6 条并发出站」里的一个槽位，同 isolate 的其它请求更容易撞上限。
      try {
        void dialResult.readable.cancel(reason)
      } catch {
        /* 已取消 */
      }
      if (dialResult.close) {
        try {
          void dialResult.close()
        } catch {
          /* 已关闭 */
        }
      }
    },
  })

  return new Response(combined, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
