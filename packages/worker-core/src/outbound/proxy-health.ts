/**
 * 出站代理节点的健康记忆（isolate 级）。
 *
 * ## 为什么需要
 *
 * 落地代理组是**顺序故障转移**（见 `dial.ts` 的 `dialLanding`）：
 * 第一个失败才试第二个。
 *
 * 于是当用户配了多个落地代理、而其中一个已经宕机时，
 * **每一个请求都要先白等一次完整的代理超时**才轮到还活着的那个 ——
 * 一个死节点能把整条链路拖成「半瘫痪」，而且每个请求都重复付这笔账。
 *
 * 这份记忆的作用就是：**连续失败的节点进入冷却，冷却期内直接跳过**。
 *
 * ## 两个必须分清的情况
 *
 * 代理连不上（死节点）与「代理连上了、但目标站拒绝了」是两回事：
 *
 *   - 前者说明这个节点该被跳过；
 *   - 后者说明这个节点**是好的**（目标站不收这个出口而已）。
 *
 * 混为一谈会让「某个站点不收某个出口」变成「整个代理被拉黑」，
 * 害处比原来的问题更大。所以目标站侧的拒绝用 {@link TargetRejectedError} 单独标记，
 * **不计入健康统计**。
 *
 * ## 能力边界（必须知道）
 *
 * 这份记忆是**模块级内存**，只在**同一个 isolate** 内有效：
 *
 * - 同一 isolate 连续处理的请求能互相避开坏节点（isolate 是热的，会复用）；
 * - 换到别的 isolate 就得重新付一次超时 —— 属于可接受的冷启动代价。
 *
 * 刻意**不写 KV**：写配额是硬约束（每天 1000 次），
 * 而代理健康是秒级变化的状态，写 KV 既慢又会把配额打光。
 */
import type { ProxyKind } from './proxy-pool'

/**
 * 代理节点的标识（够用来认人就行）。
 *
 * 只取 kind + host + port：凭据不影响「这个节点活着没有」，
 * 而把凭据塞进键里会让同一个节点换密码后变成另一个身份。
 */
export interface ProxyIdentity {
  kind: ProxyKind
  host: string
  port: number
}

/**
 * 「代理是好的，但目标站拒绝了」这类失败。
 *
 * 由 `socks5.ts` / `http-proxy.ts` 在收到代理的**拒绝应答**时抛出 ——
 * 此时代理已经证明自己活着（它回了应答），所以不能把它记成坏节点。
 */
export class TargetRejectedError extends Error {}

/** 连续失败多少次后进入冷却 */
const FAIL_THRESHOLD = 2
/** 首次冷却时长；连续失败越多，冷却越久（翻倍） */
const BASE_COOLDOWN_MS = 30_000
/** 冷却上限 */
const MAX_COOLDOWN_MS = 5 * 60_000

interface HealthState {
  /** 连续失败次数（成功一次就清零） */
  fails: number
  /** 冷却到什么时候（毫秒时间戳） */
  cooldownUntil: number
}

/** isolate 级的健康记忆 */
const HEALTH = new Map<string, HealthState>()

/** 节点的唯一标识 */
export function proxyHealthKey(p: ProxyIdentity): string {
  return `${p.kind}://${p.host}:${p.port}`
}

/** 节点当前是否在冷却期内 */
export function isProxyInCooldown(p: ProxyIdentity, now: number): boolean {
  const state = HEALTH.get(proxyHealthKey(p))
  return state !== undefined && state.cooldownUntil > now
}

/**
 * 记一次失败。
 *
 * 连续失败到阈值就进入冷却；冷却时长随连续失败次数翻倍（30s → 60s → … → 5min 封顶）。
 */
export function recordProxyFailure(p: ProxyIdentity, now: number): void {
  const key = proxyHealthKey(p)
  const state = HEALTH.get(key) ?? { fails: 0, cooldownUntil: 0 }
  state.fails += 1
  if (state.fails >= FAIL_THRESHOLD) {
    const over = state.fails - FAIL_THRESHOLD
    const cooldown = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** over)
    state.cooldownUntil = now + cooldown
  }
  HEALTH.set(key, state)
}

/** 记一次成功 —— 之前的失败与冷却全部清掉 */
export function recordProxySuccess(p: ProxyIdentity): void {
  HEALTH.delete(proxyHealthKey(p))
}

/**
 * 把候选列表按健康记忆过滤一遍。
 *
 * `idOf` 从候选里取出它的代理身份；取不到（非代理候选）的一律保留。
 *
 * ⚠️ **全部都在冷却时必须回退到全量**：
 * 否则「所有节点都曾经失败过」会把这条链路彻底锁死 ——
 * 而节点可能只是短暂抖动。宁可多付几次超时，也不能让整条链路不可用。
 */
export function filterHealthy<T>(
  candidates: readonly T[],
  idOf: (candidate: T) => ProxyIdentity | undefined,
  now: number
): T[] {
  if (candidates.length <= 1) return candidates as T[]
  const ready = candidates.filter((c) => {
    const id = idOf(c)
    return id === undefined || !isProxyInCooldown(id, now)
  })
  return ready.length > 0 ? ready : (candidates as T[])
}

/** 只给测试用 */
export function clearProxyHealth(): void {
  HEALTH.clear()
}
