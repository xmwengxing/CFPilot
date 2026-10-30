/**
 * 订阅签名令牌（sub-token）
 *
 * 这组测试钉死三件事：
 *   1. 签出来的令牌能被自己验回（含 TTL 语义）；
 *   2. **改一个字节就验不过**（签名截断到 22 位后仍然足够）；
 *   3. 轮换密钥后旧令牌立刻失效 —— 这是「泄露后止损」的全部价值所在。
 */
import { describe, it, expect } from 'vitest'

import {
  loadSubSecret,
  rotateSubSecret,
  signSubToken,
  verifySubToken,
  SUB_SECRET_KEY,
} from '../src/sub-token'
import { MemoryStore } from '../src/store'

const SECRET = 'a'.repeat(64)

describe('签名与校验', () => {
  it('自签自验通过', async () => {
    const token = await signSubToken(SECRET)
    const result = await verifySubToken(SECRET, token)
    expect(result.ok).toBe(true)
    expect(result.exp).toBe(0)
  })

  it('令牌形如 v1.<exp>.<nonce>.<sig>', async () => {
    const token = await signSubToken(SECRET)
    const parts = token.split('.')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
    expect(parts[3]).toHaveLength(22)
  })

  it('换密钥验不过', async () => {
    const token = await signSubToken(SECRET)
    const result = await verifySubToken('b'.repeat(64), token)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('signature')
  })

  it('篡改签名末位验不过', async () => {
    const token = await signSubToken(SECRET)
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
    const result = await verifySubToken(SECRET, tampered)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('signature')
  })

  it('篡改过期时间验不过（签名覆盖 exp）', async () => {
    const token = await signSubToken(SECRET, { ttlDays: 7 })
    const parts = token.split('.')
    const forged = `v1.zzzzzzzz.${parts[2]}.${parts[3]}`
    const result = await verifySubToken(SECRET, forged)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('signature')
  })

  it('格式不对直接拒绝', async () => {
    for (const bad of ['', 'v1', 'v1.1', 'v2.0.abc.def', 'v1.0.abc']) {
      const result = await verifySubToken(SECRET, bad)
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('format')
    }
  })

  it('过期后拒绝（含边界）', async () => {
    const now = Date.UTC(2026, 0, 1)
    const token = await signSubToken(SECRET, { ttlDays: 1, now })
    const before = await verifySubToken(SECRET, token, now + 3600_000)
    expect(before.ok).toBe(true)
    const after = await verifySubToken(SECRET, token, now + 2 * 86400_000)
    expect(after.ok).toBe(false)
    expect(after.reason).toBe('expired')
  })
})

describe('密钥管理', () => {
  // ⚠️ 这是**刻意**的行为，与 `loadConfig` 里「UUID 只在 KV 上自动生成」同一条规矩：
  // 未绑定 KV 时每次请求都是新的 MemoryStore，自动生成并写回等于每个请求一把新密钥，
  // 签出来的链接下一个请求就校验失败 —— 与其制造这种「随机 403」，不如不写。
  it('未绑定 KV 时不写回，每次生成新的', async () => {
    const store = new MemoryStore()
    const first = await loadSubSecret(store)
    const second = await loadSubSecret(store)
    expect(first).toHaveLength(64)
    expect(second).not.toBe(first)
    expect(await store.get(SUB_SECRET_KEY)).toBeNull()
  })

  it('轮换会落盘，之后读取稳定', async () => {
    const store = new MemoryStore()
    const fresh = await rotateSubSecret(store)
    expect(await store.get(SUB_SECRET_KEY)).toBe(fresh)
    expect(await loadSubSecret(store)).toBe(fresh)
  })

  it('轮换后旧令牌立即失效', async () => {
    const store = new MemoryStore()
    const secret = await loadSubSecret(store)
    const oldToken = await signSubToken(secret)
    expect((await verifySubToken(secret, oldToken)).ok).toBe(true)

    const fresh = await rotateSubSecret(store)
    expect(fresh).not.toBe(secret)
    // 用旧密钥算出来的令牌，在新密钥下必然验不过
    expect((await verifySubToken(fresh, oldToken)).ok).toBe(false)
    // 新密钥签的新令牌正常
    const newToken = await signSubToken(fresh)
    expect((await verifySubToken(fresh, newToken)).ok).toBe(true)
  })
})
