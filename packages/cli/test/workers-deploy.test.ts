/**
 * Workers 数据面部署原语的单元测试。
 *
 * 只测**纯逻辑**与权限判定：真正上传要打真实 API，放在真机验证里做，
 * 否则单测会变成「网络抖动即失败」的噪声源。
 *
 * 2026-10-31 重构：工具不再托管自定义域名（不绑 domain、不清 DNS），
 * 因此这里不再有 zone / DNS 相关用例 —— 那些代码已经删掉了。
 */
import { describe, expect, it } from 'vitest'
import { CloudflareError, type CloudflareClient } from '../src/deploy/cf-api'
import {
  describeWorkersPermissionError,
  isPermissionError,
  preflightWorkersDataPlane,
  workersDevHost,
  WORKERS_COMPAT_DATE,
} from '../src/deploy/workers-deploy'

describe('workersDevHost', () => {
  it('有子域时拼成 <name>.<sub>.workers.dev', () => {
    expect(workersDevHost('abc123', 'wxgo8609')).toBe('abc123.wxgo8609.workers.dev')
  })

  it('没注册子域时退回 <name>.workers.dev（调用方会告警）', () => {
    expect(workersDevHost('abc123', '')).toBe('abc123.workers.dev')
    expect(workersDevHost('abc123', '   ')).toBe('abc123.workers.dev')
  })
})

describe('权限错误识别', () => {
  it('401 / 403 判为权限问题', () => {
    expect(isPermissionError(new CloudflareError('Authentication error', 403))).toBe(true)
    expect(isPermissionError(new CloudflareError('Unauthorized', 401))).toBe(true)
  })

  it('5xx 与普通异常不判为权限问题（否则会让人白改 Token）', () => {
    expect(isPermissionError(new CloudflareError('boom', 500))).toBe(false)
    expect(isPermissionError(new Error('dial timeout'))).toBe(false)
  })

  it('权限错误必须给出「去哪勾什么」', () => {
    const message = describeWorkersPermissionError(
      new CloudflareError('Authentication error', 403),
      'scripts'
    )
    expect(message).toBeTruthy()
    expect(message).toContain('Workers Scripts')
    expect(message).toContain('Edit')
  })

  it('非权限错误返回 null（交给调用方按普通失败处理）', () => {
    expect(describeWorkersPermissionError(new CloudflareError('boom', 500), 'scripts')).toBeNull()
  })
})

describe('preflightWorkersDataPlane', () => {
  it('缺 Workers 脚本权限 → 在创建任何资源之前中止', async () => {
    const client = {
      listScripts: async () => {
        throw new CloudflareError('Authentication error', 403)
      },
      getWorkersSubdomain: async () => 'wxgo8609',
    } as unknown as CloudflareClient

    await expect(preflightWorkersDataPlane(client, 'acct', () => {}, [])).rejects.toThrow(
      /Workers Scripts/
    )
  })

  it('没有 workers.dev 子域 → 只告警（还能部署，但节点域名不可用）', async () => {
    const client = {
      listScripts: async () => [],
      getWorkersSubdomain: async () => '',
    } as unknown as CloudflareClient

    const warnings: string[] = []
    await preflightWorkersDataPlane(client, 'acct', () => {}, warnings)
    expect(warnings.join('')).toContain('workers.dev')
  })

  it('权限与子域都正常 → 不告警', async () => {
    const client = {
      listScripts: async () => [{ id: 'a' }, { id: 'b' }],
      getWorkersSubdomain: async () => 'wxgo8609',
    } as unknown as CloudflareClient

    const warnings: string[] = []
    const logs: string[] = []
    await preflightWorkersDataPlane(client, 'acct', (m) => logs.push(m), warnings)
    expect(warnings).toEqual([])
    expect(logs.join('')).toContain('wxgo8609')
  })
})

describe('WORKERS_COMPAT_DATE', () => {
  it('必须是可复现的固定日期（不能是当天）', () => {
    expect(WORKERS_COMPAT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(WORKERS_COMPAT_DATE).not.toBe(new Date().toISOString().slice(0, 10))
  })
})
