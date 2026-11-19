package scan

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 组网入口优选（盲中继专用探测）。
//
// 与「入口优选」的区别：
//   - 目标不是数据面域名，而是**盲中继域名**（TLS SNI / Host）；
//   - 路径不是数据面 wsPath，而是 Worker 的房间路径 /mesh/<room>?peer_id=<16hex>；
//   - 判据不是吞吐，而是「能否 101 升级」+ **握手 RTT**（组网是长连接信令，
//     延迟与稳定性比带宽重要）；
//   - 探测会用**一次性随机 peer_id**：拿真实 peer_id 去探会把正在运行的自连
//     从 Durable Object 房间里踢掉（Worker 对同 peer 踢旧连接）。
//
// 探测原语复用 ProbeWS101 —— 它本来就接受 host 与 path 参数，
// 所以这条链路不需要改动既有优选引擎。

// MeshEntryOptions 是一次组网入口探测的参数。
type MeshEntryOptions struct {
	// Candidates 是候选入口，支持 "IP"、"IP:port"、"[v6]:port"、"域名"。
	Candidates []string
	// RelayDomain 是盲中继域名（TLS SNI / HTTP Host）。
	RelayDomain string
	// Room 是盲中继房间名（8-64 位十六进制）。
	Room string
	// DefaultPort 是候选未写端口时的端口，默认 443。
	DefaultPort int
	// TimeoutMs 是单次探测超时，默认 6000。
	TimeoutMs int
	// MaxCandidates 限制参与探测的候选数，默认 20（每个候选都会真的进一次房间）。
	MaxCandidates int
	// Attempts 是每个候选的尝试次数，默认 1；>1 用于看稳定性。
	Attempts int
	// Concurrency 是并发探测数，默认 4（别把房间和 Worker 打爆）。
	Concurrency int
}

// MeshEntryResult 是单个候选的探测结果。
type MeshEntryResult struct {
	IP        string `json:"ip"`
	Port      int    `json:"port"`
	OK        bool   `json:"ok"`
	LatencyMs int64  `json:"latencyMs"`
	Colo      string `json:"colo,omitempty"`
	Status    int    `json:"status,omitempty"`
	Attempts  int    `json:"attempts"`
	Successes int    `json:"successes"`
	Error     string `json:"error,omitempty"`
}

// MeshEntrySummary 是一轮探测的结果集（按「可用优先、RTT 升序」排序）。
type MeshEntrySummary struct {
	Results   []MeshEntryResult `json:"results"`
	RelayHost string            `json:"relayHost"`
	Room      string            `json:"room"`
	StartedAt int64             `json:"startedAt"`
	ElapsedMs int64             `json:"elapsedMs"`
}

func (o *MeshEntryOptions) defaults() {
	if o.DefaultPort <= 0 {
		o.DefaultPort = 443
	}
	if o.TimeoutMs <= 0 {
		o.TimeoutMs = 6000
	}
	if o.MaxCandidates <= 0 {
		o.MaxCandidates = 20
	}
	if o.Attempts <= 0 {
		o.Attempts = 1
	}
	if o.Attempts > 5 {
		o.Attempts = 5
	}
	if o.Concurrency <= 0 {
		o.Concurrency = 4
	}
	if o.Concurrency > 8 {
		o.Concurrency = 8
	}
}

// meshProbePath 构造盲中继房间的 WebSocket 路径。
// 与 mesh.RelayRoomURL 同形：/mesh/<room>?peer_id=<16hex>。
func meshProbePath(room, peerID string) string {
	return "/mesh/" + strings.ToLower(strings.TrimSpace(room)) + "?peer_id=" + peerID
}

// randomPeerID 生成一次性 peer_id（16 位小写 hex），避免与真实节点冲突。
func randomPeerID() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// normalizeMeshCandidate 把候选拆成 host / port。
func normalizeMeshCandidate(raw string, defaultPort int) (host string, port int, ok bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", 0, false
	}
	if h, p, err := net.SplitHostPort(raw); err == nil && h != "" && p != "" {
		n, cerr := strconv.Atoi(p)
		if cerr != nil || n <= 0 || n > 65535 {
			return "", 0, false
		}
		return h, n, true
	}
	// 裸 host（含 IPv6 字面量，SplitHostPort 会失败）
	return raw, defaultPort, true
}

// RunMeshEntry 用盲中继域名对候选入口做真实 WSS 探测。
//
// 每个候选都会真的向 Worker 发起一次 WebSocket 升级（含 TLS 握手），
// 因此候选数受 MaxCandidates 限制，且用一次性 peer_id。
func RunMeshEntry(ctx context.Context, raw MeshEntryOptions) (*MeshEntrySummary, error) {
	opt := raw
	opt.defaults()

	host := strings.TrimSpace(opt.RelayDomain)
	if host == "" {
		return nil, fmt.Errorf("缺少盲中继域名")
	}
	room := strings.ToLower(strings.TrimSpace(opt.Room))
	if len(room) < 8 || len(room) > 64 || !isLowerHexString(room) {
		return nil, fmt.Errorf("房间名需为 8-64 位十六进制")
	}

	// 去重 + 截断
	seen := make(map[string]bool, len(opt.Candidates))
	type cand struct {
		host string
		port int
		key  string
	}
	list := make([]cand, 0, len(opt.Candidates))
	for _, raw := range opt.Candidates {
		h, p, ok := normalizeMeshCandidate(raw, opt.DefaultPort)
		if !ok {
			continue
		}
		key := net.JoinHostPort(h, strconv.Itoa(p))
		if seen[key] {
			continue
		}
		seen[key] = true
		list = append(list, cand{host: h, port: p, key: key})
		if len(list) >= opt.MaxCandidates {
			break
		}
	}
	if len(list) == 0 {
		return nil, fmt.Errorf("没有可探测的候选入口")
	}

	sum := &MeshEntrySummary{
		RelayHost: host,
		Room:      room,
		StartedAt: time.Now().UnixMilli(),
		Results:   make([]MeshEntryResult, len(list)),
	}
	started := time.Now()

	timeout := time.Duration(opt.TimeoutMs) * time.Millisecond
	sem := make(chan struct{}, opt.Concurrency)
	var wg sync.WaitGroup

	for i := range list {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c := list[i]
			res := MeshEntryResult{IP: c.host, Port: c.port}
			var best int64 = -1
			for attempt := 0; attempt < opt.Attempts; attempt++ {
				if ctx.Err() != nil {
					break
				}
				peerID, err := randomPeerID()
				if err != nil {
					res.Error = "生成探测标识失败"
					break
				}
				path := meshProbePath(room, peerID)
				select {
				case sem <- struct{}{}:
				case <-ctx.Done():
					break
				}
				r := ProbeWS101(ctx, c.host, c.port, host, timeout, path)
				<-sem
				res.Attempts++
				if r.OK {
					res.Successes++
					if res.Colo == "" {
						res.Colo = firstNonEmpty(r.ProbeColo, r.Colo)
					}
					if best < 0 || r.Latency < best {
						best = r.Latency
					}
				} else {
					if res.Status == 0 {
						res.Status = r.Status
					}
					if res.Error == "" {
						res.Error = r.Error
					}
				}
			}
			res.OK = res.Successes > 0
			if best >= 0 {
				res.LatencyMs = best
			}
			sum.Results[i] = res
		}(i)
	}
	wg.Wait()

	if ctx.Err() != nil {
		return nil, ctx.Err()
	}

	// 排序：可用优先，其次 RTT 升序，失败的排最后（错误信息短的在前，便于扫读）
	sortMeshResults(sum.Results)
	sum.ElapsedMs = time.Since(started).Milliseconds()
	return sum, nil
}

// sortMeshResults 按「可用优先 → RTT 升序 → 失败项按错误串」排序。
func sortMeshResults(list []MeshEntryResult) {
	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if a.OK != b.OK {
			return a.OK
		}
		if a.OK && b.OK {
			return a.LatencyMs < b.LatencyMs
		}
		return a.Error < b.Error
	})
}

func isLowerHexString(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return len(s) > 0
}
