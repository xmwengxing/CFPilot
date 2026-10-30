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
	defConcurrency    = 300  // 阶段一并发
	defTCPTimeoutMs   = 1200 // 阶段一超时
	defRetries        = 2    // 每个探测的尝试次数（含首次）
	defTLSConcurrency = 64   // 阶段一之二并发（TLS 握手吃 CPU，过高会让本机成瓶颈）
	// 阶段一之二超时。
	//
	// 默认 2000ms（旧值 4000ms）：优选场景下握手超过 2 秒的节点已无实用价值，
	// 而超时后**不再重试**（见下方 tlsProbe 的 shouldRetry），
	// 所以单 IP 最坏只占 2 秒而不是 8 秒。
	defTLSTimeoutMs     = 2000
	defProbeLimit       = 120  // 进入阶段二的候选数
	defProbeConcurrency = 24   // 阶段二并发
	defProbeTimeoutMs   = 3000 // 阶段二超时
	defSpeedLimit       = 30   // 进入阶段三的候选数

	// defSpeedConcurrency 是**候选之间**的测速并行数，默认 1（串行）。
	//
	// ## 为什么必须串行（对照 CLI packages/cli/src/scan/scan.ts 的 speedConcurrency）
	//
	// 阶段三测的是**带宽**，而带宽是整条链路共享的资源。
	// 2026-10-28 真机定位：默认 4 路并行时，每个候选只能分到约 1/4 带宽，
	// 于是无论 IP 好坏，测出来全是 0.1~0.2 MB/s —— 用户看到的就是
	// 「优选出来的 IP 全都只有 0.1~0.9 MB/s」。
	//
	// 并行只适合测「延迟」这类不占带宽的指标（TCP / TLS / 101 阶段就是这么做的）。
	// 串行代价可控：每次测量有时长上限（默认 6s），30 个候选约 3 分钟；
	// 想更快可以调小 SpeedLimit 或 SpeedDurationMs。
	defSpeedConcurrency = 1

	// defSpeedConnections 是**每个候选**的并发连接数，默认 8。
	//
	// 单条 TCP 受丢包 / 拥塞窗口 / BDP 限制，在跨境线路上填不满实际带宽。
	// 2026-10-28 直连实测同一个 IP：1 条 0.12 MB/s、3 条 0.47、8 条 1.15、
	// 16 条 2.22 —— 用 3 条会系统性低估 2~4 倍。
	// 对照 CLI 的 speedConnections（measureProbeThroughput 的 connections）。
	defSpeedConnections = defMeasureConnections

	// defSpeedDurationMs 是单次测量时长（对照 CLI 的 speedDurationMs）。
	defSpeedDurationMs = defMeasureDurationMs

	// defSpeedTimeoutMs 是**整体预算**（含拨号 / 握手 / 传输），到点必返回。
	// ⚠️ 这是「测速永远挂住」缺陷的兜底，不要退化。
	defSpeedTimeoutMs = 12000
	defSpeedBytes     = defMeasureBytes
	defTop            = 8
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
	// SpeedConnections 是每个候选的并发连接数（0 = 默认 3）。
	//
	// 阶段三的「并发」有两层，别混淆：
	//   - SpeedConcurrency：**候选之间**并行（默认 1 串行，带宽共享）；
	//   - SpeedConnections：**同一个候选**开几条 TCP 流（默认 3，单流填不满链路）。
	SpeedConnections int
	// SpeedDurationMs 是单次测量时长（0 = 默认 6000ms），不含整体预算。
	SpeedDurationMs int
	SpeedTimeoutMs  int
	SpeedBytes      int
	Top             int

	// SkipSpeed 跳过阶段三的下行测速。
	//
	// 跳过时结果按 **101 延迟**排序（测速结果为 0），
	// 用于「只要能用、不在乎快慢」的场景（一键优选、后台任务）。
	//
	// ⚠️ 与 CLI 的 --no-speed 语义一致（packages/cli/src/scan/scan.ts）。
	SkipSpeed bool

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
	set(&o.SpeedConnections, defSpeedConnections)
	set(&o.SpeedDurationMs, defSpeedDurationMs)
	set(&o.SpeedTimeoutMs, defSpeedTimeoutMs)
	set(&o.SpeedBytes, defSpeedBytes)
	set(&o.Top, defTop)
	// ⚠️ 两个默认值必须**各自独立**判断。
	//
	// 原来 ProbePath 的赋值被**嵌在** `if o.WSPath == ""` 里面 ——
	// 于是「设了 WSPath 但没设 ProbePath」时 ProbePath 保持空串，
	// 阶段三会 GET 一个空路径 → 测速全失败 → 结果 0 条。
	//
	// 界面「自动识别」正是会填 WSPath（代理路径）而不一定填 ProbePath，
	// 所以这个组合在实际使用中会出现。
	if o.WSPath == "" {
		o.WSPath = ProbeDefaultPath
	}
	if o.ProbePath == "" {
		o.ProbePath = ProbeDefaultPath
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

	// 阶段二候选池大小。
	//
	// 机房（colo）只有 WS 101 响应里才有，TCP / TLS 阶段无从得知，
	// 所以地区筛选只能在阶段二之后做 —— 这带来一个结构性问题：
	// 进入阶段二的候选是「按 TLS 耗时排序后的前 N 个」，
	// 若用户所在网络到某些地区延迟最低，这 N 个会被占满，
	// 后面稍微慢几毫秒的目标地区节点早已被截断掉。
	//
	// 因此**带地区筛选时自动扩大阶段二候选池**，
	// 让目标地区有机会进入探测范围。
	effectiveProbeLimit := opt.ProbeLimit
	if len(opt.Countries) > 0 {
		effectiveProbeLimit = opt.ProbeLimit * 4
		if effectiveProbeLimit < 500 {
			effectiveProbeLimit = 500
		}
	}

	stats := map[string]int{
		"candidates": len(opt.Candidates),
	}

	// ================= 阶段一：TCP 握手初筛 =================
	report(Progress{Stage: "tcp", Total: len(opt.Candidates), Message: "阶段一：TCP 握手初筛"})

	tcpResults := forEachIPAdaptive(ctx, opt.Candidates, opt.Concurrency, func(ip string) (TCPResult, bool) {
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
	}, 200)

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

	// ⚠️ **先粗筛再握手**：TCP 通过的候选可能有几千个，但最终只有
	// effectiveProbeLimit 个能进阶段二。为后面几千名做 CPU 密集的 TLS 握手
	// 纯属浪费（而且假通 IP 会占满并发槽位）。
	// 先按 TCP 延迟升序取前 max(limit*4, 600) 个再做 TLS 握手。
	//
	// 注意：粗筛只用 **TCP 延迟**排序，**不改变最终的排序依据** ——
	// 最终排序仍然是 TLS 握手耗时（唯一有区分度的指标）。
	tlsInput := tcpResults
	tlsCandidateLimit := effectiveProbeLimit * 4
	if tlsCandidateLimit < 600 {
		tlsCandidateLimit = 600
	}
	if len(tlsInput) > tlsCandidateLimit {
		sorted := make([]TCPResult, len(tlsInput))
		copy(sorted, tlsInput)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i].Latency < sorted[j].Latency })
		tlsInput = sorted[:tlsCandidateLimit]
	}

	tlsOK := forEachIPAdaptive(ctx, tlsInput, opt.TLSConcurrency, func(t TCPResult) (TLSResult, bool) {
		// ⚠️ 超时不重试：TLS 握手超时说明这个 IP 在当前网络下就是不可用，
		// 再试一次也是同样的结果，却要让并发槽位多占一个超时周期。
		// 只有「连接被重置」这类偶发错误才值得重试。
		r := TLSResult{}
		for attempt := 0; attempt < opt.Retries; attempt++ {
			r = ProbeTLS(ctx, t.IP, opt.Port, opt.Host, msDuration(opt.TLSTimeoutMs))
			if r.OK {
				return r, true
			}
			if ctx.Err() != nil {
				return r, false
			}
			if isTimeoutError(r.Error) {
				break
			}
		}
		return r, false
	}, func(done int) {
		report(Progress{Stage: "tls", Done: done, Total: len(tlsInput), Message: "阶段一之二：TLS 握手筛选"})
	}, 200)

	stats["tlsOk"] = len(tlsOK)
	if len(tlsOK) == 0 {
		report(Progress{Stage: "tls", Done: len(tlsInput), Total: len(tlsInput),
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
	if len(stage2) > effectiveProbeLimit {
		stage2 = stage2[:effectiveProbeLimit]
	}
	stats["stage2Input"] = len(stage2)

	// ================= 阶段二：WS 101 校验（强制前置） =================
	report(Progress{Stage: "probe", Total: len(stage2), Message: "阶段二：WebSocket 101 校验"})

	// 早期退出判据：带地区筛选时，攒够够用的目标地区节点就收工。
	//
	// 阈值取 SpeedLimit * 1.5，留出余量应对后续测速淘汰。
	earlyExitTarget := opt.SpeedLimit * 3 / 2
	matchedCount := 0
	// 目标地区集合（阶段二拿到 colo 后比对）
	//
	// 用 ExpandCountryFilter：国家代码（US）展开成该国全部机房，
	// 机房代码（LAX）直接匹配 —— 与 CLI 版语义一致。
	wantCountries := ExpandCountryFilter(opt.Countries)

	wsOK := forEachIP(ctx, stage2, opt.ProbeConcurrency, func(ip string) (WSResult, bool) {
		var last WSResult
		for attempt := 0; attempt < opt.Retries; attempt++ {
			last = ProbeWS101(ctx, ip, opt.Port, opt.Host, msDuration(opt.ProbeTimeoutMs), opt.WSPath)
			if last.OK {
				// 统计命中目标地区的数量（早期退出判据）
				if len(wantCountries) > 0 && wantCountries[strings.ToUpper(last.Colo)] {
					matchedCount++
				}
				return last, true
			}
			if ctx.Err() != nil {
				return last, false
			}
		}
		return last, false
	}, func(done int) {
		report(Progress{Stage: "probe", Done: done, Total: len(stage2), Message: "阶段二：WebSocket 101 校验"})
	}, func() bool {
		// 早期退出：带地区筛选时，攒够够用的目标地区节点就收工。
		//
		// 为什么要提前退：扩大候选池后阶段二最多要探 500 个，
		// 但用户只要 SpeedLimit 个节点 —— 探到第 20 个时就可以停，
		// 省掉后面几百次 WS 探测（每次 3 秒超时）。
		//
		// 阈值取 SpeedLimit * 1.5，留出余量应对后续测速淘汰。
		return len(opt.Countries) > 0 && matchedCount >= earlyExitTarget
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
		want := ExpandCountryFilter(opt.Countries)
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
	//
	// SkipSpeed 时不做测速，直接把 101 通过的候选当作结果
	// （速度记 0，排序退化为按 101 延迟）。
	if opt.SkipSpeed {
		report(Progress{Stage: "speed", Total: len(stage3), Message: "阶段三：跳过测速（按延迟排序）"})
		entries := make([]Entry, 0, len(stage3))
		for _, r := range stage3 {
			entries = append(entries, Entry{
				IP:      r.IP,
				Port:    opt.Port,
				Colo:    r.Colo,
				Latency: r.Latency,
				TLSMs:   tlsMsOf[r.IP],
				Speed:   0,
			})
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Latency < entries[j].Latency })
		entries = PickWithDiversity(entries, opt.Top)
		stats["speedOk"] = len(entries)
		stats["skippedSpeed"] = 1
		return &Summary{Entries: entries, Stats: stats}, nil
	}

	report(Progress{Stage: "speed", Total: len(stage3), Message: "阶段三：真实下行测速（多流稳态）"})

	type speedOut struct {
		ws WSResult
		dl DownloadResult
	}
	// 进度文案要带**稳态值**（对外口径），因此记录最近一次测量结果。
	// 默认 SpeedConcurrency = 1（串行），这里的加锁只为兼容显式调高并发的场景。
	var speedMu sync.Mutex
	lastSteady := 0.0
	speedResults := forEachIP(ctx, stage3, opt.SpeedConcurrency, func(r WSResult) (speedOut, bool) {
		// ⚠️ 测速必须打**探针端点**（ProbePath），不是代理的 WS 路径。
		// 用 WS 路径打 GET 只会拿到 17 字节的升级失败响应，
		// 算出来的速度是 0.000004 MB/s（用户实测踩过）。
		//
		// 口径对照 CLI packages/cli/src/scan/true-probe.ts 的
		// measureProbeThroughput：多连接（默认 3）+ 丢预热 + 稳态吞吐。
		dl := MeasureThroughput(ctx, MeasureOptions{
			IP:          r.IP,
			Port:        opt.Port,
			Host:        opt.Host,
			BytesWanted: opt.SpeedBytes,
			Timeout:     msDuration(opt.SpeedTimeoutMs),
			Path:        opt.ProbePath,
			Connections: opt.SpeedConnections,
			Duration:    msDuration(opt.SpeedDurationMs),
		})
		speedMu.Lock()
		lastSteady = dl.SteadyMBps
		speedMu.Unlock()
		return speedOut{ws: r, dl: dl}, dl.OK
	}, func(done int) {
		speedMu.Lock()
		steady := lastSteady
		speedMu.Unlock()
		report(Progress{Stage: "speed", Done: done, Total: len(stage3),
			Message: fmt.Sprintf("阶段三：真实下行测速（稳态 %.1f MB/s）", steady)})
	}, nil)

	// 组装结果：只保留测速成功的
	entries := make([]Entry, 0, len(speedResults))
	for _, sr := range speedResults {
		entries = append(entries, Entry{
			IP:      sr.ws.IP,
			Port:    opt.Port,
			Colo:    sr.ws.Colo,
			Latency: sr.ws.Latency,
			TLSMs:   tlsMsOf[sr.ws.IP],
			// ⚠️ 对外报**稳态值**，不是窗口峰值（峰值只作诊断）。
			Speed: sr.dl.SteadyMBps,
		})
	}

	// 按速度降序，速度相同按延迟升序
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Speed != entries[j].Speed {
			return entries[i].Speed > entries[j].Speed
		}
		return entries[i].Latency < entries[j].Latency
	})
	// 取前 N 时按 /16 轮流取（对照 CLI 的 pickWithDiversity）
	entries = PickWithDiversity(entries, opt.Top)

	stats["speedOk"] = len(speedResults)
	stats["final"] = len(entries)

	report(Progress{Stage: "speed", Done: len(stage3), Total: len(stage3),
		Message: fmt.Sprintf("完成：%d 个可用节点", len(entries))})

	return &Summary{Entries: entries, Stats: stats}, nil
}

// forEachIPAdaptive 是**自适应并发**的版本。
//
// ## 为什么需要
//
// 并发不是越高越好 —— 高并发会撞上本机/网络侧的瓶颈，
// 表现为「超时率随并发上升」，反而拿不到更多可用节点。
//
// 真机实测（本机开着 TUN 代理、且代理用的就是本项目的订阅节点）：
//
//	并发  20  → TCP 成功率 100%
//	并发  50  → TCP 100%，但 TLS 阶段掉到 4%
//	并发 100  → TCP 49%
//	并发 300  → TCP 26%
//
// 固定并发在这类环境里会直接崩掉（阶段一就全军覆没）。
// 这里改成**按批评估、自动升降**：
//
//	每批 200 个候选跑完后看成功率：
//	  < 40%  → 并发减半（下限 min(8, 请求值)）
//	  > 85%  → 并发翻倍（上限 = 请求值）
//
// ⚠️ 下限必须受请求值约束：写死 8 会让「用户指定并发 2 / 4 / 6」的
// 低并发配置在成功率变差时反而**升到 8** —— 与用户设置相反。
//
// 网络好时自动升回高并发（速度不损失），
// 网络被限速/被 TUN 干扰时自动退到能跑通的并发度（结果不空）。
//
// ⚠️ 与 CLI 版 packages/cli/src/scan/scan.ts 的 poolAdaptive 语义一致
// （AGENTS.md §2.2：两端行为必须一致）。
func forEachIPAdaptive[In any, Out any](
	ctx context.Context,
	items []In,
	concurrency int,
	fn func(In) (Out, bool),
	onProgress func(done int),
	batchSize int,
) []Out {
	if batchSize <= 0 {
		batchSize = 200
	}
	maxConcurrency := concurrency
	if maxConcurrency < 1 {
		maxConcurrency = 1
	}
	// 下限也只能到请求值：用户设 2 时下限不能是 8
	minConcurrency := 8
	if minConcurrency > maxConcurrency {
		minConcurrency = maxConcurrency
	}
	current := maxConcurrency

	out := make([]Out, 0, len(items))
	// ⚠️ **进度计数必须跨批次累计**。
	//
	// forEachIP 内部的计数器是**每批从 1 开始**的。
	// 直接透传的话，界面上的进度会变成：
	//
	//     1/600 … 200/600   1/600 … 200/600   1/600 … 200/600
	//
	// 看起来就是「序号一直重置、永远到不了 600/600」。
	// （真机症状：阶段一之二 显示到 120/600 又回到 1/600 狂刷。）
	//
	// 所以这里给每批的进度加上**已完成批次的偏移**。
	offset := 0
	for start := 0; start < len(items); start += batchSize {
		end := start + batchSize
		if end > len(items) {
			end = len(items)
		}
		batch := items[start:end]

		results := forEachIP(ctx, batch, current, fn, func(done int) {
			if onProgress != nil {
				onProgress(offset + done)
			}
		}, nil)
		out = append(out, results...)
		offset += len(batch)

		// 评估本批成功率
		okCount := 0
		for _, r := range results {
			if itemOK(r) {
				okCount++
			}
		}
		rate := 1.0
		if len(results) > 0 {
			rate = float64(okCount) / float64(len(results))
		}
		if rate < 0.4 {
			current = current / 2
			if current < minConcurrency {
				current = minConcurrency
			}
			if current > maxConcurrency {
				current = maxConcurrency
			}
		} else if rate > 0.85 {
			current = current * 2
			if current > maxConcurrency {
				current = maxConcurrency
			}
		}
	}
	return out
}

// itemOK 判断一个探测结果是否成功。
//
// TCPResult / TLSResult / WSResult 都有 ok 字段，
// 这里用类型断言统一处理（避免为每个类型写一遍）。
func itemOK(v any) bool {
	switch r := v.(type) {
	case TCPResult:
		return r.OK
	case TLSResult:
		return r.OK
	case WSResult:
		return r.OK
	default:
		return false
	}
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
// forEachIP 并发遍历。
//
// shouldStop 可选：返回 true 时不再派发新任务（已在跑的任务会跑完）。
// 用于「已经拿到足够多的目标结果就收工」。
func forEachIP[In any, Out any](
	ctx context.Context,
	items []In,
	concurrency int,
	fn func(In) (Out, bool),
	onProgress func(done int),
	shouldStop ...func() bool,
) []Out {
	if concurrency < 1 {
		concurrency = 1
	}
	// 可选的提前终止判定（variadic，保持旧调用点不变）
	var stop func() bool
	if len(shouldStop) > 0 {
		stop = shouldStop[0]
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
			if stop != nil && stop() {
				return
			}
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

// isTimeoutError 判断错误是否属于「超时」。
//
// 超时意味着「这个 IP 在当前网络下不可用」，重试一次也是同样结果，
// 只会让并发槽位多占一个超时周期。偶发错误（连接重置等）才值得重试。
//
// 对应 CLI 版 packages/cli/src/scan/scan.ts 的 isTimeoutError。
func isTimeoutError(errMsg string) bool {
	if errMsg == "" {
		return false
	}
	lower := strings.ToLower(errMsg)
	return strings.Contains(lower, "超时") ||
		strings.Contains(lower, "timeout") ||
		strings.Contains(lower, "timed out") ||
		strings.Contains(lower, "etimedout")
}

// PickWithDiversity 按 /16 轮流取前 top 条，保证结果覆盖多个网段。
//
// ## 为什么（对照 CLI packages/cli/src/scan/scan.ts 的 pickWithDiversity）
//
// Cloudflare 的好 IP 高度集中在少数 /16（实测 104.16–104.19 占了大半）。
// 直接切前 N 名经常得到「同一个 /16 的 N 个 IP」：它们走同一段路由、同一个入口，
// 一旦那段拥塞或被 QoS，整批节点同时劣化，用户手上没有备选。
//
// 轮流取（每轮从每个 /16 取当前最好的一条）既保住速度排序，又保证网段覆盖；
// 桶内仍保持传入顺序（即速度降序）。只有一个网段时与直接截取完全一致。
func PickWithDiversity(entries []Entry, top int) []Entry {
	if top <= 0 {
		return nil
	}
	if len(entries) <= top {
		return entries
	}

	order := make([]string, 0, len(entries))
	buckets := make(map[string][]Entry, len(entries))
	for _, e := range entries {
		key := ipv4Prefix16(e.IP)
		if _, ok := buckets[key]; !ok {
			order = append(order, key)
		}
		buckets[key] = append(buckets[key], e)
	}
	if len(order) <= 1 {
		return entries[:top]
	}

	out := make([]Entry, 0, top)
	for round := 0; len(out) < top; round++ {
		picked := false
		for _, key := range order {
			if len(out) >= top {
				break
			}
			if round < len(buckets[key]) {
				out = append(out, buckets[key][round])
				picked = true
			}
		}
		if !picked {
			break
		}
	}
	return out
}

// ipv4Prefix16 取 IPv4 的前两段作为分桶键（如 104.16）。
// IPv6 或格式异常时退回整串（等价于不参与多样性分桶）。
func ipv4Prefix16(ip string) string {
	parts := strings.Split(ip, ".")
	if len(parts) != 4 {
		return ip
	}
	return parts[0] + "." + parts[1]
}
