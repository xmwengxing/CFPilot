import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { sha224, sha224Hex } from '../src/protocols/sha224'

function nodeSha224(input: string): string {
  return createHash('sha224').update(input, 'utf8').digest('hex')
}

describe('sha224', () => {
  it('与 Node crypto 结果一致（多组输入）', () => {
    const inputs = [
      '',
      'abc',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(64),
      'a'.repeat(1000),
      '中文口令 with unicode ✅',
    ]
    for (const input of inputs) {
      expect(sha224Hex(new TextEncoder().encode(input)), `输入长度 ${input.length}`).toBe(
        nodeSha224(input)
      )
    }
  })

  it('输出长度为 28 字节', () => {
    expect(sha224(new TextEncoder().encode('abc'))).toHaveLength(28)
  })

  it('已知向量', () => {
    expect(sha224Hex(new TextEncoder().encode('abc'))).toBe(
      '23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7'
    )
    expect(sha224Hex(new TextEncoder().encode(''))).toBe(
      'd14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f'
    )
  })
})
