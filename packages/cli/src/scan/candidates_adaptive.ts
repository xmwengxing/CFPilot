/**
 * 自适应采样内核（唯一权威实现）。
 *
 * 桌面版对应 internal/scan/adaptive_sampling.go 的 SampleAdaptiveCandidates，
 * 两边的常量、公式与步骤必须一一对应 —— 常量不同会让同一个档案在两端
 * 得出不同的网段权重，历史就失去意义。
 */
import { IPV6_ACTIVE_PREFIXES, cidrWeight, makeWeightFn, parseCidr } from './ip-ranges'
import type { ProfileStoreDocument, SamplingCandidate } from './network-profile'

/**
 * 网段分配的先验参数。
 *
 * 对应「全局先验成功率 70%，折算成 8 个虚拟样本」：
 * 平滑公式 P = (S + 5.6) / (N + 8)。
 *
 * 样本少时权重靠近先验，样本多时真实数据占主导。
 */
export const LEARN_PRIOR_ALPHA = 5.6
export const LEARN_PRIOR_BETA = 2.4
export const LEARN_PRIOR_TOTAL = LEARN_PRIOR_ALPHA + LEARN_PRIOR_BETA

/** 权重的下限：历史再差也保留一点点，不至于完全失去被探索的机会。 */
export const MIN_WEIGHT = 0.02

/** 集中度上限：同一个 /24 家族最多取「候选数 × 该比例」个。 */
export const MAX_PREFIX_SHARE = 0.05

/**
 * 可枚举的桶大小上限。
 *
 * 桶内地址数超过这个值时改为**随机取址**（只记录已用偏移），
 * 不再枚举 —— IPv6 段动辄 2^80 个地址，枚举会把内存吃光。
 */
const ENUMERABLE_BUCKET_SIZE = 65536n

/** 单个桶的容量上限（容量只用于分配预算，截断即可）。 */
const MAX_BUCKET_CAPACITY = 1e9

/** 一个网段桶的历史观测汇总。 */
interface SegmentObservation {
  attempts: number
  successes: number
  decay: number
}

/**
 * 网段的有效权重：静态权重与学习到的成功率做 Beta 平滑。
 *
 * 与桌面版（internal/scan/adaptive_sampling.go 的 DynamicPrefixWeight）一致：
 *   W = (static × prior + successes × decay) / (prior + attempts × decay)
 *
 * 零静态权重的网段**保持 0**：它只参与探索，不参与利用，
 * 否则「某个网段在这个网络里一直失败」的结论会被历史慢慢磨平。
 */
function effectiveSegmentWeight(staticWeight: number, observation?: SegmentObservation): number {
  if (staticWeight <= 0) return 0
  if (!observation) return staticWeight
  const numerator = staticWeight * LEARN_PRIOR_TOTAL + observation.successes * observation.decay
  const denominator = LEARN_PRIOR_TOTAL + observation.attempts * observation.decay
  if (denominator <= 0) return staticWeight
  return Math.max(MIN_WEIGHT, Math.min(1, numerator / denominator))
}

/**
 * 探索配额：留给「均匀探索」的候选数。
 *
 * 对照桌面版的 ExploreBudget —— 两端必须一致，
 * 否则同一个探索比例在两端会变成不同的配额。
 */
export function exploreBudget(count: number, explorationRate: number): number {
  const rate = Math.min(1, Math.max(0, explorationRate))
  return Math.ceil(count * rate)
}

/**
 * 集中度上限：同一个 /24 家族最多可取的候选数。
 *
 * 对照桌面版的 PrefixCap。
 */
export function prefixCap(count: number, share: number = MAX_PREFIX_SHARE): number {
  const ratio = Math.min(1, Math.max(0, share))
  return Math.max(1, Math.ceil(count * ratio))
}

/**
 * 自适应采样池。
 *
 * ## 与桌面版的对应关系
 *
 * 本函数是**唯一权威实现**（AGENTS.md §2.2：CLI 先定语义，桌面版照做）。
 * 桌面版对应 internal/scan/adaptive_sampling.go 的 SampleAdaptiveCandidates，
 * 两边的步骤必须一一对应：
 *
 *  1. 合并 CIDR 区间；
 *  2. 按 24 位对齐切成桶（IPv6 按 48 位）—— 观测也是按 24 位记的，粒度必须一致；
 *  3. 每桶算权重（静态权重 × Beta 平滑）；
 *  4. 抽取：先探索（配额 = ceil(count × 探索比例)，权重一律视为 1），
 *     再利用（按「剩余容量 × 权重」加权抽取）；
 *  5. 集中度上限：同一个 /24 家族最多取 ceil(count × 5%) 个。
 *
 * 零静态权重的网段**只在探索阶段**出现（不参与利用），
 * 固定探索比例保证历史结论不会把采样池锁死。
 */
export function adaptivePool(
  cidrs: string[],
  limit: number,
  includeZero: boolean,
  neutral: boolean,
  random: () => number,
  store?: ProfileStoreDocument,
  options?: {
    explorationRate?: number
    now?: number
    halfLifeMs?: number
    profileId?: string
    /**
     * 按地址族分的档案 ID。
     *
     * 档案 ID 由「运营商 + 地址族 + …」哈希得到，两族天然不同 ——
     * 采样时必须按族去查各自的观测，否则 v6 的历史永远查不到
     * （或者更糟：查成 v4 的历史）。
     * 不传时回退到 `profileId`（单档案场景 / 跨语言一致性用例）。
     */
    profileIds?: { v4?: string; v6?: string }
    /** 运行期发现的活跃 IPv6 /48（由域名 AAAA 展开），与静态表合并使用 */
    extraWeights?: Record<string, number>
  },
): SamplingCandidate[] {
  type Interval = { family: 4 | 6; start: bigint; end: bigint }
  const count = Math.max(0, Math.floor(limit))
  if (count === 0) return []
  const ranges = cidrs.map(parseCidr).filter((item): item is NonNullable<ReturnType<typeof parseCidr>> => item !== null)
    .map((item): Interval => ({ family: item.family, start: item.base, end: item.base + item.size }))
    .sort((a, b) => a.family - b.family || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  const merged: Interval[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && previous.family === range.family && range.start <= previous.end) previous.end = previous.end > range.end ? previous.end : range.end
    else merged.push({ ...range })
  }
  const format = (value: bigint, family: 4 | 6): string => family === 4
    ? [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 255n).toString()).join('.')
    : Array.from({ length: 8 }, (_, index) => ((value >> BigInt(112 - index * 16)) & 65535n).toString(16)).join(':')
  // 族相关的权重函数：v4 查 IPv4 表，v6 查 IPv6 表 ∪ 运行期发现的活跃段
  const weightFn = makeWeightFn(options?.extraWeights)
  const now = options?.now ?? Date.now()
  const halfLife = options?.halfLifeMs ?? 7 * 24 * 60 * 60 * 1000
  const profileId = options?.profileId ?? ''
  /** 该族查哪份档案的观测：族内隔离，见 options.profileIds 的注释 */
  const profileIdFor = (family: 4 | 6): string =>
    (family === 4 ? options?.profileIds?.v4 : options?.profileIds?.v6) ?? profileId

  // ---- v6 活跃 /48 预解析（只对已知活跃段建桶，理由见下面的分支注释）----
  const activeV6: Array<{ base: bigint; prefix: string }> = []
  const seenV6 = new Set<string>()
  for (const cidr of [...IPV6_ACTIVE_PREFIXES, ...Object.keys(options?.extraWeights ?? {})]) {
    if (seenV6.has(cidr)) continue
    const parsed = parseCidr(cidr)
    if (!parsed || parsed.family !== 6) continue
    seenV6.add(cidr)
    activeV6.push({ base: parsed.base, prefix: cidr })
  }

  type Bucket = {
    family: 4 | 6
    start: bigint
    end: bigint
    staticWeight: number
    weight: number
    capacity: number
    used: number
    order?: bigint[]
    /** 已用偏移（大桶用随机取样时记录，避免重复） */
    usedOffsets: Set<bigint>
    /** 集中度上限的分组键：IPv4 按 /24，IPv6 按 /48 */
    family24: bigint
    /**
     * 观测前缀 —— **必须与 network-profile 的 networkBucket() 逐字节一致**，
     * 否则写进档案的历史永远查不到（v6 观测学不到就是这么来的：
     * 旧实现写的是 8 组不压缩的裸地址，档案里存的是 `xxxx::/48`）。
     */
    obsPrefix: string
  }
  const buckets: Bucket[] = []
  for (const range of merged) {
    if (range.family === 6) {
      // IPv6：**只对已知活跃 /48 建桶**，不给未知段建桶。
      //
      // 两个理由（2026-11-03 实测）：
      //   1. 在公布聚合段里随机抽 /48 **0/18 全超时** —— 给未知 /48 建桶
      //      等于把探索预算全烧在死地址上，探索命中率约等于 0；
      //   2. 一个 /32 按 /48 切是 65536 个桶，内存与时间都不可接受。
      // 新的活跃段只能由「域名 AAAA」与「人工复测后的静态表」引入。
      for (const active of activeV6) {
        const overlapStart = active.base > range.start ? active.base : range.start
        const activeEnd = active.base + (1n << 80n)
        const overlapEnd = activeEnd < range.end ? activeEnd : range.end
        if (overlapStart >= overlapEnd) continue
        const size = overlapEnd - overlapStart
        const staticWeight = weightFn(active.prefix)
        if (staticWeight <= 0 && !includeZero) continue
        const observation = bucketObservation(active.prefix, 6, store, profileIdFor(6), now, halfLife)
        const weight = neutral && staticWeight > 0 ? 1 : effectiveSegmentWeight(staticWeight, observation)
        let capacity = Number(size)
        // /48 有 2^80 个地址 —— 容量只用于分配预算，钳到有限值即可
        if (!Number.isFinite(capacity) || capacity > MAX_BUCKET_CAPACITY) capacity = MAX_BUCKET_CAPACITY
        buckets.push({
          family: 6,
          start: overlapStart,
          end: overlapEnd,
          staticWeight,
          weight,
          capacity: Math.max(0, capacity),
          used: 0,
          usedOffsets: new Set<bigint>(),
          family24: active.base,
          obsPrefix: active.prefix,
        })
      }
      continue
    }

    // ---- IPv4：按 24 位对齐切桶（与桌面版一致） ----
    for (let start = range.start; start < range.end;) {
      const chunk = 256n - (start % 256n)
      const size = chunk > range.end - start ? range.end - start : chunk
      const staticWeight = weightFn(`${format(start, 4)}/32`)
      if (staticWeight === 0 && !includeZero) {
        start += size
        continue
      }
      // 观测按 /24 记，键形如「104.16.1.0/24」—— 必须带后缀才查得到。
      const obsPrefix = `${format(start & ~255n, 4)}/24`
      const observation = bucketObservation(obsPrefix, 4, store, profileIdFor(4), now, halfLife)
      const weight = neutral && staticWeight > 0 ? 1 : effectiveSegmentWeight(staticWeight, observation)
      // 容量：桶内地址数；大于 2 个地址时去掉网络号与广播号（与桌面版一致）。
      let capacity = Number(size)
      if (size > 2n) {
        if (start % 256n === 0n) capacity--
        const last = start + size - 1n
        if (last % 256n === 255n) capacity--
      }
      if (!Number.isFinite(capacity) || capacity > MAX_BUCKET_CAPACITY) capacity = MAX_BUCKET_CAPACITY
      buckets.push({
        family: 4,
        start,
        end: start + size,
        staticWeight,
        weight,
        capacity: Math.max(0, capacity),
        used: 0,
        usedOffsets: new Set<bigint>(),
        family24: start & ~255n,
        obsPrefix,
      })
      start += size
    }
  }
  if (buckets.length === 0) return []

  // ---- 抽取 ----
  /**
   * 在给定桶池里按「探索 + 利用 + 集中度上限」取 `budget` 个候选。
   *
   * 逻辑与桌面版 `internal/scan/adaptive_sampling.go` 一一对应，
   * 只是把「池」与「预算」参数化，以便按地址族分别执行。
   */
  function extract(pool: Bucket[], budget: number): SamplingCandidate[] {
    const explorationRate = Math.min(1, Math.max(0, options?.explorationRate ?? 0.2))
    const exploreBudgetCount = exploreBudget(budget, explorationRate)
    let capPerPrefix = prefixCap(budget)
    const byPrefix = new Map<string, number>()
    const out: SamplingCandidate[] = []

    const capacityOf = (bucket: Bucket): number => bucket.capacity - bucket.used

    while (out.length < budget) {
      const isExplore = out.length < exploreBudgetCount
      const weights: number[] = []
      let totalWeight = 0
      for (const bucket of pool) {
        const prefixKey = `${bucket.family}:${bucket.family24}`
        const used = byPrefix.get(prefixKey) ?? 0
        if (capacityOf(bucket) <= 0 || used >= capPerPrefix) {
          weights.push(0)
          continue
        }
        const weight = isExplore ? 1 : bucket.weight
        const value = capacityOf(bucket) * weight
        weights.push(value)
        totalWeight += value
      }
      if (totalWeight <= 0) {
        // 利用池被集中度上限卡住：只要还有可用地址，就放宽上限继续取。
        //
        // ⚠️ 上限是**软上限**：网段池小的时候（用户只给了两个 /24），
        // 5% 的份额根本不够用，直接停手会取不满用户要的候选数。
        // 桌面版 internal/scan/adaptive_sampling.go 是同样的处理。
        const available = pool.some((bucket) => capacityOf(bucket) > 0 && (isExplore || bucket.weight > 0))
        if (!available) break
        capPerPrefix++
        continue
      }
      let draw = random() * totalWeight
      let chosen = -1
      for (let index = 0; index < weights.length; index++) {
        const weight = weights[index]!
        if (weight <= 0) continue
        chosen = index
        draw -= weight
        if (draw < 0) break
      }
      if (chosen < 0) break
      const bucket = pool[chosen]!
      let address: bigint | undefined
      const bucketSize = bucket.end - bucket.start
      if (bucketSize <= ENUMERABLE_BUCKET_SIZE) {
        // 小桶（IPv4 的 /24 及更细）：枚举全部可用地址后打乱，依次取用。
        if (!bucket.order) {
          const order: bigint[] = []
          for (let offset = 0n; offset < bucketSize; offset++) {
            const candidate = bucket.start + offset
            if (bucketSize > 2n && (candidate % 256n === 0n || candidate % 256n === 255n)) continue
            order.push(candidate)
          }
          for (let index = order.length - 1; index > 0; index--) {
            const other = Math.floor(random() * (index + 1))
            const swap = order[index]!
            order[index] = order[other]!
            order[other] = swap
          }
          bucket.order = order
        }
        address = bucket.order[bucket.used]
      } else {
        // 大桶（IPv6 段动辄 2^80 个地址）：**只能随机取**，
        // 枚举会把内存吃光（实测直接把进程撑到 OOM）。
        const span = Number(bucketSize > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : bucketSize)
        for (let attempt = 0; attempt < 64 && address === undefined; attempt++) {
          const offset = BigInt(Math.floor(random() * span))
          if (bucket.usedOffsets.has(offset)) continue
          bucket.usedOffsets.add(offset)
          address = bucket.start + offset
        }
      }
      if (address === undefined) break
      bucket.used++
      const prefixKey = `${bucket.family}:${bucket.family24}`
      byPrefix.set(prefixKey, (byPrefix.get(prefixKey) ?? 0) + 1)
      out.push({ ip: format(address, bucket.family), staticWeight: bucket.staticWeight })
    }
    return out
  }

  // ⚠️ 两族必须**分别给预算**，不能共用一个加权池。
  //
  // v6 桶的容量是 2^80（钳到 1e9），v4 的 /24 桶只有 254 ——
  // 抽取权重是「剩余容量 × 权重」，共池时 v6 会吃掉几乎全部候选。
  // 分族预算的口径与 `expandCidrs` 一致：两族都有时各拿 `round(count / 2)`。
  const v4Pool = buckets.filter((bucket) => bucket.family === 4)
  const v6Pool = buckets.filter((bucket) => bucket.family === 6)
  if (v4Pool.length === 0) return extract(v6Pool, count)
  if (v6Pool.length === 0) return extract(v4Pool, count)
  const half = Math.max(1, Math.round(count / 2))
  return [...extract(v4Pool, half), ...extract(v6Pool, Math.max(1, Math.round(count / 2)))]
}

/**
 * 某个前缀的**学习后权重**（供测试与跨语言一致性校验使用）。
 *
 * 与桌面版 internal/scan/adaptive_sampling.go 的 LearnedPrefixWeight 一一对应：
 *   阶段优先 ws > tls > tcp（同阶段取较新）→ 取该前缀自己的观测 →
 *   Beta 平滑 → 钳位到 [MIN_WEIGHT, 1]。
 */
export function learnedPrefixWeight(
  prefix: string,
  store: ProfileStoreDocument | undefined,
  profileId: string,
  now: number,
  halfLifeMs: number = 7 * 24 * 60 * 60 * 1000,
): number {
  const staticWeight = cidrWeight(prefix)
  const observation = bucketObservation(prefix, 4, store, profileId, now, halfLifeMs)
  return effectiveSegmentWeight(staticWeight, observation)
}

/**
 * 取某个前缀桶的观测。
 *
 * 口径与桌面版一致：
 *   - 阶段优先 ws > tls > tcp（同阶段取较新的一条）；
 *   - 只统计**该 /24 自己的**观测，不跨 /24 求和；
 *   - 观测按半衰期衰减（默认 7 天）。
 */
function bucketObservation(
  prefix: string,
  family: 4 | 6,
  store: ProfileStoreDocument | undefined,
  profileId: string,
  now: number,
  halfLifeMs: number,
): SegmentObservation | undefined {
  if (!store || !profileId) return undefined
  const rank = (stage: string): number => (stage === 'ws' ? 3 : stage === 'tls' ? 2 : stage === 'tcp' ? 1 : 0)
  let best: { attempts: number; successes: number; updatedAt: number; rank: number } | undefined
  for (const observation of Object.values(store.observations)) {
    if (observation.profileId !== profileId) continue
    if (family === 4) {
      if (observation.prefix !== prefix) continue
    } else if (!observation.prefix.startsWith(prefix)) {
      continue
    }    const current = rank(observation.stage)
    if (!best || current > best.rank || (current === best.rank && observation.updatedAt > best.updatedAt)) {
      best = {
        attempts: observation.attempts,
        successes: observation.successes,
        updatedAt: observation.updatedAt,
        rank: current,
      }
    }
  }
  if (!best || best.attempts <= 0) return undefined
  const age = Math.max(0, now - best.updatedAt)
  return { attempts: best.attempts, successes: best.successes, decay: 2 ** (-age / Math.max(1, halfLifeMs)) }
}
