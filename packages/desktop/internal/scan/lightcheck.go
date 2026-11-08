package scan

// Phase 3 · 轻量校验：TCP 三次握手 + TLS 握手，跑到 TLS 即停。
//
// 与 packages/cli/src/sources/light.ts 同语义、同四道成本闸门。
// 不发 WS 升级、不测速、不回填；结果只写进池里的 lightCheck，
// status 仍是 pending —— active 只能由 Phase 4 完整优选写入。
//
// 校验失败的候选也留在池里（带 tcpOk/tlsOk=false），Phase 4 取样时过滤；
// 物理删掉的话下一轮采集又会捡回来重测，白烧一轮连接预算。

import (
	"context"
	"sync"
	"time"
)

const (
	LightMaxPerSync       = 100
	LightConcurrency      = 8
	LightConnectTimeoutMS = 2_000
	LightTotalTimeoutMS   = 30_000
	LightRefreshMS        = int64(7 * 24 * 60 * 60 * 1000)
	DefaultLightSNI       = "cloudflare.com"
)

type LightCheckOptions struct {
	// SNI 由调用方传入（桌面版从当前账号的数据面域名取），缺省 cloudflare.com
	SNI              string
	MaxPerSync       int
	Concurrency      int
	ConnectTimeoutMS int64
	TotalTimeoutMS   int64
	Now              int64
	// 测试注入：替换 TCP / TLS 探测
	TCPProbe func(ctx context.Context, ip string, port int, timeout time.Duration) bool
	TLSProbe func(ctx context.Context, ip string, port int, host string, timeout time.Duration) (bool, int64)
}

func defaultTCPProbe(ctx context.Context, ip string, port int, timeout time.Duration) bool {
	return ProbeTCP(ctx, ip, port, timeout).OK
}

func defaultTLSProbe(ctx context.Context, ip string, port int, host string, timeout time.Duration) (bool, int64) {
	r := ProbeTLS(ctx, ip, port, host, timeout)
	return r.OK, r.TLSMs
}

func needsLightCheck(pool *ExternalPool, key string, now int64) bool {
	for i := range pool.Candidates {
		if pool.Candidates[i].Key != key {
			continue
		}
		lc := pool.Candidates[i].LightCheck
		if lc == nil {
			return true
		}
		return now-lc.At > LightRefreshMS
	}
	return true
}

// LightCheckCandidates 只校验「新发现 / lightCheck 已过期」的候选，
// 全程不写任何文件（由 SyncSources 在目录锁内统一落盘）。
func LightCheckCandidates(ctx context.Context, inputs []CandidateInput, opts LightCheckOptions) []CandidateInput {
	now := opts.Now
	if now == 0 {
		now = nowMS()
	}
	max := opts.MaxPerSync
	if max <= 0 {
		max = LightMaxPerSync
	}
	concurrency := opts.Concurrency
	if concurrency <= 0 {
		concurrency = LightConcurrency
	}
	connectMS := opts.ConnectTimeoutMS
	if connectMS <= 0 {
		connectMS = LightConnectTimeoutMS
	}
	totalMS := opts.TotalTimeoutMS
	if totalMS <= 0 {
		totalMS = LightTotalTimeoutMS
	}
	sni := opts.SNI
	if sni == "" {
		sni = DefaultLightSNI
	}
	tcpProbe := opts.TCPProbe
	if tcpProbe == nil {
		tcpProbe = defaultTCPProbe
	}
	tlsProbe := opts.TLSProbe
	if tlsProbe == nil {
		tlsProbe = defaultTLSProbe
	}

	out := make([]CandidateInput, len(inputs))
	copy(out, inputs)
	// 结构体里带指针字段，逐条浅拷贝避免与调用方共享 LightCheck 指针
	for i := range out {
		out[i].LightCheck = nil
		if out[i].Port != nil {
			p := *out[i].Port
			out[i].Port = &p
		}
	}

	pool := ParsePool(ReadPoolRaw())
	pending := make([]int, 0, max)
	for i := range out {
		if len(pending) >= max {
			break
		}
		port := 443
		if out[i].Port != nil {
			port = *out[i].Port
		}
		key, ok := NormalizeCandidateKey(out[i].IP, port)
		if !ok {
			continue // 非法 IP 交给 UpsertCandidates 统一拒绝
		}
		if needsLightCheck(pool, key, now) {
			pending = append(pending, i)
		}
	}

	timeout := time.Duration(connectMS) * time.Millisecond
	deadline := time.Now().Add(time.Duration(totalMS) * time.Millisecond)
	workCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()

	var cursor int64
	var mu sync.Mutex
	var wg sync.WaitGroup
	workers := concurrency
	if workers > len(pending) {
		workers = len(pending)
	}
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				if workCtx.Err() != nil {
					return
				}
				mu.Lock()
				if int(cursor) >= len(pending) {
					mu.Unlock()
					return
				}
				idx := pending[cursor]
				cursor++
				mu.Unlock()

				input := &out[idx]
				port := 443
				if input.Port != nil {
					port = *input.Port
				}
				tcpOK := tcpProbe(workCtx, input.IP, port, timeout)
				lc := &LightCheck{TCPOk: tcpOK, TLSOk: false, At: now}
				if tcpOK {
					ok, ms := tlsProbe(workCtx, input.IP, port, sni, timeout)
					lc.TLSOk = ok
					if ok && ms > 0 {
						v := ms
						lc.TLSMs = &v
					}
				}
				input.LightCheck = lc
			}
		}()
	}
	wg.Wait()
	return out
}
