/**
 * 无下行时「能不能自动切到内置反代入口」的统一判定。
 *
 * ## 为什么要独立成纯模块
 *
 * 这条判定同时被两条路径使用：2500ms 静默定时器、以及上游秒级 EOF/Reset
 * 的提前结束分支。写死在任何一条路径里，另一条就会漏掉护栏。
 * 抽成不依赖运行时的纯函数后，可以直接用单测把边界钉住。
 *
 * ## 判定原则
 *
 * 自动重拨会把客户端已经发出的上行数据**在另一条上游连接上重放一次**。
 * 因此默认只对「用户没有指定出口、且目标端口适用」的直连假活启用：
 *
 *   - 用户显式配了落地代理 / ProxyIP → 不切。切到内置反代等于静默绕过
 *     用户指定的出口，而且没有任何报错（见架构规范的路径互斥要求）。
 *   - 目标端口不是 443/80 → 不切。内置反代按 SNI 转发，其它端口没有意义。
 *   - 已经收到过目标站响应 → 由调用方负责排除，本模块不参与。
 *
 * `aggressive` 是显式逃生开关：开启后放开通道与端口限制，代价是可能产生
 * 重复请求，调用方必须在诊断里标注。
 */

/** 与 `DialResult.via` 同形；这里用字符串联合，避免反向依赖 dial 模块 */
export type OutboundVia =
  | 'direct'
  | 'nat64'
  | 'socks5'
  | 'http'
  | 'https'
  | undefined

/** 内置反代按 SNI 转发，只有这些端口的目标适用 */
export const RELAY_CAPABLE_PORTS: readonly number[] = [443, 80]

export interface RelayGuardInput {
  /** 当前出站的落地方式；重拨前必须读旧连接的值 */
  via: OutboundVia
  /** 客户端请求的目标端口 */
  port: number
  /** 用户是否显式配置了落地代理或 ProxyIP */
  userProxyConfigured: boolean
  /** 激进模式：放开通道与端口限制 */
  aggressive: boolean
}

export interface RelayGuardVerdict {
  allowed: boolean
  /** 允许/拒绝的原因，直接进诊断与 close reason */
  reason: string
}

export function canSwitchToBuiltinRelay(input: RelayGuardInput): RelayGuardVerdict {
  if (input.aggressive) {
    return { allowed: true, reason: '激进模式允许切换（可能重复请求）' }
  }
  const via = input.via
  if (via && via !== 'direct' && via !== 'nat64') {
    return { allowed: false, reason: `当前走落地代理(${via})，切换会绕过用户指定出口` }
  }
  if (input.userProxyConfigured) {
    // ProxyIP 的 `via` 也是 direct，无法从出口类型区分；
    // 配置本身是「用户指定了出口」的明确信号，按保守原则处理。
    return { allowed: false, reason: '已配置落地代理或 ProxyIP，不自动切换出口' }
  }
  if (!RELAY_CAPABLE_PORTS.includes(input.port)) {
    return { allowed: false, reason: `目标端口 ${input.port} 不支持反代 SNI 转发` }
  }
  return { allowed: true, reason: '直连出口且端口适用' }
}
