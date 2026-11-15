/**
 * VLESS 协议头校验（version / command / flow）—— 回归测试。
 *
 * 守护：客户端开 Mux 或 xtls-rprx-vision 时，必须**明确拒绝**并留痕，
 * 而不是把 smux 首字节当 addressType 解析出一个畸形目标、或让客户端
 * 误判服务端已协商 vision（协议直接错乱）。
 */
import { describe, expect, it } from 'vitest'
import {
  VLESS_COMMAND_TCP,
  VLESS_COMMAND_UDP,
  VLESS_COMMAND_MUX,
  validateVlessHeader,
  vlessFlow,
  type VlessHeader,
} from '../src/protocols/vless'

function header(overrides: Partial<VlessHeader> = {}): VlessHeader {
  return {
    version: 0,
    command: VLESS_COMMAND_TCP,
    port: 443,
    hostname: 'example.com',
    addressType: 2,
    addons: new Uint8Array(0),
    ...overrides,
  }
}

/** protobuf: field 1 (flow), wire type 2 */
function addonsWithFlow(flow: string): Uint8Array {
  const bytes = new TextEncoder().encode(flow)
  // 这里 flow 长度 < 128，varint 就是单字节
  return new Uint8Array([0x0a, bytes.byteLength, ...bytes])
}

describe('vlessFlow（Addons protobuf 取 flow）', () => {
  it('空 Addons → 无 flow', () => {
    expect(vlessFlow(new Uint8Array(0))).toBe('')
  })

  it('正确取出 field 1 的字符串', () => {
    expect(vlessFlow(addonsWithFlow('xtls-rprx-vision'))).toBe('xtls-rprx-vision')
  })

  it('前面有其它字段时也能跳过并取到 flow', () => {
    // field 2 varint(0x10 0x01) + field 1 string
    const flow = new TextEncoder().encode('vision')
    expect(vlessFlow(new Uint8Array([0x10, 0x01, 0x0a, flow.byteLength, ...flow]))).toBe('vision')
  })

  it('截断的 Addons 不抛异常，返回空', () => {
    expect(vlessFlow(new Uint8Array([0x0a, 0x10, 0x01]))).toBe('')
  })
})

describe('validateVlessHeader', () => {
  it('合法 TCP / UDP 头通过', () => {
    expect(validateVlessHeader(header())).toBeNull()
    expect(validateVlessHeader(header({ command: VLESS_COMMAND_UDP }))).toBeNull()
  })

  it('非 0 版本 → 明确拒绝', () => {
    expect(validateVlessHeader(header({ version: 1 }))).toContain('版本不支持')
  })

  it('Mux(0x03) / Rvs(0x04) → 明确拒绝并提示关闭多路复用', () => {
    expect(validateVlessHeader(header({ command: VLESS_COMMAND_MUX }))).toContain('多路复用')
    expect(validateVlessHeader(header({ command: 0x04 }))).toContain('多路复用')
  })

  it('未知命令 → 明确拒绝', () => {
    expect(validateVlessHeader(header({ command: 0x7f }))).toContain('命令不支持')
  })

  it('带 flow（XTLS）→ 明确拒绝，绝不静默当普通 TCP', () => {
    const reason = validateVlessHeader(header({ addons: addonsWithFlow('xtls-rprx-vision') }))
    expect(reason).toContain('flow')
    expect(reason).toContain('xtls-rprx-vision')
  })

  it('空 Addons 不误判为 flow', () => {
    expect(validateVlessHeader(header({ addons: new Uint8Array([0x00]) }))).toBeNull()
  })
})
