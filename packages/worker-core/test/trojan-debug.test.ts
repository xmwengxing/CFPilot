import { describe, expect, it } from 'vitest'
import { parseTrojanBuffer, trojanPasswordHash } from '../src/protocols/trojan'

describe('Trojan 握手解析调试', () => {
  it('能解析标准握手', () => {
    const password = 'cfp-brwxyy8wds9rh2'
    // ⚠️ Trojan 用的是 56 个 ASCII 十六进制字符，不是 28 字节二进制
    const hash = Buffer.from(trojanPasswordHash(password), 'utf8')
    const name = Buffer.from('httpbin.org')
    const addr = Buffer.concat([
      Buffer.from([0x01, 0x03, name.length]),
      name,
      Buffer.from([0, 80]),
    ])
    const payload = Buffer.concat([hash, Buffer.from('\r\n'), addr, Buffer.from('\r\n')])
    console.log('payload 长度:', payload.length)
    console.log('hash hex:', payload.subarray(0,56).toString())
    console.log('期望 hash:', trojanPasswordHash(password))
    console.log('字节 56-57:', payload[56].toString(16), payload[57].toString(16))
    console.log('字节 58(command):', payload[58].toString(16))
    console.log('字节 59(atyp):', payload[59].toString(16))
    console.log('字节 60(len):', payload[60])
    console.log('名称:', payload.subarray(61, 61+payload[60]).toString())
    console.log('port 位置 61+len:', payload[61+payload[60]], payload[62+payload[60]])
    console.log('CRLF 位置:', payload[63+payload[60]], payload[64+payload[60]])
    const parsed = parseTrojanBuffer(new Uint8Array(payload), password)
    console.log('解析结果:', parsed ? JSON.stringify(parsed.header) : 'null')
    expect(parsed).not.toBeNull()
    expect(parsed!.header.hostname).toBe('httpbin.org')
    expect(parsed!.header.port).toBe(80)
  })
})
