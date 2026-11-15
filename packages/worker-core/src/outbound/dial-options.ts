/**
 * DialOptions 的统一装配工厂（P1 #9）。
 *
 * ## 为什么需要
 *
 * 此前 4 个入站调用点各自手写一份几乎逐字相同的 15+ 字段装配：
 *   - `websocket-self.ts` establish()（主路径，timeoutMs 5s）
 *   - `websocket-self.ts` redialViaRelay()（重拨，timeoutMs 3s，字段精简）
 *   - `xhttp.ts` ensureDial()（packet-up，不传 timeoutMs → 8s）
 *   - `xhttp.ts` handleStreamOne()（stream-one，同样不传 → 8s）
 *
 * 靠注释「这两项必须与 WS 入站路径保持一致」维持一致性，正是漂移温床：
 * XHTTP 两处漏传 `timeoutMs` / `budgetMs`，全项目也**没有任何调用方**
 * 传过 `budgetMs`（精心设计的 15s 总预算永远取默认值）。
 *
 * 现在所有调用点走这一个工厂，新增配置项只需改一处；`extra` 用于
 * 每条路径特有的字段（onFailure 诊断、重拨的 skipTargetPolicy 等），
 * 且后写覆盖前面，保证「特有值优先」。
 */
import type { UserConfig } from '../types'
import type { DialOptions } from './dial'
import type { ProxyEndpoint } from './proxy-pool'
import { pinnedIpsFor, pinnedRelaysFor } from './pinned'

export interface DialTarget {
  hostname: string
  port: number
}

/**
 * 从运行时配置装配一份完整的 DialOptions。
 *
 * ⚠️ 不要传 `config.add`（面板回填的是 CF 边缘 IP，客户端连 Worker 用的），
 * 它不是「目标站的落地候选」。目标站的落地候选由 `resolvePreferred`
 * 的 DoH 解析负责，两者语义完全不同。
 */
export function buildDialOptions(
  config: UserConfig,
  target: DialTarget,
  proxies: ProxyEndpoint[],
  extra: Partial<DialOptions> = {}
): DialOptions {
  return {
    hostname: target.hostname,
    port: target.port,
    proxies,
    // 时序参数统一来自配置层（P1 #11），4 个调用点不再各写一套
    timeoutMs: config.dialConnectMs,
    budgetMs: config.dialBudgetMs,
    dohBudgetMs: config.dohBudgetMs,
    concurrent: config.concurrentDial,
    nat64: config.nat64 || undefined,
    proxyMode: config.proxyMode,
    resolvePreferred: config.resolvePreferred,
    relayPool: {
      userEntries: config.relayPool || undefined,
      useBuiltin: config.useBuiltinRelay,
    },
    // 固定落地 IP / 固定反代入口：命中则跳过 DNS 轮询与粘性哈希
    pinnedIps: config.pinnedHosts
      ? pinnedIpsFor(config.pinnedHosts, target.hostname, target.port)
      : undefined,
    pinnedRelays: config.pinnedHosts
      ? pinnedRelaysFor(config.pinnedHosts, target.hostname, target.port)
      : undefined,
    ...extra,
  }
}
