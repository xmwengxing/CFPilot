package scan

import (
	"crypto/rand"
	"encoding/binary"
	"math"
	mathrand "math/rand"
	"net"
	"sort"
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

type adaptiveBucket struct {
	base   uint32
	size   uint64
	weight float64
	used   int
	order  []uint32
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

// SampleAdaptiveCandidates 将预算拆为探索与利用，并在 /24 粒度限制集中度。
// 探索可重新验证静态零权重网段；利用使用当前网络档案，绝不混用其它网络的历史。
func SampleAdaptiveCandidates(opt SampleOptions) []string {
	if opt.Count <= 0 {
		opt.Count = 500
	}
	options := AdaptiveSamplingOptions{}
	if opt.Adaptive != nil {
		options = *opt.Adaptive
	}
	options = options.withDefaults()
	pool := opt.CIDRs
	if len(pool) == 0 {
		pool = BuiltinIPv4CIDRs
	}
	observed := make(map[string]PrefixObservation)
	for _, v := range opt.Observations {
		if opt.ProfileID == "" || v.ProfileID != opt.ProfileID {
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
	// 按桶内真实地址范围拆分，/25-/32 不能被扩大为整个 /24。
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
			static := CIDRWeight(key)
			weight := static
			if opt.Neutral {
				weight = 1
			} else if v, ok := observed[key]; ok {
				weight = DynamicPrefixWeight(static, &v, options)
			} else {
				weight = DynamicPrefixWeight(static, nil, options)
			}
			buckets = append(buckets, adaptiveBucket{base: uint32(start), size: chunk, weight: weight})
			offset += chunk
		}
	}
	if len(buckets) == 0 {
		return []string{}
	}
	sort.Slice(buckets, func(i, j int) bool { return buckets[i].base < buckets[j].base })
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
	// 只在桶被选中时创建至多 256 个地址，避免为大网段展开完整地址池。
	byPrefix := make(map[uint32]int)
	total := 0
	capacity := func(b adaptiveBucket) int {
		n := int(b.size)
		if b.size > 2 {
			if b.base&255 == 0 {
				n--
			}
			if (b.base+uint32(b.size)-1)&255 == 255 {
				n--
			}
		}
		return n
	}
	for _, b := range buckets {
		total += capacity(b)
	}
	count := opt.Count
	if count > total {
		count = total
	}
	capPerPrefix := PrefixCap(count, options.MaxPrefixShare)
	explore := ExploreBudget(count, options.ExplorationRatio)
	out := make([]string, 0, count)
	weights := make([]float64, len(buckets))
	for len(out) < count {
		isExplore := len(out) < explore || opt.Neutral
		clear(weights)
		totalWeight := 0.0
		for i := range buckets {
			b := &buckets[i]
			if b.used >= capacity(*b) || byPrefix[b.base&0xffffff00] >= capPerPrefix {
				continue
			}
			w := b.weight
			if isExplore {
				w = 1
			}
			weights[i] = float64(capacity(*b)-b.used) * w
			totalWeight += weights[i]
		}
		if totalWeight == 0 {
			// 仅集中度不足时放宽上限；利用池耗尽后不能把零权重桶当成补位。
			available := false
			for i := range buckets {
				b := &buckets[i]
				if b.used < capacity(*b) && (isExplore || b.weight > 0) {
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
		b := &buckets[chosen]
		if b.order == nil {
			for j := uint64(0); j < b.size; j++ {
				addr := b.base + uint32(j)
				if b.size > 2 && (addr&255 == 0 || addr&255 == 255) {
					continue
				}
				b.order = append(b.order, addr)
			}
			rng.Shuffle(len(b.order), func(j, k int) { b.order[j], b.order[k] = b.order[k], b.order[j] })
		}
		addr := b.order[b.used]
		b.used++
		byPrefix[addr&0xffffff00]++
		ip := make(net.IP, 4)
		binary.BigEndian.PutUint32(ip, addr)
		out = append(out, ip.String())
	}
	return out
}
