/**
 * 订阅渲染上限折算 —— 回归测试。
 *
 * ## 守护的缺陷（Gemini 审计 P2-1）
 *
 * `RENDER_NODE_LIMIT = 500` 只截**基础节点**，而订阅渲染会按
 * `subPorts`（最多 6 个）× `subVariants`（最多 3 种）做笛卡尔积展开：
 * 500 × 18 = 9000 条最终节点。订阅渲染是纯 CPU 工作，免费版单请求只有 10 ms，
 * 展开后的 YAML 拼接会把请求直接顶成 1102。
 *
 * 现在上限按展开倍数折算，总展开条目控制在 `base` 附近。
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG } from '../src/config'
import { effectiveNodeLimit } from '../src/sub-engine'

describe('effectiveNodeLimit', () => {
  it('默认配置（单端口、两形态 vless-ws+vless-xhttp）→ 250', () => {
    // 默认开启 XHTTP 后形态数由 1 变 2，上限按 2 倍折算（500/2）。
    expect(effectiveNodeLimit(DEFAULT_CONFIG)).toBe(250)
  })

  it('6 端口 × 3 形态 → 按 18 倍折算', () => {
    const config = {
      ...DEFAULT_CONFIG,
      subPorts: '443,2053,2083,2087,2096,8443',
      subVariants: 'vless-ws,vless-xhttp,trojan',
    }
    expect(effectiveNodeLimit(config)).toBe(Math.floor(500 / 18))
  })

  it('多端口但单形态 → 只按端口折算', () => {
    const config = { ...DEFAULT_CONFIG, subPorts: '443,8443', subVariants: 'vless-ws' }
    expect(effectiveNodeLimit(config)).toBe(250)
  })

  it('极限配置下仍有下限（不会一条节点都不给）', () => {
    const config = {
      ...DEFAULT_CONFIG,
      subPorts: '443,2053,2083,2087,2096,8443',
      subVariants: 'vless-ws,vless-xhttp,trojan',
    }
    expect(effectiveNodeLimit(config, 20)).toBeGreaterThanOrEqual(10)
  })
})
