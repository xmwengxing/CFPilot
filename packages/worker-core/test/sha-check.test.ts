import { describe, it, expect } from 'vitest'
import { sha224Hex } from '../src/protocols/sha224'
describe('SHA-224 已知向量', () => {
  it('"abc"', () => {
    const got = sha224Hex(new TextEncoder().encode('abc'))
    const want = '23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7'
    console.log('got =', got)
    console.log('want=', want)
    expect(got).toBe(want)
  })
  it('空字符串', () => {
    const got = sha224Hex(new TextEncoder().encode(''))
    const want = 'd14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f'
    console.log('got =', got)
    expect(got).toBe(want)
  })
})
