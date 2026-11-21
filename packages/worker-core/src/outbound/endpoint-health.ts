/**
 * 全类型出站端点的健康记忆（P2 #14，isolate 级、绝不写 KV）。
 *
 * ## 从「只管代理」泛化到所有候选
 *
 * `proxy-health.ts` 已经解决了「落地代理组里混进一个宕机节点，每个请求
 * 都要先白等一次完整超时」的问题，但 `recordProxySuccess/Failure` 只在
 * **代理候选**上调用 —— 反代入口、优选 IP、直连全都没有健康记忆。
 *
 * 而静态反代入口池会随时间失效（真机实测：入口 IP 被目标站 WAF 拉黑、
 * 或第三方服务下线），失效入口仍会被 `stableRelayIndex` 一次次选中，
 * 每次请求都重复付一次连接超时。
 *
 * 这里把同一套「连续失败 → 指数冷却 → 全冷却回退」范式泛化到
 * `source|host:port` 键上，供 `dial.ts` 的 `attemptOf` 统一记账。
 *
 * ## 两条必须守住的边界
 *
 * 1. **目标站拒绝 ≠ 节点坏**（`TargetRejectedError`）：代理回了拒绝应答
 *    说明它是活的，只是这个出口不被目标站接受。记成坏节点会误伤。
 * 2. **不写 KV**（§1.30）：健康状态秒级变化，KV 写配额 1000/天，
 *    写它既慢又会把配额打光。isolate 级内存 + 条数上限即可。
 *
 * ## 能力边界
 *
 * 只在同一个 isolate 内有效（热 isolate 会复用）；换 isolate 需重新付
 * 一次超时，属可接受的冷启动代价。**假活**（connect 成功但 0 下行）
 * 在 `attemptOf` 里是「成功」，这份记忆管不到 —— 那是 WS 下行泵的
 * 假活重拨链路负责的，两者不重叠。
 */
import { TargetRejectedError } from './proxy-health'

/** 连续失败多少次后进入冷却 */
const FAIL_THRESHOLD = 2
/** 首次冷却时长；连续失败越多，冷却越久（翻倍） */
const BASE_COOLDOWN_MS = 30_000
/** 冷却上限 */
const MAX_COOLDOWN_MS = 5 * 60_000
/**
 * 「不足阈值的失败记录」保留多久（ms）。
 *
 * 超过这个时间没有再失败，说明那只是一次偶发抖动，不必继续累计到阈值。
 * 保留它是有必要的：**第一次失败时 `cooldownUntil` 还是 0**，若按
 * 「`cooldownUntil <= now` 就删」来清理，第二次失败到来前记录就被删掉，
 * 计数永远停在 1 —— 阈值 2 永远不会触发，整套健康记忆实际失效。
 */
const FAIL_DECAY_MS = 10 * 60_000
/** 表大小上限：防止长生命周期 isolate 无限累积（§2.2.G 内存纪律） */
const MAX_ENTRIES = 256

interface HealthState {
  fails: number
  cooldownUntil: number
  /** 最后一次失败时刻（用于「不足阈值记录」的衰减清理） */
  lastFailAt: number
}

const HEALTH = new Map<string, HealthState>()

/** 端点唯一标识：来源 + 地址。与 proxyHealthKey 的口径一致（不含凭据）。 */
export function endpointKey(source: string, host: string, port: number): string {
  return `${source}|${host}:${port}`
}

/** 当前是否在冷却期内 */
export function isEndpointCooled(key: string, now: number): boolean {
  const state = HEALTH.get(key)
  return state !== undefined && state.cooldownUntil > now
}

/**
 * 清掉过期条目；仍超上限就按插入顺序淘汰最旧的。
 *
 * ⚠️ 只清理**两种**条目：
 *   1. 冷却期已过的（`cooldownUntil > 0 && <= now`）；
 *   2. 距最后一次失败已超过 `FAIL_DECAY_MS`。
 * 绝不能在 `cooldownUntil === 0` 时按「<= now」删 —— 那会把「只失败过一次、
 * 还没到阈值」的记录一起抹掉，阈值永远不会被触发（见 HealthState.lastFailAt）。
 */
function prune(now: number): void {
  for (const [key, state] of HEALTH) {
    const cooled = state.cooldownUntil > 0 && state.cooldownUntil <= now
    const stale = now - state.lastFailAt >= FAIL_DECAY_MS
    if (cooled || stale) HEALTH.delete(key)
  }
  while (HEALTH.size >= MAX_ENTRIES) {
    const oldest = HEALTH.keys().next().value
    if (oldest === undefined) break
    HEALTH.delete(oldest)
  }
}

/**
 * 记一次失败。`targetRejected` 为 true 时**不计入**（目标站拒绝 ≠ 节点坏）。
 */
export function recordEndpointFailure(key: string, now: number, targetRejected: boolean): void {
  if (targetRejected) return
  prune(now)
  const state = HEALTH.get(key) ?? { fails: 0, cooldownUntil: 0, lastFailAt: 0 }
  state.fails += 1
  state.lastFailAt = now
  if (state.fails >= FAIL_THRESHOLD) {
    const over = state.fails - FAIL_THRESHOLD
    state.cooldownUntil = now + Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** over)
  }
  HEALTH.set(key, state)
}

/** 记一次成功 —— 之前的失败与冷却全部清掉 */
export function recordEndpointSuccess(key: string): void {
  HEALTH.delete(key)
}

/**
 * 把候选按健康记忆做**稳定排序**：冷却中的排到后面，其余保持原顺序。
 *
 * ⚠️ 不删除任何候选（窗口化 ≠ 截断，§1.31）：全部仍在冷却时顺序不变，
 * 宁可多付几次超时也不能把链路锁死。
 */
export function sortByEndpointHealth<T>(
  candidates: readonly T[],
  keyOf: (candidate: T) => string,
  now: number
): T[] {
  const out = [...candidates]
  // 稳定排序（ES2019 起 Array#sort 保证稳定）
  out.sort((a, b) => {
    const aCool = isEndpointCooled(keyOf(a), now) ? 1 : 0
    const bCool = isEndpointCooled(keyOf(b), now) ? 1 : 0
    return aCool - bCool
  })
  return out
}

/** 只给测试用 */
export function clearEndpointHealth(): void {
  HEALTH.clear()
}

export function endpointHealthSize(): number {
  return HEALTH.size
}

/**
 * 反代入口的「按域名成功记忆」：hostname → 上次真正成功的入口。
 *
 * 放在 endpoint-health 模块里（而不是 dial.ts），让 dial 与 websocket-self
 * 共享同一份状态，且不污染仅 mock `outbound/dial` 的既有单测。
 */
const RELAY_SUCCESS_MEMORY = new Map<string, { ip: string; port: number }>()
const RELAY_SUCCESS_MEMORY_MAX = 128

/** 从 `ip:port` / `[v6]:port` 形式的 endpoint 里取出入口地址。 */
export function relayEntryFromEndpoint(endpoint: string): { ip: string; port: number } | undefined {
  const i = String(endpoint ?? '').lastIndexOf(':')
  if (i <= 0) return undefined
  const ip = endpoint.slice(0, i).replace(/^\[/, '').replace(/\]$/, '')
  const port = Number(endpoint.slice(i + 1))
  if (!ip || !Number.isFinite(port) || port <= 0) return undefined
  return { ip, port }
}

/** 记录某域名的反代成功入口（同时刷新「最近使用」顺序）。 */
export function rememberRelaySuccess(hostname: string, ip: string, port: number): void {
  const host = String(hostname ?? '').trim().toLowerCase()
  if (!host || !ip || !port) return
  RELAY_SUCCESS_MEMORY.delete(host)
  RELAY_SUCCESS_MEMORY.set(host, { ip, port })
  while (RELAY_SUCCESS_MEMORY.size > RELAY_SUCCESS_MEMORY_MAX) {
    const oldest = RELAY_SUCCESS_MEMORY.keys().next().value
    if (oldest === undefined) break
    RELAY_SUCCESS_MEMORY.delete(oldest)
  }
}

/** 取某域名的反代成功记忆。 */
export function relaySuccessFor(hostname: string): { ip: string; port: number } | undefined {
  const host = String(hostname ?? '').trim().toLowerCase()
  return host ? RELAY_SUCCESS_MEMORY.get(host) : undefined
}

/**
 * 标记某反代入口对指定域名失效（TLS 致命告警 / 零下行假活 / 秒级 EOF）：
 * 立即清除该域名的成功记忆并记入熔断冷却。
 */
export function penalizeRelayEndpoint(
  hostname: string,
  endpoint: string,
  immediateCool = true
): void {
  const parsed = relayEntryFromEndpoint(endpoint)
  if (!parsed) return
  const host = String(hostname ?? '').trim().toLowerCase()
  const remembered = host ? RELAY_SUCCESS_MEMORY.get(host) : undefined
  if (remembered && remembered.ip === parsed.ip && remembered.port === parsed.port) {
    RELAY_SUCCESS_MEMORY.delete(host)
  }
  const key = endpointKey('relay', parsed.ip, parsed.port)
  const now = Date.now()
  recordEndpointFailure(key, now, false)
  if (immediateCool) {
    recordEndpointFailure(key, now, false)
  }
}

/** 在收到有效下行首字节后回写成功记忆并恢复健康。 */
export function confirmRelaySuccess(hostname: string, endpoint: string): void {
  const parsed = relayEntryFromEndpoint(endpoint)
  if (!parsed) return
  rememberRelaySuccess(hostname, parsed.ip, parsed.port)
  recordEndpointSuccess(endpointKey('relay', parsed.ip, parsed.port))
}

/** 清空成功记忆（测试用）。 */
export function clearRelaySuccessMemory(): void {
  RELAY_SUCCESS_MEMORY.clear()
}
