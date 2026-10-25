/**
 * 多账户凭据存储 —— 回归测试。
 *
 * 守护 2026-10-25 的 v0.5.0 改造：
 *   - 凭据从「单份扁平」升级为「多份可切换的 profile」
 *   - 旧格式（v1）自动迁移，用户不需要重新填 Token
 *   - 激活项切换 / 删除后自动顺延
 *   - `loadSecrets()` 兼容层仍返回激活项，老调用点无需改动
 *
 * 测试用临时 HOME 目录隔离，绝不碰真实的 `~/.cfpilot-gui`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 用一个可控的假 homedir 把 config-store 重定向到临时目录
let fakeHome = ''

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => fakeHome }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: typeof import('../src/main/config-store')

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'cfpilot-prof-'))
  vi.resetModules()
  store = await import('../src/main/config-store')
})

afterEach(() => {
  try {
    rmSync(fakeHome, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

/** 直接写一个 v1 格式（扁平）的 secrets.json，模拟老用户 */
function writeV1File(data: {
  cfToken: string
  accountId?: string
  kvNamespaceId?: string
  panelPassword?: string
}): void {
  const dir = join(fakeHome, '.cfpilot-gui')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify(data, null, 2), 'utf8')
}

describe('v1 → v2 自动迁移', () => {
  it('读旧扁平格式时自动包成一个 profile', () => {
    writeV1File({
      cfToken: 'tok-abc',
      accountId: 'acc-111',
      kvNamespaceId: 'kv-222',
      panelPassword: 'pw-333',
    })
    const list = store.listProfiles()
    expect(list).toHaveLength(1)
    expect(list[0]!.cfToken).toBe('tok-abc')
    expect(list[0]!.accountId).toBe('acc-111')
    expect(list[0]!.kvNamespaceId).toBe('kv-222')
    expect(list[0]!.panelPassword).toBe('pw-333')
  })

  it('迁移后自动激活该 profile', () => {
    writeV1File({ cfToken: 'tok-abc', accountId: 'acc-111' })
    const active = store.activeProfile()
    expect(active).not.toBeNull()
    expect(active!.cfToken).toBe('tok-abc')
  })

  it('迁移结果落盘（再读一次不会重复迁移）', () => {
    writeV1File({ cfToken: 'tok-abc' })
    store.listProfiles() // 触发迁移
    const raw = JSON.parse(readFileSync(join(fakeHome, '.cfpilot-gui', 'secrets.json'), 'utf8'))
    expect(raw.version).toBe(2)
    expect(Array.isArray(raw.profiles)).toBe(true)
    expect(raw.profiles).toHaveLength(1)
  })

  it('loadSecrets 兼容层仍能读到旧数据', () => {
    writeV1File({ cfToken: 'tok-abc', kvNamespaceId: 'kv-222' })
    const s = store.loadSecrets()
    expect(s.cfToken).toBe('tok-abc')
    expect(s.kvNamespaceId).toBe('kv-222')
  })
})

describe('profile 增删改查', () => {
  it('新建 profile 并激活', () => {
    const p = store.createProfile('测试号')
    expect(p.name).toBe('测试号')
    expect(store.activeProfileId()).toBe(p.id)
    expect(store.activeProfile()!.id).toBe(p.id)
  })

  it('新建多份时后建的是激活项', () => {
    const a = store.createProfile('A')
    const b = store.createProfile('B')
    expect(store.listProfiles()).toHaveLength(2)
    expect(store.activeProfileId()).toBe(b.id)
    expect(a.id).not.toBe(b.id)
  })

  it('更新 profile 字段', () => {
    const p = store.createProfile('原名')
    store.updateProfile(p.id, { name: '新名', cfToken: 'tok-x', accountId: 'acc-x' })
    const updated = store.listProfiles().find((x) => x.id === p.id)!
    expect(updated.name).toBe('新名')
    expect(updated.cfToken).toBe('tok-x')
    expect(updated.accountId).toBe('acc-x')
  })

  it('更新不存在的 profile 抛错', () => {
    expect(() => store.updateProfile('nope', { name: 'x' })).toThrow()
  })

  it('updateProfile 不传 name 时跟随 accountName 自动改', () => {
    const p = store.createProfile('新账户')
    store.updateProfile(p.id, { accountName: '32724941@qq.com', accountId: 'acc-9' })
    expect(store.listProfiles().find((x) => x.id === p.id)!.name).toBe('32724941@qq.com')
  })

  it('删除 profile', () => {
    const a = store.createProfile('A')
    const b = store.createProfile('B')
    const res = store.deleteProfile(a.id)
    expect(res.deleted).toBe(true)
    expect(store.listProfiles().map((x) => x.id)).toEqual([b.id])
  })

  it('删除激活项后自动顺延到下一个', () => {
    const a = store.createProfile('A')
    const b = store.createProfile('B') // b 激活
    store.deleteProfile(b.id)
    expect(store.activeProfileId()).toBe(a.id)
  })

  it('删光全部后 activeId 为空', () => {
    const a = store.createProfile('A')
    store.deleteProfile(a.id)
    expect(store.activeProfileId()).toBe('')
    expect(store.listProfiles()).toEqual([])
  })

  it('删除不存在的 id 返回 deleted=false', () => {
    expect(store.deleteProfile('nope').deleted).toBe(false)
  })
})

describe('切换激活账户', () => {
  it('切换后 loadSecrets 返回新账户的凭据', () => {
    const a = store.createProfile('A')
    store.updateProfile(a.id, { cfToken: 'tok-a', kvNamespaceId: 'kv-a' })
    const b = store.createProfile('B')
    store.updateProfile(b.id, { cfToken: 'tok-b', kvNamespaceId: 'kv-b' })

    // 激活的是 b
    expect(store.loadSecrets().cfToken).toBe('tok-b')

    store.setActiveProfile(a.id)
    expect(store.loadSecrets().cfToken).toBe('tok-a')
    expect(store.loadSecrets().kvNamespaceId).toBe('kv-a')
  })

  it('切换到不存在的 id 返回 ok=false 且不改激活项', () => {
    const a = store.createProfile('A')
    const res = store.setActiveProfile('nope')
    expect(res.ok).toBe(false)
    expect(store.activeProfileId()).toBe(a.id)
  })

  it('两账户的 KV 相互独立（核心诉求）', () => {
    const a = store.createProfile('A')
    store.updateProfile(a.id, { kvNamespaceId: 'kv-for-a' })
    const b = store.createProfile('B')
    store.updateProfile(b.id, { kvNamespaceId: 'kv-for-b' })

    // 当前在 B，写 KV 不会污染 A
    store.saveSecrets({ kvNamespaceId: 'kv-b-new' })
    store.setActiveProfile(a.id)
    expect(store.loadSecrets().kvNamespaceId).toBe('kv-for-a')
  })
})

describe('兼容层 saveSecrets', () => {
  it('没有激活 profile 时自动新建一份', () => {
    store.saveSecrets({ cfToken: 'tok-1' })
    expect(store.listProfiles()).toHaveLength(1)
    expect(store.loadSecrets().cfToken).toBe('tok-1')
  })

  it('写入激活 profile 且不影响其他账户', () => {
    const a = store.createProfile('A')
    store.updateProfile(a.id, { cfToken: 'tok-a' })
    const b = store.createProfile('B')
    store.updateProfile(b.id, { cfToken: 'tok-b' })

    store.saveSecrets({ panelPassword: 'pw-b' })
    const list = store.listProfiles()
    expect(list.find((x) => x.id === a.id)!.panelPassword).toBe('')
    expect(list.find((x) => x.id === b.id)!.panelPassword).toBe('pw-b')
  })
})

describe('deriveName：展示名推导', () => {
  it('优先用账号名', () => {
    expect(store.deriveName('我的主账号', 'acc-1')).toBe('我的主账号')
  })

  it('没有账号名时用账号 ID 前 8 位', () => {
    expect(store.deriveName('', 'abcdef1234567890')).toBe('账户 abcdef12')
  })

  it('都没有时回落「新账户」', () => {
    expect(store.deriveName('', '')).toBe('新账户')
  })
})

describe('clearSecrets：清除但保留备份', () => {
  it('清除后 secrets.json 不存在，但留下 .bak', () => {
    store.createProfile('A')
    store.clearSecrets()
    const dir = join(fakeHome, '.cfpilot-gui')
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false)
    expect(existsSync(join(dir, 'secrets.json.bak'))).toBe(true)
  })

  it('清除后 loadSecrets 返回空值而不报错', () => {
    store.createProfile('A')
    store.clearSecrets()
    expect(store.loadSecrets().cfToken).toBe('')
    expect(store.listProfiles()).toEqual([])
  })
})

describe('损坏文件的容错', () => {
  it('JSON 损坏时返回空而不抛错', () => {
    const dir = join(fakeHome, '.cfpilot-gui')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'secrets.json'), '{ 这不是 JSON', 'utf8')
    expect(() => store.listProfiles()).not.toThrow()
    expect(store.listProfiles()).toEqual([])
    expect(store.loadSecrets().cfToken).toBe('')
  })

  it('profiles 里的脏数据被规整而不是崩溃', () => {
    const dir = join(fakeHome, '.cfpilot-gui')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'secrets.json'),
      JSON.stringify({
        version: 2,
        activeId: 'x',
        profiles: [{ id: 'x', cfToken: 123 }, null, 'garbage'],
      }),
      'utf8'
    )
    const list = store.listProfiles()
    expect(list).toHaveLength(1)
    expect(list[0]!.cfToken).toBe('') // 非字符串被转成空
    expect(list[0]!.name).toBe('未命名账户')
  })
})
