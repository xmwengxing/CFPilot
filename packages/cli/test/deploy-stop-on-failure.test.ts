/**
 * 部署「一次失败就停」—— 回归测试。
 *
 * ## 为什么钉住这个行为
 *
 * 旧实现是「同名重试 3 次 → 换随机项目名再来 → 换名后再 3 次」，
 * 一次部署最坏打出 **9 次部署请求 + 6 个新项目**。
 *
 * 而 Cloudflare 的账号级风控画像按**发布事件的累积量**算。
 * 用户已反馈：连续部署导致账号被封 —— 8000119 命中后继续重试，
 * 写的还是同一份被标记的代码，等于把风控画像坐实。
 *
 * 所以：**一次失败就停** —— 不重试、不换名重建。
 */
import { describe, it, expect } from 'vitest'
import { deployOnce } from '../src/deploy/pages-deploy'
import type { CloudflareClient } from '../src/deploy/cf-api'

/** 记录调用次数的假客户端。 */
function fakeClient(failTimes: number): {
  client: CloudflareClient
  deployCalls: string[]
} {
  const deployCalls: string[] = []
  let remaining = failTimes
  const client = {
    async deployPagesWorker(_accountId: string, name: string) {
      deployCalls.push(name)
      if (remaining > 0) {
        remaining--
        throw new Error('HTTP 400，code 8000119：Your Pages project has been blocked')
      }
      return { id: 'dep-1' }
    },
    async getPagesProject(_accountId: string, name: string) {
      return { name, subdomain: `${name}.pages.dev` }
    },
    async getPagesDeployments() {
      return [{ id: 'dep-1', latest_stage: { status: 'success' } }]
    },
    async createPagesProject() {
      throw new Error('不应被调用：失败后不该换名重建')
    },
    async removePagesDomain() {
      throw new Error('不应被调用')
    },
    async addPagesDomain() {
      throw new Error('不应被调用')
    },
    async deletePagesProject() {
      throw new Error('不应被调用')
    },
  } as unknown as CloudflareClient
  return { client, deployCalls }
}

const baseParams = {
  accountId: 'acc-1',
  preferredName: 'cpdata',
  code: 'export default { fetch() {} }',
  label: '数据面',
  result: { data: { name: '', subdomain: '', deploymentId: '' }, control: { name: '', subdomain: '', deploymentId: '' } },
  options: {},
  effective: { panelPath: '/p', panelPassword: 'pw', uuid: 'u', trojanPassword: 't', wsPath: '/w' },
  wait: { timeoutMs: 2000, intervalMs: 10 },
  log: () => undefined,
  warnings: [] as string[],
} as unknown as Parameters<typeof deployOnce>[0]

describe('部署失败即停', () => {
  it('第一次失败就停：不重试、不换名重建', async () => {
    const { client, deployCalls } = fakeClient(999)
    const warnings: string[] = []

    const res = await deployOnce({ ...baseParams, client, warnings })

    expect(res).toBeNull()
    // ⚠️ 只该尝试 1 次
    expect(deployCalls.length).toBe(1)
    expect(deployCalls[0]).toBe('cpdata')
    // ⚠️ 不该出现换名项目
    expect(deployCalls.some((n) => n.startsWith('cpdata-'))).toBe(false)
    // 提示要说清「已停止」与「为什么」
    expect(warnings.join('\n')).toContain('已停止')
    expect(warnings.join('\n')).toContain('不再重试')
  })

  it('成功时正常返回，且不碰域名与旧项目', async () => {
    const { client, deployCalls } = fakeClient(0)
    const warnings: string[] = []

    const res = await deployOnce({ ...baseParams, client, warnings })

    expect(res).not.toBeNull()
    expect(res?.project).toBe('cpdata')
    expect(deployCalls.length).toBe(1)
    expect(warnings.length).toBe(0)
  })
})
