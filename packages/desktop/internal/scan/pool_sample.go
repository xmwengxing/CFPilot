package scan

// Phase 4 · 从本地池分层取样 + 完整优选结果回写。
//
// 与 packages/cli/src/sources/sample.ts 同语义：
// 地址族配额 → /24 或 /48 轮转 → 桶内按历史成功次数 / 最近发现排序。
// 不做随机，保证同一份池在两端取样结果一致，便于回归测试。

import (
	"fmt"
	"net"
	"sort"
	"strings"
)

const PoolSampleLimit = 200

type PoolSample struct {
	Candidates    []string
	Keys          []string
	V4            int
	V6            int
	TotalEligible int
	Note          string
}

// NetworkBucket 返回 IPv4 的 /24 或 IPv6 的 /48 归一化键。
func NetworkBucket(ip string) string {
	if strings.Contains(ip, ":") {
		parsed := net.ParseIP(strings.Trim(ip, "[]"))
		if parsed == nil {
			return ip
		}
		v6 := parsed.To16()
		if v6 == nil || parsed.To4() != nil {
			return ip
		}
		return fmt.Sprintf("%x:%x:%x", uint16(v6[0])<<8|uint16(v6[1]),
			uint16(v6[2])<<8|uint16(v6[3]), uint16(v6[4])<<8|uint16(v6[5]))
	}
	parts := strings.Split(ip, ".")
	if len(parts) == 4 {
		return strings.Join(parts[:3], ".")
	}
	return ip
}

func eligibleCandidates(pool *ExternalPool, port int) []*ExternalCandidate {
	out := make([]*ExternalCandidate, 0, len(pool.Candidates))
	for i := range pool.Candidates {
		c := &pool.Candidates[i]
		if c.Port != port || c.Status == StatusDisabled || c.Status == StatusExpired {
			continue
		}
		if c.LightCheck != nil && (!c.LightCheck.TCPOk || !c.LightCheck.TLSOk) {
			continue
		}
		out = append(out, c)
	}
	return out
}

// roundRobinPick 桶间轮转取样，保证网段分散度。
func roundRobinPick(items []*ExternalCandidate, quota int) []*ExternalCandidate {
	buckets := map[string][]*ExternalCandidate{}
	for _, c := range items {
		k := NetworkBucket(c.IP)
		buckets[k] = append(buckets[k], c)
	}
	keys := make([]string, 0, len(buckets))
	for k := range buckets {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		list := buckets[k]
		sort.SliceStable(list, func(i, j int) bool {
			if list[i].SuccessCount != list[j].SuccessCount {
				return list[i].SuccessCount > list[j].SuccessCount
			}
			if list[i].LastSeen != list[j].LastSeen {
				return list[i].LastSeen > list[j].LastSeen
			}
			return list[i].Key < list[j].Key
		})
	}
	out := make([]*ExternalCandidate, 0, quota)
	for round := 0; len(out) < quota; round++ {
		progressed := false
		for _, k := range keys {
			if len(out) >= quota {
				break
			}
			if round < len(buckets[k]) {
				out = append(out, buckets[k][round])
				progressed = true
			}
		}
		if !progressed {
			break
		}
	}
	return out
}

// SampleFromPool 只取端口匹配的候选（扫描器的候选是纯 IP，端口由 Options.Port 统一决定）。
func SampleFromPool(pool *ExternalPool, limit, port int) PoolSample {
	if limit <= 0 {
		limit = PoolSampleLimit
	}
	if port <= 0 {
		port = 443
	}
	all := eligibleCandidates(pool, port)
	var v4, v6 []*ExternalCandidate
	for _, c := range all {
		if c.IPVersion == 6 {
			v6 = append(v6, c)
		} else {
			v4 = append(v4, c)
		}
	}
	v4Quota := (limit + 1) / 2
	v6Quota := limit - v4Quota
	if len(v4) < v4Quota {
		v6Quota += v4Quota - len(v4)
		v4Quota = len(v4)
	}
	if len(v6) < v6Quota {
		v4Quota += v6Quota - len(v6)
		v6Quota = len(v6)
	}
	picked := append(roundRobinPick(v4, v4Quota), roundRobinPick(v6, v6Quota)...)
	if len(picked) > limit {
		picked = picked[:limit]
	}
	sample := PoolSample{
		Candidates:    make([]string, 0, len(picked)),
		Keys:          make([]string, 0, len(picked)),
		TotalEligible: len(all),
	}
	for _, c := range picked {
		sample.Candidates = append(sample.Candidates, c.IP)
		sample.Keys = append(sample.Keys, c.Key)
		if c.IPVersion == 6 {
			sample.V6++
		} else {
			sample.V4++
		}
	}
	sample.Note = fmt.Sprintf("本地池分层取样：端口 %d，可取样 %d 条（v4 %d / v6 %d），本次取 %d 条",
		port, len(all), len(v4), len(v6), len(picked))
	return sample
}

// ApplyFullTestResults 把完整优选结论回写本地池（只在 FromPool 模式调用）。
//
// 进 top N → active + fullTest + successCount++；其余被取样的 → failed + failCount++。
// 不碰 KV：回填仍由 scan_quick.go 的 PostResults 完成（默认 replace，即 E3）。
func ApplyFullTestResults(keys []string, port int, summary *Summary, now int64) (active int, failed int, err error) {
	if now == 0 {
		now = nowMS()
	}
	winners := map[string]Entry{}
	if summary != nil {
		for _, e := range summary.Entries {
			p := e.Port
			if p <= 0 {
				p = port
			}
			key, ok := NormalizeCandidateKey(e.IP, p)
			if ok {
				winners[key] = e
			}
		}
	}
	err = WithPool(func(pool *ExternalPool) error {
		for _, key := range keys {
			var target *ExternalCandidate
			for i := range pool.Candidates {
				if pool.Candidates[i].Key == key {
					target = &pool.Candidates[i]
					break
				}
			}
			if target == nil || target.Status == StatusDisabled {
				continue
			}
			if e, ok := winners[key]; ok {
				speed := e.PeakSpeed
				if speed <= 0 {
					speed = e.Speed
				}
				wsOK := true
				speedPtr := speed
				colo := e.Colo
				target.Status = StatusActive
				target.FullTest = &FullTest{At: &now, WSOk: &wsOK, SpeedMBps: &speedPtr, Colo: &colo}
				target.SuccessCount++
				active++
			} else {
				wsOK := false
				target.Status = StatusFailed
				target.FullTest = &FullTest{At: &now, WSOk: &wsOK, SpeedMBps: nil, Colo: nil}
				target.FailCount++
				failed++
			}
		}
		pool.UpdatedAt = now
		return nil
	})
	return active, failed, err
}
