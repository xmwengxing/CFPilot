package scan

import (
	"crypto/rand"
	"encoding/binary"
	"math"
	"math/big"
	mathrand "math/rand"
	"net"
	"sort"
	"strconv"
	"time"
)

// AdaptiveSamplingOptions 与 CLI 探索/利用采样语义对齐。
// 零值使用默认值；ExplorationRatio=1 可仅探索，Neutral 则绕过学习权重。
type AdaptiveSamplingOptions struct {
	ExplorationRatio float64
	MinWeight        float64
	MaxPrefixShare   float64
	PriorAlpha       float64
	PriorBeta        float64
	HalfLife         time.Duration
	Now              time.Time
}

func (o AdaptiveSamplingOptions) withDefaults() AdaptiveSamplingOptions {
	finitePositive := func(v, fallback float64) float64 {
		if math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 {
			return fallback
		}
		return v
	}
	o.ExplorationRatio = math.Min(1, finitePositive(o.ExplorationRatio, 0.2))
	o.MinWeight = math.Min(1, finitePositive(o.MinWeight, 0.02))
	o.MaxPrefixShare = math.Min(1, finitePositive(o.MaxPrefixShare, 0.05))
	// 先验参数对照 CLI 的 LEARN_PRIOR_ALPHA / LEARN_PRIOR_BETA：
	// 「全局先验成功率 70%，折算成 8 个虚拟样本」，平滑公式 P = (S + 5.6) / (N + 8)。
	o.PriorAlpha = finitePositive(o.PriorAlpha, 5.6)
	o.PriorBeta = finitePositive(o.PriorBeta, 2.4)
	if o.HalfLife <= 0 {
		o.HalfLife = 7 * 24 * time.Hour
	}
	if o.Now.IsZero() {
		o.Now = time.Now()
	}
	return o
}

// LearnedPrefixWeight 返回某个前缀在当前档案下的学习后权重。
//
// 与 CLI 的 learnedPrefixWeight（packages/cli/src/scan/candidates_adaptive.ts）一一对应：
// 阶段优先 ws > tls > tcp（同阶段取较新）→ 只取该前缀自己的观测 →
// Beta 平滑 → 钳位到 [MinWeight, 1]。
//
// 两端必须一致：同一份档案在两端算出不同权重，历史就失去意义。
func LearnedPrefixWeight(prefix string, observations []PrefixObservation, profileID string, options AdaptiveSamplingOptions) float64 {
	o := options.withDefaults()
	static := CIDRWeight(prefix)
	var best *PrefixObservation
	rank := func(stage string) int {
		switch stage {
		case "ws":
			return 3
		case "tls":
			return 2
		case "tcp":
			return 1
		}
		return 0
	}
	for i := range observations {
		v := observations[i]
		if v.ProfileID != profileID || v.Prefix != prefix || v.Stage == "speed" {
			continue
		}
		if !validObservation(v) || v.UpdatedAt.After(o.Now) || v.Attempts <= 0 {
			continue
		}
		if best == nil || rank(v.Stage) > rank(best.Stage) || (rank(v.Stage) == rank(best.Stage) && v.UpdatedAt.After(best.UpdatedAt)) {
			copied := v
			best = &copied
		}
	}
	return DynamicPrefixWeight(static, best, o)
}

// DynamicPrefixWeight 用 Beta 先验平滑已完成阶段的成功率。
// 观察值每七天半衰减，避免一次短暂路由故障永久封杀网段；无数据时保留静态先验。
func DynamicPrefixWeight(static float64, observation *PrefixObservation, options AdaptiveSamplingOptions) float64 {
	o := options.withDefaults()
	if math.IsNaN(static) || math.IsInf(static, 0) {
		static = DefaultCIDRWeight
	}
	// 静态零权重只参与探索，历史成功不能把它提升为利用候选。
	if static <= 0 {
		return 0
	}
	static = math.Max(o.MinWeight, math.Min(1, static))
	if observation == nil {
		return static
	}
	v := observation
	if v.Stage != "" {
		if !validObservation(*v) || v.Attempts <= 0 || v.UpdatedAt.After(o.Now) {
			return static
		}
		decay := math.Exp2(-o.Now.Sub(v.UpdatedAt).Seconds() / o.HalfLife.Seconds())
		prior := o.PriorAlpha + o.PriorBeta
		return math.Max(o.MinWeight, math.Min(1, (static*prior+v.Successes*decay)/(prior+v.Attempts*decay)))
	}
	attempts, successes := v.TCPAttempts, v.TCPSuccess
	if v.TLSAttempts > 0 {
		attempts, successes = v.TLSAttempts, v.TLSSuccess
	}
	if v.WSAttempts > 0 {
		attempts, successes = v.WSAttempts, v.WSSuccess
	}
	if attempts <= 0 {
		attempts = v.SampleCount
		successes = v.WSSuccess
	}
	if attempts <= 0 || v.LastTestAt.IsZero() {
		return static
	}
	if successes < 0 {
		successes = 0
	}
	if successes > attempts {
		successes = attempts
	}
	age := o.Now.Sub(v.LastTestAt).Seconds() / o.HalfLife.Seconds()
	if age < 0 {
		age = 0
	}
	decay := math.Exp2(-age)
	prior := o.PriorAlpha + o.PriorBeta
	weight := (static*prior + float64(successes)*decay) / (prior + float64(attempts)*decay)
	return math.Max(o.MinWeight, math.Min(1, weight))
}

// maxBucketCapacity 是单个桶的容量上限（与 CLI 的 MAX_BUCKET_CAPACITY 一致）。
//
// IPv6 的 /48 有 2^80 个地址，Number/big 都装不下实际值，
// 而容量只用来分配预算与集中度，钳到一个够大的有限值即可。
const maxBucketCapacity = 1e9

// adaptiveBucket 是采样桶。两族共用一个结构，用 family 区分地址表示：
//
//   - family 4：baseV4/sizeV4 + order（小桶可枚举后打乱）
//   - family 6：baseV6/spanV6 + usedV6（大桶只能随机取，枚举会 OOM）
//
// prefix 是观测前缀，**必须与 CLI 的 networkBucket() 逐字节一致**
// （v4: `x.x.x.0/24`，v6: `x:x:x::/48`），否则写进档案的历史永远查不到。
type adaptiveBucket struct {
	family  int
	baseV4  uint32
	baseV6  *big.Int
	sizeV4  uint64
	spanV6  *big.Int
	weight  float64
	used    int
	order   []uint32
	usedV6  map[string]bool
	prefix  string
	concKey string
}

// ExploreBudget 返回一轮采样中留给「均匀探索」的配额。
//
// 对照 CLI 的 exploreBudget —— 两端必须一致，
// 否则同一个探索比例在两端会变成不同的配额。
func ExploreBudget(count int, explorationRatio float64) int {
	if count <= 0 {
		return 0
	}
	ratio := math.Min(1, math.Max(0, explorationRatio))
	return int(math.Ceil(float64(count) * ratio))
}

// PrefixCap 返回同一个 /24 家族最多可取的候选数。
//
// 对照 CLI 的 prefixCap。
func PrefixCap(count int, share float64) int {
	if count <= 0 {
		return 1
	}
	ratio := math.Min(1, math.Max(0, share))
	cap := int(math.Ceil(float64(count) * ratio))
	if cap < 1 {
		return 1
	}
	return cap
}

// SampleAdaptiveCandidates 将预算拆为探索与利用，并在 /24（v4）/ 48 位前缀（v6）
// 粒度限制集中度。探索可重新验证静态零权重网段；利用使用当前网络档案，
// 绝不混用其它网络的历史。
//
// ## 分族（对照 CLI 的 adaptivePool）
//
// 两族**各自建桶、各自给预算**：v6 桶容量是 maxBucketCapacity（1e9），
// v4 的 /24 桶只有 254，共用一个加权池会让容量大的一方吃掉几乎全部候选。
// 预算口径与 CLI 一致：两族都有时各拿 round(count/2)。
func SampleAdaptiveCandidates(opt SampleOptions) []string {
	if opt.Count <= 0 {
		opt.Count = 500
	}
	options := AdaptiveSamplingOptions{}
	if opt.Adaptive != nil {
		options = *opt.Adaptive
	}
	options = options.withDefaults()

	includeV6 := familyIncludesV6(opt.Family)
	// 默认池按族裁剪：只给 v6 时不能把 IPv4 官方段塞进来（与 SampleCandidates 一致）
	includeV4 := opt.Family != "v6"
	pool := opt.CIDRs
	if len(pool) == 0 {
		switch {
		case includeV6 && includeV4:
			pool = append(append([]string{}, BuiltinIPv4CIDRs...), IPv6ActivePrefixes()...)
		case includeV6:
			pool = IPv6ActivePrefixes()
		default:
			pool = BuiltinIPv4CIDRs
		}
	}
	observed := buildObservedPrefixes(opt, options)

	// ---- 按族拆池（v6 还要收窄到活跃 48 位前缀）----
	rawV4 := make([]string, 0, len(pool))
	rawV6 := make([]string, 0, len(pool))
	for _, c := range pool {
		if isIPv6CIDR(c) {
			if includeV6 {
				rawV6 = append(rawV6, c)
			}
		} else if includeV4 {
			rawV4 = append(rawV4, c)
		}
	}
	if includeV6 {
		rawV6 = resolveIPv6Pool(rawV6, opt.ExtraIPv6CIDRs)
	}

	buckets := buildV4Buckets(rawV4, observed, options, opt.Neutral)
	buckets = append(buckets, buildV6Buckets(rawV6, opt.ExtraIPv6CIDRs, observed, options, opt.Neutral)...)
	if len(buckets) == 0 {
		return []string{}
	}

	seed := opt.Seed
	if seed == 0 {
		var bytes [8]byte
		if _, err := rand.Read(bytes[:]); err == nil {
			seed = int64(binary.LittleEndian.Uint64(bytes[:]))
		} else {
			seed = time.Now().UnixNano()
		}
	}
	rng := mathrand.New(mathrand.NewSource(seed))

	v4Pool := make([]adaptiveBucket, 0, len(buckets))
	v6Pool := make([]adaptiveBucket, 0, len(buckets))
	for _, b := range buckets {
		if b.family == 4 {
			v4Pool = append(v4Pool, b)
		} else {
			v6Pool = append(v6Pool, b)
		}
	}
	switch {
	case len(v4Pool) == 0:
		return extractAdaptive(v6Pool, opt.Count, opt.Neutral, rng, options)
	case len(v6Pool) == 0:
		return extractAdaptive(v4Pool, opt.Count, opt.Neutral, rng, options)
	}
	half := (opt.Count + 1) / 2 // 与 CLI 的 Math.round(count/2) 一致
	return append(
		extractAdaptive(v4Pool, half, opt.Neutral, rng, options),
		extractAdaptive(v6Pool, half, opt.Neutral, rng, options)...,
	)
}

// buildObservedPrefixes 把档案里的观测按前缀归并（阶段优先 ws > tls > tcp）。
//
// 只收**本机这两份档案**（IPv4 / IPv6 各一份）的观测：
// 前缀本身已经带族信息（/24 vs /48），两族不会互相串。
func buildObservedPrefixes(opt SampleOptions, options AdaptiveSamplingOptions) map[string]PrefixObservation {
	observed := make(map[string]PrefixObservation)
	matchesProfile := func(id string) bool {
		if opt.ProfileID == "" || id == "" {
			return false
		}
		if id == opt.ProfileID {
			return true
		}
		return opt.ProfileIDV6 != "" && id == opt.ProfileIDV6
	}
	for _, v := range opt.Observations {
		if !matchesProfile(v.ProfileID) {
			continue
		}
		if v.Stage == "speed" || v.Stage != "" && (!validObservation(v) || v.UpdatedAt.After(options.Now)) {
			continue
		}
		previous, exists := observed[v.Prefix]
		// 后续已完成阶段优先，不能让较新的 TCP 成功掩盖 WS 失败。
		rank := func(stage string) int {
			switch stage {
			case "ws":
				return 3
			case "tls":
				return 2
			case "tcp":
				return 1
			}
			return 0
		}
		if !exists || rank(v.Stage) > rank(previous.Stage) || rank(v.Stage) == rank(previous.Stage) && (v.UpdatedAt.After(previous.UpdatedAt) || v.LastTestAt.After(previous.LastTestAt)) {
			observed[v.Prefix] = v
		}
	}
	return observed
}

// bucketWeight 静态权重 × Beta 平滑后的观测权重（neutral 时一律按 1 处理，只区分 0）。
func bucketWeight(static float64, observed map[string]PrefixObservation, key string, options AdaptiveSamplingOptions, neutral bool) float64 {
	if neutral {
		return 1
	}
	if v, ok := observed[key]; ok {
		return DynamicPrefixWeight(static, &v, options)
	}
	return DynamicPrefixWeight(static, nil, options)
}

// buildV4Buckets 按 24 位对齐切桶（/25-/32 不能被扩大成整个 /24）。
func buildV4Buckets(pool []string, observed map[string]PrefixObservation, options AdaptiveSamplingOptions, neutral bool) []adaptiveBucket {
	buckets := make([]adaptiveBucket, 0)
	type interval struct{ start, end uint64 }
	ranges := make([]interval, 0, len(pool))
	for _, cidr := range pool {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil || network.IP.To4() == nil {
			continue
		}
		prefix, _ := network.Mask.Size()
		base := uint64(binary.BigEndian.Uint32(network.IP.To4()))
		ranges = append(ranges, interval{base, base + uint64(1)<<uint(32-prefix)})
	}
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].start < ranges[j].start })
	merged := make([]interval, 0, len(ranges))
	for _, r := range ranges {
		if len(merged) > 0 && r.start <= merged[len(merged)-1].end {
			if r.end > merged[len(merged)-1].end {
				merged[len(merged)-1].end = r.end
			}
		} else {
			merged = append(merged, r)
		}
	}
	for _, r := range merged {
		base, size := r.start, r.end-r.start
		for offset := uint64(0); offset < size; {
			start := base + offset
			chunk := uint64(256) - start%256
			if chunk > size-offset {
				chunk = size - offset
			}
			ip := make(net.IP, 4)
			binary.BigEndian.PutUint32(ip, uint32(start))
			key := IPv4Prefix24(ip.String())
			buckets = append(buckets, adaptiveBucket{
				family:  4,
				baseV4:  uint32(start),
				sizeV4:  chunk,
				weight:  bucketWeight(CIDRWeight(key), observed, key, options, neutral),
				prefix:  key,
				concKey: "4:" + strconv.FormatUint(uint64(uint32(start)&0xffffff00), 16),
			})
			offset += chunk
		}
	}
	sort.Slice(buckets, func(i, j int) bool { return buckets[i].baseV4 < buckets[j].baseV4 })
	return buckets
}

// buildV6Buckets 只对**已知活跃的 48 位前缀**建桶（对照 CLI 的 adaptivePool v6 分支）。
//
// 传进来的 pool 已经由 resolveIPv6Pool 收窄过（活跃段 ∪ AAAA 发现段 ∩ 输入），
// 所以这里每个入参直接就是一个桶，不再做交集。
//
// 两个理由（2026-11-03 实测），解释「为什么只认已知活跃段」：
//  1. 在公布聚合段里随机抽 48 位前缀 0/18 全超时 —— 给未知段建桶
//     等于把探索预算全烧在死地址上，探索命中率约等于 0；
//  2. 一个 /32 按 48 位切是 65536 个桶，内存与时间都不可接受。
//
// 新的活跃段只能由「域名 AAAA」与「人工复测后的静态表」引入。
func buildV6Buckets(pool []string, extra []string, observed map[string]PrefixObservation, options AdaptiveSamplingOptions, neutral bool) []adaptiveBucket {
	// 运行期发现的段静态权重按 1 计（对照 CLI 的 makeWeightFn）
	extraSet := make(map[string]bool, len(extra))
	for _, e := range extra {
		if key := IPv6Prefix48(e); key != "" {
			extraSet[key] = true
		}
	}
	buckets := make([]adaptiveBucket, 0)
	seen := map[string]bool{}
	for _, p := range pool {
		if !isIPv6CIDR(p) {
			continue
		}
		key := IPv6Prefix48(p)
		if key == "" || seen[key] {
			continue
		}
		static := CIDRWeight(p)
		if extraSet[key] {
			static = 1
		}
		if static <= 0 {
			continue // 只给已知活跃段建桶（见上）
		}
		seen[key] = true
		cNet, cOnes, err := parseCIDRParts(normalizeCIDR(p))
		if err != nil {
			continue
		}
		buckets = append(buckets, adaptiveBucket{
			family:  6,
			baseV6:  new(big.Int).SetBytes(cNet.IP),
			spanV6:  new(big.Int).Lsh(big.NewInt(1), uint(128-cOnes)),
			weight:  bucketWeight(static, observed, key, options, neutral),
			usedV6:  map[string]bool{},
			prefix:  key,
			concKey: "6:" + key,
		})
	}
	sort.Slice(buckets, func(i, j int) bool { return buckets[i].prefix < buckets[j].prefix })
	return buckets
}

// bucketCapacity 返回桶的可用容量（只用于分配预算与集中度）。
func bucketCapacity(b *adaptiveBucket) int {
	if b.family == 6 {
		// /48 有 2^80 个地址，钳到与 CLI 一致的上限即可
		return int(maxBucketCapacity)
	}
	n := int(b.sizeV4)
	if b.sizeV4 > 2 {
		if b.baseV4&255 == 0 {
			n--
		}
		if (b.baseV4+uint32(b.sizeV4)-1)&255 == 255 {
			n--
		}
	}
	return n
}

// nextAddress 取桶内下一个地址；返回 nil 表示该桶已取尽 / 采样失败。
func (b *adaptiveBucket) nextAddress(rng *mathrand.Rand) net.IP {
	if b.family == 6 {
		if b.spanV6 == nil || b.spanV6.Sign() <= 0 {
			return nil
		}
		// 大桶只能随机取：枚举 2^80 个地址会直接把内存吃光。
		//
		// ⚠️ 必须用**传进来的 seeded rng**，不能用 crypto/rand ——
		// 否则同一个种子两次跑出不同的 v6 候选，`--seed` 的可复现性就没了
		// （AGENTS：采样种子不得写死，但给了种子就必须可复现）。
		//
		// 单次 Int63 只有 63 位，而 /48 有 80 位：直接取模会让样本
		// 全部挤在网络地址附近，所以按 30 位分段拼够位数再取模。
		bitsNeeded := b.spanV6.BitLen()
		offset := new(big.Int)
		for produced := 0; produced < bitsNeeded; produced += 30 {
			offset.Lsh(offset, 30)
			offset.Or(offset, big.NewInt(int64(rng.Intn(1<<30))))
		}
		offset.Mod(offset, b.spanV6)
		for attempt := 0; attempt < 64; attempt++ {
			addr := new(big.Int).Add(b.baseV6, offset)
			buf := make([]byte, net.IPv6len)
			addr.FillBytes(buf)
			key := net.IP(buf).String()
			if b.usedV6[key] {
				// 撞了就换个随机偏移继续（最多 64 次，之后判为取尽）
				offset = new(big.Int)
				for produced := 0; produced < bitsNeeded; produced += 30 {
					offset.Lsh(offset, 30)
					offset.Or(offset, big.NewInt(int64(rng.Intn(1<<30))))
				}
				offset.Mod(offset, b.spanV6)
				continue
			}
			b.usedV6[key] = true
			return net.IP(buf)
		}
		return nil
	}
	// 小桶：先枚举全部可用地址再打乱，然后依次取用
	if b.order == nil {
		for j := uint64(0); j < b.sizeV4; j++ {
			addr := b.baseV4 + uint32(j)
			if b.sizeV4 > 2 && (addr&255 == 0 || addr&255 == 255) {
				continue
			}
			b.order = append(b.order, addr)
		}
		rng.Shuffle(len(b.order), func(j, k int) { b.order[j], b.order[k] = b.order[k], b.order[j] })
	}
	if b.used >= len(b.order) {
		return nil
	}
	ip := make(net.IP, 4)
	binary.BigEndian.PutUint32(ip, b.order[b.used])
	return ip
}

// extractAdaptive 在给定桶池里按「探索 + 利用 + 集中度上限」取 budget 个候选。
//
// 逻辑与 CLI 的 adaptivePool().extract 一一对应。
func extractAdaptive(buckets []adaptiveBucket, budget int, neutral bool, rng *mathrand.Rand, options AdaptiveSamplingOptions) []string {
	if budget <= 0 || len(buckets) == 0 {
		return []string{}
	}
	total := 0
	for i := range buckets {
		total += bucketCapacity(&buckets[i])
	}
	count := budget
	if count > total {
		count = total
	}
	capPerPrefix := PrefixCap(count, options.MaxPrefixShare)
	explore := ExploreBudget(count, options.ExplorationRatio)
	byPrefix := make(map[string]int)
	out := make([]string, 0, count)
	weights := make([]float64, len(buckets))

	for len(out) < count {
		isExplore := len(out) < explore || neutral
		clear(weights)
		totalWeight := 0.0
		for i := range buckets {
			b := &buckets[i]
			cap := bucketCapacity(b)
			if b.used >= cap || byPrefix[b.concKey] >= capPerPrefix {
				continue
			}
			w := b.weight
			if isExplore {
				w = 1
			}
			weights[i] = float64(cap-b.used) * w
			totalWeight += weights[i]
		}
		if totalWeight == 0 {
			// 仅集中度不足时放宽上限；利用池耗尽后不能把零权重桶当成补位。
			available := false
			for i := range buckets {
				b := &buckets[i]
				if b.used < bucketCapacity(b) && (isExplore || b.weight > 0) {
					available = true
					break
				}
			}
			if !available {
				break
			}
			capPerPrefix++
			continue
		}
		draw := rng.Float64() * totalWeight
		chosen := -1
		for i, w := range weights {
			if w <= 0 {
				continue
			}
			chosen = i
			draw -= w
			if draw < 0 {
				break
			}
		}
		if chosen < 0 {
			break
		}
		b := &buckets[chosen]
		ip := b.nextAddress(rng)
		if ip == nil {
			break
		}
		b.used++
		byPrefix[b.concKey]++
		out = append(out, ip.String())
	}
	return out
}
