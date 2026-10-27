package scan

// 三阶扫描器。
//
// 默认值与 Electron 版 scan.ts 的 runScan **必须逐一对齐** ——
// 否则两版选出的 IP 不可比，用户会怀疑新版选得更差。

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// 阶段默认参数（与 Electron 版逐一对齐）。
const (
	defConcurrency      = 300   // 阶段一并发
	defTCPTimeoutMs     = 1200  // 阶段一超时
	defRetries          = 2     // 每个探测的尝试次数（含首次）
	defTLSConcurrency   = 64    // 阶段一之二并发（TLS 握手吃 CPU，过高会让本机成瓶颈）
	defTLSTimeoutMs     = 4000  // 阶段一之二超时
	defProbeLimit       = 120   // 进入阶段二的候选数
	defProbeConcurrency = 24    // 阶段二并发
	defProbeTimeoutMs   = 3000  // 阶段二超时
	defSpeedLimit       = 30    // 进入阶段三的候选数
	defSpeedConcurrency = 4     // 阶段三并发
	defSpeedTimeoutMs   = 12000 // 阶段三超时
	defSpeedBytes       = 5 * 1024 * 1024
	defTop              = 15
)

// Options 是扫描参数。
type Options struct {
	// Host 是用户域名（用于 TLS SNI 与 HTTP Host）
	Host string
	// Port 是端口，默认 443
	Port int
	// Candidates 是候选 IP 列表
	Candidates []string
	// WSPath 是代理的 WebSocket 路径（如 /fthiqeowoe）。
	//
	// ⚠️ 只用于 **WS 101 握手校验**（阶段二），不要拿去测速！
	WSPath string
	// ProbePath 是**测速探针端点**，默认 /__edge_probe。
	//
	// ## 为什么必须与 WSPath 分开
	//
	// 早期实现把 WSPath 同时用于两个用途：
	//   - 阶段二 WS 101 校验（正确：要校验代理路径真的能升级）
	//   - 阶段三 下行测速（**错误**：应该打探针端点）
	//
	// 后果：测速时向 `/fthiqeowoe?bytes=5242880` 发 GET，
	// 那是个 WebSocket 升级端点，普通 GET 只返回极短响应（约 17 字节），
	// 于是速度算出来是 0.00000418 MB/s —— 用户看到「所有节点下行接近 0」。
	//
	// Electron 版一直是对的：`options.probePath ?? '/__edge_probe'`，
	// 与 WS 路径完全无关。
	ProbePath string
	// Countries 是地区过滤（按机房代码，空表示不过滤）
	Countries []string

	// 以下均可留 0 用默认值
	Concurrency      int
	TCPTimeoutMs     int
	Retries          int
	TLSConcurrency   int
	TLSTimeoutMs     int
	MaxLatencyMs     int
	ProbeLimit       int
	ProbeConcurrency int
	ProbeTimeoutMs   int
	SpeedLimit       int
	SpeedConcurrency int
	SpeedTimeoutMs   int
	SpeedBytes       int
	Top              int

	// Progress 接收进度回调（可为 nil）
	Progress func(Progress)
}

// Progress 是进度事件。
type Progress struct {
	// Stage 是阶段名：tcp / tls / probe / speed
	Stage string
	// Done / Total 是当前阶段的进度
	Done  int
	Total int
	// Message 是给用户看的一句话
	Message string
}

// Entry 是一个优选结果。
type Entry struct {
	IP      string  `json:"ip"`
	Port    int     `json:"port"`
	Colo    string  `json:"colo"`
	Latency int64   `json:"latency"`
	TLSMs   int64   `json:"tlsMs"`
	Speed   float64 `json:"speed"`
}

// Summary 是扫描结果。
type Summary struct {
	Entries []Entry        `json:"entries"`
	Stats   map[string]int `json:"stats"`
}

// withDefaults 补齐默认值。
func (o Options) withDefaults() Options {
	set := func(p *int, v int) {
		if *p <= 0 {
			*p = v
		}
	}
	set(&o.Port, 443)
	set(&o.Concurrency, defConcurrency)
	set(&o.TCPTimeoutMs, defTCPTimeoutMs)
	set(&o.Retries, defRetries)
	set(&o.TLSConcurrency, defTLSConcurrency)
	set(&o.TLSTimeoutMs, defTLSTimeoutMs)
	set(&o.ProbeLimit, defProbeLimit)
	set(&o.ProbeConcurrency, defProbeConcurrency)
	set(&o.ProbeTimeoutMs, defProbeTimeoutMs)
	set(&o.SpeedLimit, defSpeedLimit)
	set(&o.SpeedConcurrency, defSpeedConcurrency)
	set(&o.SpeedTimeoutMs, defSpeedTimeoutMs)
	set(&o.SpeedBytes, defSpeedBytes)
	set(&o.Top, defTop)
	if o.WSPath == "" {
		if o.WSPath == "" {
			o.WSPath = ProbeDefaultPath
		}
		if o.ProbePath == "" {
			o.ProbePath = ProbeDefaultPath
		}
	}
	return o
}

// Run 执行三阶扫描。
func Run(ctx context.Context, raw Options) (*Summary, error) {
	opt := raw.withDefaults()

	if strings.TrimSpace(opt.Host) == "" {
		return nil, fmt.Errorf("缺少域名：优选必须知道用哪个域名做 TLS SNI / HTTP Host")
	}
	if len(opt.Candidates) == 0 {
		return nil, fmt.Errorf("候选 IP 为空")
	}

	report := func(p Progress) {
		if opt.Progress != nil {
			opt.Progress(p)
		}
	}

	stats := map[string]int{
		"candidates": len(opt.Candidates),
	}

	// ================= 阶段一：TCP 握手初筛 =================
	report(Progress{Stage: "tcp", Total: len(opt.Candidates), Message: "阶段一：TCP 握手初筛"})

	tcpResults := forEachIP(ctx, opt.Candidates, opt.Concurrency, func(ip string) (TCPResult, bool) {
		var last TCPResult
		for attempt := 0; attempt < opt.Retries; attempt++ {
			last = ProbeTCP(ctx, ip, opt.Port, msDuration(opt.TCPTimeoutMs))
			if last.OK {
				return last, true
			}
			if ctx.Err() != nil {
				return last, false
			}
		}
		return last, false
	}, func(done int) {
		report(Progress{Stage: "tcp", Done: done, Total: len(opt.Candidates), Message: "阶段一：TCP 握手初筛"})
	})

	stats["tcpOk"] = len(tcpResults)
	if len(tcpResults) == 0 {
		report(Progress{Stage: "tcp", Done: len(opt.Candidates), Total: len(opt.Candidates),
			Message: "阶段一完成，但没有任何 IP 能建立 TCP 连接"})
		return &Summary{Entries: []Entry{}, Stats: stats}, nil
	}

	// ================= 阶段一之二：TLS 握手筛选 =================
	//
	// -1 的根因修复：只过 TCP 不够。
	// 有些 IP 能建 TCP，但 TLS 握手极慢或直接失败 ——
	// 这种 IP 进了客户端就是 -1。所以必须实测 TLS 握手。
	report(Progress{Stage: "tls", Total: len(tcpResults), Message: "阶段一之二：TLS 握手筛选"})

	tlsOK := forEachIP(ctx, tcpResults, opt.TLSConcurrency, func(t TCPResult) (TLSResult, bool) {
		r := ProbeTLS(ctx, t.IP, opt.Port, opt.Host, msDuration(opt.TLSTimeoutMs))
		return r, r.OK
	}, func(done int) {
		report(Progress{Stage: "tls", Done: done, Total: len(tcpResults), Message: "阶段一之二：TLS 握手筛选"})
	})

	stats["tlsOk"] = len(tlsOK)
	if len(tlsOK) == 0 {
		report(Progress{Stage: "tls", Done: len(tcpResults), Total: len(tcpResults),
			Message: "TLS 握手全部失败 —— 检查域名是否正确、或换个采样数重试"})
		return &Summary{Entries: []Entry{}, Stats: stats}, nil
	}

	// 按 TLS 耗时排序后截取（TLS 快才真的能用）
	sortedTLS := make([]string, 0, len(tlsOK))
	tlsMsOf := make(map[string]int64, len(tlsOK))
	for _, r := range tlsOK {
		sortedTLS = append(sortedTLS, r.IP)
		tlsMsOf[r.IP] = r.TLSMs
	}
	sort.Slice(sortedTLS, func(i, j int) bool {
		return tlsMsOf[sortedTLS[i]] < tlsMsOf[sortedTLS[j]]
	})
	stage2 := sortedTLS
	if len(stage2) > opt.ProbeLimit {
		stage2 = stage2[:opt.ProbeLimit]
	}
	stats["stage2Input"] = len(stage2)

	// ================= 阶段二：WS 101 校验（强制前置） =================
	report(Progress{Stage: "probe", Total: len(stage2), Message: "阶段二：WebSocket 101 校验"})

	wsOK := forEachIP(ctx, stage2, opt.ProbeConcurrency, func(ip string) (WSResult, bool) {
		var last WSResult
		for attempt := 0; attempt < opt.Retries; attempt++ {
			last = ProbeWS101(ctx, ip, opt.Port, opt.Host, msDuration(opt.ProbeTimeoutMs), opt.WSPath)
			if last.OK {
				return last, true
			}
			if ctx.Err() != nil {
				return last, false
			}
		}
		return last, false
	}, func(done int) {
		report(Progress{Stage: "probe", Done: done, Total: len(stage2), Message: "阶段二：WebSocket 101 校验"})
	})

	stats["wsOk"] = len(wsOK)
	if len(wsOK) == 0 {
		report(Progress{Stage: "probe", Done: len(stage2), Total: len(stage2),
			Message: "阶段二全部失败：没有 IP 能完成 WebSocket 101 升级（检查 WS 路径）"})
		return &Summary{Entries: []Entry{}, Stats: stats}, nil
	}

	// 地区过滤（机房信息来自阶段二的 101 响应）
	wsFiltered := wsOK
	if len(opt.Countries) > 0 {
		want := make(map[string]bool, len(opt.Countries))
		for _, c := range opt.Countries {
			want[strings.ToUpper(strings.TrimSpace(c))] = true
		}
		var keep []WSResult
		for _, r := range wsOK {
			if want[strings.ToUpper(r.Colo)] {
				keep = append(keep, r)
			}
		}
		// 筛完为空时**忽略该筛选**（不阻断），否则用户会以为扫描失败
		if len(keep) > 0 {
			wsFiltered = keep
			stats["countryFiltered"] = len(wsOK) - len(keep)
		} else {
			stats["countryFilterIgnored"] = 1
			report(Progress{Stage: "probe",
				Message: "所选地区没有匹配的 IP，已忽略地区筛选（可调大采样数再试）"})
		}
	}

	// 按 101 延迟排序后截取进入测速
	sort.Slice(wsFiltered, func(i, j int) bool {
		return wsFiltered[i].Latency < wsFiltered[j].Latency
	})
	stage3 := wsFiltered
	if len(stage3) > opt.SpeedLimit {
		stage3 = stage3[:opt.SpeedLimit]
	}
	stats["stage3Input"] = len(stage3)

	// ================= 阶段三：真实下行测速 =================
	report(Progress{Stage: "speed", Total: len(stage3), Message: "阶段三：真实下行测速"})

	type speedOut struct {
		ws WSResult
		dl DownloadResult
	}
	speedResults := forEachIP(ctx, stage3, opt.SpeedConcurrency, func(r WSResult) (speedOut, bool) {
		// ⚠️ 测速必须打**探针端点**（ProbePath），不是代理的 WS 路径。
		// 用 WS 路径打 GET 只会拿到 17 字节的升级失败响应，
		// 算出来的速度是 0.000004 MB/s（用户实测踩过）。
		dl := MeasureDownload(ctx, r.IP, opt.Port, opt.Host, opt.SpeedBytes,
			msDuration(opt.SpeedTimeoutMs), opt.ProbePath)
		return speedOut{ws: r, dl: dl}, dl.OK
	}, func(done int) {
		report(Progress{Stage: "speed", Done: done, Total: len(stage3), Message: "阶段三：真实下行测速"})
	})

	// 组装结果：只保留测速成功的
	entries := make([]Entry, 0, len(speedResults))
	for _, sr := range speedResults {
		entries = append(entries, Entry{
			IP:      sr.ws.IP,
			Port:    opt.Port,
			Colo:    sr.ws.Colo,
			Latency: sr.ws.Latency,
			TLSMs:   tlsMsOf[sr.ws.IP],
			Speed:   sr.dl.SpeedMBps,
		})
	}

	// 按速度降序，速度相同按延迟升序
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Speed != entries[j].Speed {
			return entries[i].Speed > entries[j].Speed
		}
		return entries[i].Latency < entries[j].Latency
	})
	if len(entries) > opt.Top {
		entries = entries[:opt.Top]
	}

	stats["speedOk"] = len(speedResults)
	stats["final"] = len(entries)

	report(Progress{Stage: "speed", Done: len(stage3), Total: len(stage3),
		Message: fmt.Sprintf("完成：%d 个可用节点", len(entries))})

	return &Summary{Entries: entries, Stats: stats}, nil
}

// ------------------------------------------------------------------
// 并发执行器
// ------------------------------------------------------------------

// forEachIP 对一批输入并发执行 fn，只收集返回 ok=true 的结果。
//
// 用固定数量的 worker 消费任务队列：并发上限严格可控，
// 不会因为候选有几万个就起几万个 goroutine。
//
// 泛型签名是 `func(In) (Out, bool)` —— 输入与输出类型可以不同
// （例如阶段一是 IP → TCPResult，阶段三是 WSResult → speedOut）。
func forEachIP[In any, Out any](
	ctx context.Context,
	items []In,
	concurrency int,
	fn func(In) (Out, bool),
	onProgress func(done int),
) []Out {
	if concurrency < 1 {
		concurrency = 1
	}

	jobs := make(chan In)
	var mu sync.Mutex
	var out []Out
	done := 0

	var wg sync.WaitGroup
	for w := 0; w < concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for it := range jobs {
				if ctx.Err() != nil {
					return
				}
				val, ok := fn(it)
				mu.Lock()
				done++
				d := done
				if ok {
					out = append(out, val)
				}
				mu.Unlock()
				if onProgress != nil {
					onProgress(d)
				}
			}
		}()
	}

	func() {
		defer close(jobs)
		for _, it := range items {
			select {
			case <-ctx.Done():
				return
			case jobs <- it:
			}
		}
	}()
	wg.Wait()

	return out
}

// msDuration 把毫秒数转成 time.Duration。
func msDuration(ms int) time.Duration {
	return time.Duration(ms) * time.Millisecond
}
