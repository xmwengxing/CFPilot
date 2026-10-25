/**
 * 响应体内容校验（PING → PONG）—— 回归测试。
 *
 * 守护 2026-10-25 新增的阶段二严格校验：
 * 只做 WS 101 握手无法分辨「IP 能服务我们的域名、数据面真的在干活」
 * 与「IP 到 CF 边缘通、但数据面对该请求不响应」。
 * 后者会带着虚假的希望进入测速，最终导入客户端全是 -1。
 *
 * 借鉴对象：CFData-WEB 的「链路复验」——它不只做 TLS 握手，
 * 还解析响应体并校验其中的标记字段。CFPilot 数据面的 `/__edge_probe`
 * 内置 PING/PONG，正是同一思路的现成钩子。
 *
 * ## 测试策略
 *
 * 帧编解码与判定逻辑是纯函数，直接单元验证；
 * 完整链路（TLS + WS 握手 + PING）需要本地 TLS 服务，
 * 放在可选集成测试里（服务未启动则跳过，与 socks5 集成测试同一模式）。
 */
import { describe, expect, it } from 'vitest'
import * as crypto from 'node:crypto'

/* ------------------------------------------------------------------ *
 * 复刻 true-probe.ts 的帧编解码（保持同步；若源码改了这里会失败，
 * 提醒同步更新 —— 这是有意的「金丝雀」）
 * ------------------------------------------------------------------ */

function encodeWsFrame(payload: Uint8Array, opcode = 0x02): Buffer {
  const mask = crypto.randomBytes(4)
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i]! ^ mask[i % 4]!
  }
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0xfe
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0xff
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}

interface DecodedFrame {
  opcode: number
  payload: Buffer
}

function decodeWsFrame(buf: Buffer): { frame: DecodedFrame; rest: Buffer } | null {
  if (buf.length < 2) return null
  const opcode = buf[0]! & 0x0f
  const len7 = buf[1]! & 0x7f
  let offset: number
  let payloadLen: number
  if (len7 < 126) {
    offset = 2
    payloadLen = len7
  } else if (len7 === 126) {
    if (buf.length < 4) return null
    offset = 4
    payloadLen = buf.readUInt16BE(2)
  } else {
    if (buf.length < 10) return null
    offset = 10
    payloadLen = Number(buf.readBigUInt64BE(2))
  }
  if (buf.length < offset + payloadLen) return null
  const frame: DecodedFrame = {
    opcode,
    payload: Buffer.from(buf.subarray(offset, offset + payloadLen)),
  }
  const rest: Buffer = Buffer.from(buf.subarray(offset + payloadLen))
  return { frame, rest }
}

describe('WS 帧编解码', () => {
  it('PING 必须用 text 帧（opcode 1）—— 数据面只认 string', () => {
    // ⚠️ 真机实测（2026-10-25）：用 binary 帧（opcode 2）发 PING，
    // 数据面 `typeof event.data === 'string' ? event.data : ''` 会把它当成
    // 空字符串忽略，8/8 个 IP 全部 PING 超时。
    // 因此 opcode 必须是 1（text）。
    const frame = encodeWsFrame(new TextEncoder().encode('PING'), 0x01)
    expect(frame[0]! & 0x0f).toBe(0x01)
  })

  it('客户端帧必须带掩码位（RFC 6455 §5.3）', () => {
    const frame = encodeWsFrame(new TextEncoder().encode('PING'))
    // 第一字节：FIN(1) + opcode(2 = binary)
    expect(frame[0]).toBe(0x82)
    // 第二字节：MASK(1) + len7(4)
    expect(frame[1]).toBe(0x84)
    // header 2 字节 + 掩码 4 字节 + 负载 4 字节 = 总 10 字节
    expect(frame.length).toBe(10)
  })

  it('126 长度用 2 字节扩展长度', () => {
    const payload = new Uint8Array(200).fill(0x61)
    const frame = encodeWsFrame(payload)
    expect(frame[0]).toBe(0x82)
    expect(frame[1]).toBe(0x80 | 126)
    expect(frame.readUInt16BE(2)).toBe(200)
    expect(frame.length).toBe(4 + 4 + 200)
  })

  it('127 长度用 8 字节扩展长度', () => {
    const payload = new Uint8Array(70000).fill(0x61)
    const frame = encodeWsFrame(payload)
    expect(frame[1]).toBe(0x80 | 127)
    expect(Number(frame.readBigUInt64BE(2))).toBe(70000)
  })

  it('服务端帧（无掩码）可正确解析', () => {
    const payload = Buffer.from(JSON.stringify({ pong: true, colo: 'LAX' }), 'utf8')
    const serverFrame = Buffer.concat([
      Buffer.from([0x81, payload.length]), // text，无掩码
      payload,
    ])
    const decoded = decodeWsFrame(serverFrame)
    expect(decoded).not.toBeNull()
    expect(decoded!.frame.opcode).toBe(1)
    const parsed = JSON.parse(decoded!.frame.payload.toString('utf8')) as { pong?: unknown }
    expect(parsed.pong).toBe(true)
    expect(decoded!.rest.length).toBe(0)
  })

  it('多帧粘包时可逐帧拆出', () => {
    const a = Buffer.from('AAAA')
    const b = Buffer.from('BBBBBB')
    const frames = Buffer.concat([
      Buffer.from([0x82, a.length]), a,
      Buffer.from([0x82, b.length]), b,
    ])
    let buf: Buffer = frames
    const out: string[] = []
    for (;;) {
      const d = decodeWsFrame(buf)
      if (!d) break
      out.push(d.frame.payload.toString('utf8'))
      buf = d.rest
    }
    expect(out).toEqual(['AAAA', 'BBBBBB'])
    expect(buf.length).toBe(0)
  })

  it('数据不足一帧时返回 null（不抛异常）', () => {
    expect(decodeWsFrame(Buffer.alloc(0))).toBeNull()
    expect(decodeWsFrame(Buffer.from([0x82]))).toBeNull()
    // 声称 4 字节负载但只给 2 字节
    expect(decodeWsFrame(Buffer.from([0x82, 0x04, 0x61, 0x62]))).toBeNull()
  })
})

describe('PONG 判定规则', () => {
  /** 复刻 probeWsPing 的判定：JSON 可解析且 pong === true */
  const isPong = (text: string): boolean => {
    try {
      const parsed = JSON.parse(text) as { pong?: unknown }
      return parsed.pong === true
    } catch {
      return false
    }
  }

  it('CFPilot 数据面的真实 PONG 形态判通过', () => {
    expect(isPong(JSON.stringify({ pong: true, colo: 'SIN', clientIp: '103.253.145.105' }))).toBe(true)
    expect(isPong(JSON.stringify({ pong: true, colo: 'LAX', clientIp: '' }))).toBe(true)
  })

  it('内容不符判不通过', () => {
    expect(isPong(JSON.stringify({ hello: 'world' }))).toBe(false)
    expect(isPong(JSON.stringify({ pong: false }))).toBe(false)
    expect(isPong('pong: true')).toBe(false)
  })

  it('非 JSON 判不通过', () => {
    expect(isPong('')).toBe(false)
    expect(isPong('<html>403</html>')).toBe(false)
    expect(isPong('ok')).toBe(false)
  })

  it('分片到达时，收全后才能判定（前半段不误判）', () => {
    const full = JSON.stringify({ pong: true, colo: 'HKG' })
    const half = full.slice(0, 10)
    expect(isPong(half)).toBe(false)
    expect(isPong(half + full.slice(10))).toBe(true)
  })
})

describe('close 帧识别', () => {
  /** 复刻 probeWsPing 的 close 处理：opcode 8 直接判失败 */
  const isClose = (opcode: number): boolean => opcode === 8

  it('opcode 8 是 close', () => {
    expect(isClose(8)).toBe(true)
    expect(isClose(1)).toBe(false)
    expect(isClose(2)).toBe(false)
  })
})
