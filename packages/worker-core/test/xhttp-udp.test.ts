/**
 * XHTTP 拒绝 UDP 时必须取消剩余请求体
 *
 * `parseVless()` 把 body 的 reader 交给了 `parsed.payload`。如果直接返回响应，
 * 没有任何一方取消它 —— 客户端继续发字节、服务端不读，读取任务挂到运行时超时。
 * 发一个 UDP 命令 + 半截 body 就能持续占用资源，属于零成本 DoS 面。
 */
import { describe, it, expect } from 'vitest'

import { handleXhttp } from '../src/protocols/xhttp'
import type { UserConfig } from '../src/types'

const UUID = '11111111-2222-3333-4444-555555555555'

/** 造一个 VLESS 请求头（版本 + UUID + Addons + 命令 + 端口 + 地址） */
function vlessHeader(command: number, hostname = 'example.com', port = 443): Uint8Array {
  const uuid = UUID.replace(/-/g, '')
  const host = new TextEncoder().encode(hostname)
  const out = new Uint8Array(1 + 16 + 1 + 1 + 2 + 1 + 1 + host.length)
  let off = 0
  out[off++] = 0x00 // 版本
  for (let i = 0; i < 16; i++) out[off++] = parseInt(uuid.slice(i * 2, i * 2 + 2), 16)
  out[off++] = 0x00 // addons 长度
  out[off++] = command
  out[off++] = (port >> 8) & 0xff
  out[off++] = port & 0xff
  out[off++] = 0x02 // 域名
  out[off++] = host.length
  out.set(host, off)
  return out
}

function config(): UserConfig {
  return { uuid: UUID, concurrentDial: false, proxyMode: 'only', nat64: '' } as unknown as UserConfig
}

/** 造一个「永不结束」的请求体，并记录它是否被取消 */
function endlessBody(first: Uint8Array): { body: ReadableStream<Uint8Array>; state: { cancelled: unknown } } {
  const state: { cancelled: unknown } = { cancelled: undefined }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first)
      // 故意不 close：模拟客户端「头发完继续发数据」
    },
    cancel(reason) {
      state.cancelled = reason
    },
  })
  return { body, state }
}

describe('XHTTP + UDP 命令', () => {
  it('返回 400 且取消剩余请求体', async () => {
    const { body, state } = endlessBody(vlessHeader(0x02))
    const request = new Request('https://data.example.com/xhttp', {
      method: 'POST',
      body,
      // Node 的 fetch 实现要求显式声明半双工
      duplex: 'half',
    } as RequestInit)

    const response = await handleXhttp(request, config(), [])
    expect(response.status).toBe(400)
    expect(state.cancelled).toBe('unsupported UDP')
  })

  it('TCP 命令不会在解析阶段取消请求体', async () => {
    const { body, state } = endlessBody(vlessHeader(0x01))
    const request = new Request('https://data.example.com/xhttp', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit)

    // TCP 会继续走出站拨号；这里只断言「没有在解析阶段就被取消」
    await handleXhttp(request, config(), []).catch(() => null)
    expect(state.cancelled).not.toBe('unsupported UDP')
  })
})
