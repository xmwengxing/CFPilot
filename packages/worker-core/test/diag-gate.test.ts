/**
 * 运行期指纹收敛 —— 回归测试。
 *
 * 覆盖三件事：
 *
 * 1. **`/__diag` 必须带 token**。诊断内容包含用户最近访问的目标域名与失败原因
 *    （隐私数据）以及 `impl` / `build`（内部实现特征），早前任何人知道域名就能读。
 *    现在只认**完整 UUID**（`?token=` 或 `x-cfpilot-token` 头），未配置 UUID 时一律拒绝。
 *
 *    ⚠️ UUID 前 8 位曾经也能通过 —— 那只有 32 bit 搜空间，
 *    在线枚举即可拿到别人的诊断数据。这条必须保持为「拒绝」。
 *
 * 2. **入站路径的非协议访问必须静默**。早前对非 WebSocket 的 `GET config.wsPath`
 *    返回 `{"ok":false,"error":"该路径需要 WebSocket 升级"}`（400），对非 POST 的
 *    XHTTP 路径返回 405 —— 这些明文响应是最直接的代理指纹。现在一律返回 null，
 *    由外层 `neutralPage(200)` 伪装成普通静态站。
 *
 * 3. **控制面对明显静态路径不触发鉴权引导**。`/`、`/favicon.ico` 等路径不应调用
 *    `getAuth`（那会读 KV，首次引导还会写）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { routeDataPlane } from '../src/routes/data'
import { routeControlPlane } from '../src/routes/control'
import { invalidateConfig } from '../src/routes/shared'
import { neutralPage } from '../src/ui/neutral'
import type { Env } from '../src/types'

const UUID = '11111111-2222-3333-4444-555555555555'
const UUID_SHORT = UUID.slice(0, 8)
const WS_PATH = '/ws-test'
/** 默认配置里的路径（configFromEnv 只允许 WS_PATH 覆盖，Trojan / XHTTP 用内置默认值） */
const TROJAN_PATH = '/trojan'
const XHTTP_PATH = '/xhttp'

/**
 * 数据面 env。
 *
 * 不绑 KV → `createStore` 降级为内存 Store，配置全部来自环境变量，
 * 因此每次请求都能稳定拿到同一个 uuid / wsPath。
 */
function makeDataEnv(): Env {
  return { UUID, WS_PATH }
}

/** 数据面入口的外层兜底，与 `entry-data.ts` / `index.ts` 完全一致 */
async function dataPlane(request: Request, env: Env = makeDataEnv()): Promise<Response> {
  return (await routeDataPlane(request, env)) ?? neutralPage(200)
}

/** 控制面入口的外层兜底，与 `entry-control.ts` 完全一致 */
async function controlPlane(request: Request, env: Env): Promise<Response> {
  return (await routeControlPlane(request, env)) ?? neutralPage(200)
}

/**
 * 一被访问就抛错的 KV 绑定。
 *
 * 控制面静态路径的用例用它证明「一次 KV 读都没发生」：
 * 只要 `getAuth` 被调到，这里就会抛错让用例失败。
 */
function throwingKv(): KVNamespace {
  const fail = (): never => {
    throw new Error('静态路径不应触发任何 KV 访问')
  }
  return { get: fail, put: fail, delete: fail, list: fail } as unknown as KVNamespace
}

/** 断言是中性页（伪装成普通静态站），且不含任何诊断 / 协议 JSON 特征 */
async function expectNeutralPage(res: Response): Promise<string> {
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
  const text = await res.text()
  // 中性页只有 Welcome + 一句静态站文案，绝不能出现结构化错误或实现特征
  expect(text).not.toContain('"impl"')
  expect(text).not.toContain('"ok":false')
  expect(text).not.toContain('WebSocket')
  return text
}

beforeEach(() => {
  // getConfig 有 15 秒模块级缓存；每个用例都必须从自己的 env 重新加载
  invalidateConfig()
})

describe('数据面 /__diag 必须带 token', () => {
  it('无 token → 中性页，不泄露诊断 JSON', async () => {
    const res = await dataPlane(new Request('https://data.example.com/__diag'))
    await expectNeutralPage(res)
  })

  it('token 错误 → 中性页', async () => {
    const res = await dataPlane(
      new Request('https://data.example.com/__diag?token=deadbeef')
    )
    await expectNeutralPage(res)
  })

  it('token = uuid 前 8 位 → 中性页（32 bit 搜空间不可接受）', async () => {
    const res = await dataPlane(
      new Request(`https://data.example.com/__diag?token=${UUID_SHORT}`)
    )
    await expectNeutralPage(res)
  })

  it('token = 完整 uuid → 返回诊断 JSON，且不可缓存', async () => {
    const res = await dataPlane(new Request(`https://data.example.com/__diag?token=${UUID}`))
    expect(res.status).toBe(200)
    // 诊断里有用户访问过的目标域名，绝不能进任何缓存
    expect(res.headers.get('cache-control')).toContain('no-store')
    const data = (await res.json()) as { impl?: string }
    expect(data.impl).toBe('self')
  })

  it('x-cfpilot-token 请求头同样有效', async () => {
    const res = await dataPlane(
      new Request('https://data.example.com/__diag', {
        headers: { 'x-cfpilot-token': UUID },
      })
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as { impl?: string }
    expect(data.impl).toBe('self')
  })

  it('未配置 uuid 时一律拒绝（fail-closed）', async () => {
    // 空 UUID 的部署绝不能因为「uuid 为空」而把诊断公开
    const res = await dataPlane(
      new Request('https://data.example.com/__diag?token='),
      { WS_PATH }
    )
    await expectNeutralPage(res)
  })
})

describe('入站路径的非协议访问静默化', () => {
  it('GET config.wsPath（非 WebSocket 升级）→ 中性页', async () => {
    const res = await dataPlane(new Request(`https://data.example.com${WS_PATH}`))
    const text = await expectNeutralPage(res)
    // 早前这里是 400 + {"ok":false,"error":"该路径需要 WebSocket 升级"}
    expect(text).not.toContain('该路径需要')
  })

  it('GET config.trojanPath（非 WebSocket 升级）→ 中性页', async () => {
    const res = await dataPlane(new Request(`https://data.example.com${TROJAN_PATH}`))
    await expectNeutralPage(res)
  })

  it('GET config.xhttpPath（非 POST）→ 中性页', async () => {
    const res = await dataPlane(new Request(`https://data.example.com${XHTTP_PATH}`))
    const text = await expectNeutralPage(res)
    // 早前这里是 405 + {"ok":false,"error":"XHTTP 需要 POST 请求"}
    expect(text).not.toContain('需要 POST')
  })

  it('/region 仍然无需 token（不触碰 KV 的纯机房诊断）', async () => {
    const res = await dataPlane(new Request('https://data.example.com/region'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const data = (await res.json()) as { ok?: boolean }
    expect(data.ok).toBe(true)
  })
})

describe('控制面：静态路径不触发鉴权引导', () => {
  it('GET / → 中性页，且一次 KV 读都没有发生', async () => {
    // 故意不给 PANEL_PASSWORD / PANEL_PATH：一旦走到 getAuth，它会读 KV →
    // throwingKv 抛错，用例直接失败。
    const env: Env = { KV: throwingKv() }
    const res = await controlPlane(new Request('https://panel.example.com/'), env)
    await expectNeutralPage(res)
  })

  it('GET /favicon.ico、/robots.txt、/assets/app.js 同样不读 KV', async () => {
    const env: Env = { KV: throwingKv() }
    for (const pathname of ['/favicon.ico', '/robots.txt', '/assets/app.js']) {
      const res = await controlPlane(new Request(`https://panel.example.com${pathname}`), env)
      await expectNeutralPage(res)
    }
  })

  it('面板路径本身仍能打开（黑名单不能误伤自定义 PANEL_PATH）', async () => {
    // 面板路径不带扩展名 → 必须继续走 getAuth 并返回面板 HTML，
    // 否则「省 KV 读」的优化会把面板自己打成 404。
    const env: Env = { UUID, WS_PATH, PANEL_PATH: '/my-panel', PANEL_PASSWORD: 'test-pw' }
    const res = await controlPlane(new Request('https://panel.example.com/my-panel'), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('CFPilot 管理控制台')
  })
})
