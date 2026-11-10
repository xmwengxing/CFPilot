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

	// ---- 两轮测速（全量短测粗排）的默认参数 ----
	//
	// ⚠️ 必须逐项对齐 CLI packages/cli/src/scan/scan.ts 的 COARSE_SPEED_DEFAULTS
	// （AGENTS.md §2.2：CLI 是优选扫描的权威实现）。
	//
	// 粗筛只回答「谁相对更快」，不回答「绝对带宽多少」：
	// 1.2s / 2 连接的数值与 6s / 8 连接的精测**不可比**，因此粗测值
	// 只进排序 Map，绝不写进 Entry.Speed（对外速度仍由精测给出）。
	defCoarseSpeedLimit  = 120  // 粗筛候选上限（带地区筛选时阶段二可达 500）
	defCoarseDurationMs  = 1200 // 单次粗测时长（精测 6s 的 1/5）
	defCoarseWarmupMs    = 300  // 短测不能沿用精测的 1s 预热，否则没有稳态样本
	defCoarseWindowMs    = 300
	defCoarseConnections = 2      // 精测 8 条的 1/4
	defCoarseTimeoutMs   = 3000   // 单次整体预算，失败候选最多占 3s
	defCoarseBudgetMs    = 240000 // 整个粗筛阶段总预算（4 分钟），到点剩余按延迟兜底
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
	// ProbeTransport 是探测传输分类：ws|xhttp|both，空 = ws（对照 CLI --probe-transport）
	ProbeTransport string
	// XHTTPPath 是 XHTTP 路径，默认 /xhttp
	XHTTPPath string
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
	// TwoStageSpeed 开启「两轮测速」：对全部 101 通过候选先做短测粗排，
	// 再对粗排前 SpeedLimit 个做原有的完整精测。
	//
	// 零值 = 关闭（保持旧行为），由外壳（桌面版界面 / CLI flag）显式开启。
	// 对照 CLI packages/cli/src/scan/scan.ts 的 twoStageSpeed。
	TwoStageSpeed bool
	// 以下粗筛参数留 0 用 defCoarse* 默认值。
	CoarseSpeedLimit  int
	CoarseDurationMs  int
	CoarseConnections int
	CoarseTimeoutMs   int
	CoarseBudgetMs    int
	SpeedConcurrency  int
	// SpeedConnections 是每个候选的并发连接数（0 = 默认 8）。
	//
	// 阶段三的「并发」有两层，别混淆：
	//   - SpeedConcurrency：**候选之间**并行（默认 1 串行，带宽共享）；
	//   - SpeedConnections：**同一个候选**开几条 TCP 流（默认 8，单流填不满链路）。
	//
	// 实测同一个 IP：1 条 0.12 MB/s、3 条 0.47、8 条 1.15、16 条 2.22 ——
	// 用 1~3 条会系统性低估 2~4 倍。上限 8（与 CLI 的 --speed-conns 一致）。
	SpeedConnections int
	// SpeedDurationMs 是单次测量时长（0 = 默认 6000ms，上限 10000ms），不含整体预算。
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

	// MinSpeedMBps 是下行速度下限（MB/s）：稳态吞吐低于该值的候选淘汰。
	// 0 = 不过滤。
	//
	// ## 判定口径
	//
	// 用**稳态值**（Entry.Speed），不是峰值 —— 单窗口突发能把峰值翻倍
	// （真机实测 2.46 vs 1.14），拿峰值当门槛会把「偶然冲高」的 IP
	// 当成好节点留下。
	//
	// ## 与 SkipSpeed 互斥
	//
	// 跳过测速时速度恒为 0，任何非零下限都会把结果全部淘汰。
	// 所以这里直接报错，而不是静默返回空结果。
	//
	// 对应 CLI 的 --min-speed（packages/cli/src/scan/scan.ts）。
	MinSpeedMBps float64

	// VerifyPayload 开启阶段二的 PING/PONG 响应体校验（CLI 默认的严格模式）。
	//
	// 开启后阶段二打 **ProbePath**（探针端点）而不是 WSPath —— 对 VLESS/Trojan
	// 入站路径发 PING 永远等不到响应（真机实测探针路径 16/20 通过、入站路径 0/20）。
	// 同时会对真实 WSPath 补一次纯 101 校验。
	//
	// 零值 = 关闭，保持旧的「只看 101」行为，由外壳显式开启；目标没有探针端点时
	// 会自动降级回纯 101（见 Run 里的 DetectProbeEndpoint）。
	VerifyPayload bool

	// 以下四项用于阶段二点五真实隧道校验。给了 UUID 或 TrojanPassword
	// 且 WSPath 有效时才会跑（与 CLI verifyTunnel 的触发条件一致）。
	UUID             string
	TrojanPassword   string
	VerifyTargetHost string
	VerifyTargetPort int

	// ProbeObserver 在每个候选完成一次阶段探测后被调用一次。
	//
	// 用途：把真实成败喂给**网络档案**，让下一轮采样能按本机网络情况调整权重
	// （实验性能力，默认不启用）。
	//
	// ⚠️ 回调在扫描 goroutine 内同步执行，必须轻量、不能阻塞。
	// stage 取值：tcp / tls / ws；latencyMs 只在成功时有意义。
	ProbeObserver func(ip, stage string, ok bool, latencyMs int64)

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
	IP string `json:"ip"`
	// Family 是地址族：`v4` / `v6`。
	//
	// 由 IP 字面量推导（含冒号 = IPv6），不单独存族相关结论 ——
	// 备注里的 `IPv4_` / `IPv6_` 前缀也从它生成，两处永远一致。
	Family  string  `json:"family"`
	Port    int     `json:"port"`
	Colo    string  `json:"colo"`
	Latency int64   `json:"latency"`
	TLSMs   int64   `json:"tlsMs"`
	Speed   float64 `json:"speed"`
	// TCPMs 是阶段一 TCP 建连耗时（毫秒）。
	//
	// 之前没有保留这个值，导致质量报告里的「TCP 耗时」永远是「未执行」——
	// 数据其实在扫描时就拿到了，只是没带进结果条目。
	TCPMs int64 `json:"tcpMs"`
	// PeakSpeed 是阶段三测速的**窗口峰值**（MB/s），只作诊断展示。
	//
	// 对外排序仍用稳态速度（Speed）：真机实测单窗口突发能把峰值翻倍。
	PeakSpeed float64 `json:"peakSpeed,omitempty"`
	// PongVerified 是阶段二 PING/PONG 内容校验的三态结果（对照 CLI 的 pongVerified）：
	// nil = 非严格模式/无探针端点，未做校验；&true = 通过；&false = 做了但没通过。
	// 只供质量报告落库，不参与排序。
	PongVerified *bool `json:"pongVerified,omitempty"`
	// TunnelOK 是阶段二点五真实隧道校验结论：nil = 没跑（未给凭据或未测到）；
	// TunnelStage 只在失败时记录卡在哪一层（handshake / protocol / data），供诊断。
	TunnelOK    *bool  `json:"tunnelOk,omitempty"`
	TunnelStage string `json:"tunnelStage,omitempty"`
}

// Summary 是扫描结果。
type Summary struct {
	Entries []Entry        `json:"entries"`
	Stats   map[string]int `json:"stats"`
}

// filterByMinSpeed 按下行速度下限过滤候选。
//
// 保留稳态吞吐（Entry.Speed）**不低于** minSpeedMBps 的候选；
// minSpeedMBps <= 0 时原样返回（不过滤）。
//
// ## 为什么用稳态值而不是峰值
//
// PeakSpeed 是单个测量窗口的瞬时峰值，真机实测能把稳态值翻倍
// （2.46 vs 1.14 MB/s）。拿它当筛选门槛，会把「偶然冲高」的 IP
// 误当成好节点留下 —— 而用户真正在意的是能持续跑多快。
//
// 对应 CLI 的 filterByMinSpeed（packages/cli/src/scan/scan.ts），
// 两端必须对同一组输入给出相同结果。
func filterByMinSpeed(entries []Entry, minSpeedMBps float64) []Entry {
	if minSpeedMBps <= 0 {
		return entries
	}
	out := make([]Entry, 0, len(entries))
	for _, e := range entries {
		if e.Speed >= minSpeedMBps {
			out = append(out, e)
		}
	}
	return out
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
	set(&o.CoarseSpeedLimit, defCoarseSpeedLimit)
	set(&o.CoarseDurationMs, defCoarseDurationMs)
	set(&o.CoarseConnections, defCoarseConnections)
	set(&o.CoarseTimeoutMs, defCoarseTimeoutMs)
	set(&o.CoarseBudgetMs, defCoarseBudgetMs)
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
	t := strings.ToLower(strings.TrimSpace(o.ProbeTransport))
	if t != "xhttp" && t != "both" {
		t = "ws"
	}
	o.ProbeTransport = t
	if strings.TrimSpace(o.XHTTPPath) == "" {
		o.XHTTPPath = "/xhttp"
	}
	o.XHTTPPath = strings.TrimRight(o.XHTTPPath, "/")
	if o.XHTTPPath == "" {
		o.XHTTPPath = "/xhttp"
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
	// 速度下限与「跳过测速」互斥：跳过测速时速度恒为 0，
	// 任何非零下限都会把结果全部淘汰 —— 直接报错，别静默返回空。
	if opt.MinSpeedMBps > 0 && opt.SkipSpeed {
		return nil, fmt.Errorf("下行速度下限与「跳过测速」互斥：没有速度值可用于筛选")
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
	// 整轮耗时的计时起点（A/B 对照要比较两轮是否可比）。
	startedAt := time.Now()

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

	// TCP 建连耗时留档：阶段一的原始观测，质量报告要展示它。
	//
	// ⚠️ 只保留 TCP **成功**的候选 —— 失败样本的耗时是「超时时长」而不是网络延迟，
	// 混进报告会给出误导性的数字。
	tcpMsOf := make(map[string]int64, len(tcpResults))
	for _, r := range tcpResults {
		if r.OK {
			tcpMsOf[r.IP] = r.Latency
		}
		// 把阶段一的真实成败交给网络档案（实验性）。
		if opt.ProbeObserver != nil {
			opt.ProbeObserver(r.IP, "tcp", r.OK, r.Latency)
		}
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
		// 超时不重试：TLS 握手超时说明这个 IP 在当前网络下就是不可用，
		// 再试一次也是同样的结果，却要让并发槽位多占一个超时周期。
		// 只有「连接被重置」这类偶发错误才值得重试。
		r := TLSResult{}
		for attempt := 0; attempt < opt.Retries; attempt++ {
			if opt.ProbeTransport == "xhttp" {
				r = ProbeTLSWithALPN(ctx, t.IP, opt.Port, opt.Host, msDuration(opt.TLSTimeoutMs), "h2")
			} else if opt.ProbeTransport == "both" {
				h1 := ProbeTLSWithALPN(ctx, t.IP, opt.Port, opt.Host, msDuration(opt.TLSTimeoutMs), "http/1.1")
				if !h1.OK {
					r = h1
				} else {
					h2 := ProbeTLSWithALPN(ctx, t.IP, opt.Port, opt.Host, msDuration(opt.TLSTimeoutMs), "h2")
					if !h2.OK {
						r = h2
					} else {
						r = h2
						if h1.TLSMs > r.TLSMs {
							r.TLSMs = h1.TLSMs
						}
						r.ALPN = "both"
					}
				}
			} else {
				r = ProbeTLS(ctx, t.IP, opt.Port, opt.Host, msDuration(opt.TLSTimeoutMs))
			}
			if r.OK {
				if opt.ProbeObserver != nil {
					opt.ProbeObserver(r.IP, "tls", true, r.TLSMs)
				}
				return r, true
			}
			if ctx.Err() != nil {
				return r, false
			}
			if isTimeoutError(r.Error) {
				break
			}
		}
		if opt.ProbeObserver != nil {
			opt.ProbeObserver(r.IP, "tls", false, 0)
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
	// 严格模式自动降级：目标没有 CFPilot 探针端点时 PING/PONG 必然等不到响应，
	// 阶段二会全军覆没。只有**确认没有**才降级；网络错误导致结论未知时保持严格
	// （对齐 CLI command.ts 的 true/false/null 三态，避免放进一批假活 IP）。
	strictProbe := opt.VerifyPayload
	if strictProbe {
		found, known := DetectProbeEndpoint(ctx, opt.Host, opt.ProbePath, 8*time.Second)
		if known && !found {
			strictProbe = false
			stats["verifyPayloadDegraded"] = 1
			report(Progress{Stage: "probe", Message: "目标无探针端点，已自动关闭响应体校验（退回纯 101 校验）"})
		} else if !known {
			stats["verifyPayloadUnknown"] = 1
		}
	}
	if strictProbe {
		stats["verifyPayload"] = 1
	}
	transport := opt.ProbeTransport
	needWs := transport != "xhttp"
	needXhttp := transport != "ws"
	stage2Message := "阶段二：WebSocket 101 校验"
	if transport == "xhttp" {
		stage2Message = "阶段二：XHTTP 端点校验（H2/packet-up）"
	} else if transport == "both" {
		stage2Message = "阶段二：WS + XHTTP 双栈校验"
	} else if strictProbe {
		stage2Message = "阶段二：WS 101 + PING/PONG 内容校验"
	}
	report(Progress{Stage: "probe", Total: len(stage2), Message: stage2Message})

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

	// 严格模式打探针端点（ProbePath），而不是 VLESS/Trojan 入站路径：
	// 对入站路径发 PING 永远等不到响应（真机实测探针路径 16/20 通过、入站路径 0/20）。
	probePath := opt.WSPath
	if strictProbe {
		probePath = opt.ProbePath
	}
	var wsOK []WSResult
	if needWs {
		wsOK = forEachIP(ctx, stage2, opt.ProbeConcurrency, func(ip string) (WSResult, bool) {
			var last WSResult
			for attempt := 0; attempt < opt.Retries; attempt++ {
				if strictProbe {
					last = ProbeWSPing(ctx, ip, opt.Port, opt.Host, msDuration(opt.ProbeTimeoutMs), probePath)
				} else {
					last = ProbeWS101(ctx, ip, opt.Port, opt.Host, msDuration(opt.ProbeTimeoutMs), probePath)
				}
				if last.OK && strictProbe && opt.WSPath != probePath {
					pathProbe := ProbeWS101(ctx, ip, opt.Port, opt.Host, msDuration(opt.ProbeTimeoutMs), opt.WSPath)
					if !pathProbe.OK {
						last.OK = false
						last.Error = "真实 WS 路径 101 校验失败：" + pathProbe.Error
					}
				}
				if last.OK {
					if len(wantCountries) > 0 && wantCountries[strings.ToUpper(last.Colo)] {
						matchedCount++
					}
					if opt.ProbeObserver != nil {
						opt.ProbeObserver(last.IP, "ws", true, last.Latency)
					}
					return last, true
				}
				if ctx.Err() != nil {
					return last, false
				}
			}
			if opt.ProbeObserver != nil {
				opt.ProbeObserver(last.IP, "ws", false, 0)
			}
			return last, false
		}, func(done int) {
			report(Progress{Stage: "probe", Done: done, Total: len(stage2), Message: "阶段二：WebSocket 101 校验"})
		}, func() bool {
			return len(opt.Countries) > 0 && matchedCount >= earlyExitTarget
		})
		stats["wsOk"] = len(wsOK)
		if len(wsOK) == 0 && !needXhttp {
			report(Progress{Stage: "probe", Done: len(stage2), Total: len(stage2),
				Message: "阶段二全部失败：没有 IP 能完成 WebSocket 101 升级（检查 WS 路径）"})
			return &Summary{Entries: []Entry{}, Stats: stats}, nil
		}
	}
	// XHTTP 子阶段：both 在 WS 通过子集上再验，xhttp 直接在 stage2 上验。
	xhttpInput := stage2
	if needWs && needXhttp {
		xhttpInput = make([]string, 0, len(wsOK))
		for _, r := range wsOK {
			xhttpInput = append(xhttpInput, r.IP)
		}
	}
	if needXhttp {
		report(Progress{Stage: "probe", Total: len(xhttpInput), Message: "阶段二：XHTTP 端点校验（H2/packet-up）"})
		xhttpOK := forEachIP(ctx, xhttpInput, opt.ProbeConcurrency, func(ip string) (WSResult, bool) {
			var last XHTTPResult
			for attempt := 0; attempt < opt.Retries; attempt++ {
				last = ProbeXHTTP(ctx, ip, opt.Port, opt.Host, opt.XHTTPPath, msDuration(opt.ProbeTimeoutMs))
				if last.OK {
					if opt.ProbeObserver != nil {
						opt.ProbeObserver(last.IP, "xhttp", true, last.Latency)
					}
					colo := last.Colo
					// both 时优先保留 WS 的 colo（更可靠）
					if needWs {
						for _, w := range wsOK {
							if w.IP == ip {
								colo = w.Colo
								break
							}
						}
					}
					return WSResult{IP: ip, OK: true, Colo: colo, Status: last.Status, Latency: last.Latency}, true
				}
				if ctx.Err() != nil {
					return WSResult{}, false
				}
			}
			if opt.ProbeObserver != nil {
				opt.ProbeObserver(last.IP, "xhttp", false, 0)
			}
			return WSResult{}, false
		}, func(done int) {
			report(Progress{Stage: "probe", Done: done, Total: len(xhttpInput), Message: "阶段二：XHTTP 端点校验"})
		})
		stats["xhttpOk"] = len(xhttpOK)
		if needWs {
			// both：交集（XHTTP 通过的 IP 还要保留 WS 结果对象）
			keep := make(map[string]WSResult, len(xhttpOK))
			for _, r := range xhttpOK {
				keep[r.IP] = r
			}
			filtered := wsOK[:0]
			for _, r := range wsOK {
				if _, ok := keep[r.IP]; ok {
					filtered = append(filtered, r)
				}
			}
			wsOK = filtered
		} else {
			wsOK = xhttpOK
		}
	} else {
		stats["xhttpOk"] = len(wsOK)
	}
	stats["wsOk"] = len(wsOK)
	if len(wsOK) == 0 {
		report(Progress{Stage: "probe", Done: len(stage2), Total: len(stage2),
			Message: "阶段二全部失败：没有 IP 通过当前传输的校验"})
		return &Summary{Entries: []Entry{}, Stats: stats}, nil
	}

	// ---- 阶段二点五：真实隧道校验（可选）----
	//
	// 阶段二只证明「这个 IP 能把请求送到我们的数据面」；它证明不了真实 wsPath、
	// 认证配置、数据面出站是否可用 —— 这三类都会表现为「优选结果正常、
	// 导入客户端全是 -1」。只有给了真实凭据才跑（对齐 CLI scan.ts:749-784）。
	tunnelRes := make(map[string]TunnelVerifyResult)
	if needWs && (opt.UUID != "" || opt.TrojanPassword != "") {
		limit := opt.SpeedLimit
		if limit > len(wsOK) {
			limit = len(wsOK)
		}
		passed := make(map[string]bool, limit)
		failed := 0
		for _, r := range wsOK[:limit] {
			res := VerifyTunnel(ctx, TunnelVerifyOptions{
				IP: r.IP, Port: opt.Port, Host: opt.Host, WSPath: opt.WSPath,
				UUID: opt.UUID, TrojanPassword: opt.TrojanPassword,
				TargetHost: opt.VerifyTargetHost, TargetPort: opt.VerifyTargetPort,
				Timeout: msDuration(opt.ProbeTimeoutMs),
			})
			tunnelRes[r.IP] = res
			if res.OK {
				passed[r.IP] = true
			} else {
				failed++
			}
		}
		stats["tunnelTested"] = limit
		stats["tunnelFailed"] = failed
		if len(passed) > 0 {
			kept := make([]WSResult, 0, len(passed))
			for _, r := range wsOK {
				if passed[r.IP] {
					kept = append(kept, r)
				}
			}
			wsOK = kept
			stats["tunnelOk"] = len(wsOK)
		}
		// 全失败时保留阶段二结果，避免直接空结果（与 CLI 一致）
		report(Progress{Stage: "probe",
			Message: fmt.Sprintf("真实隧道校验完成（通过 %d / %d）", len(passed), limit)})
	}
	if needXhttp && opt.UUID != "" {
		limit := opt.SpeedLimit
		if limit > len(wsOK) {
			limit = len(wsOK)
		}
		passed := make(map[string]bool, limit)
		failed := 0
		for _, r := range wsOK[:limit] {
			res := VerifyXHTTPTunnel(ctx, r.IP, opt.Port, opt.Host, opt.XHTTPPath, opt.UUID, opt.VerifyTargetHost, opt.VerifyTargetPort, msDuration(opt.ProbeTimeoutMs))
			if res.OK {
				passed[r.IP] = true
			} else {
				failed++
			}
		}
		stats["xhttpTunnelTested"] = limit
		stats["xhttpTunnelFailed"] = failed
		if len(passed) > 0 {
			kept := make([]WSResult, 0, len(passed))
			for _, r := range wsOK {
				if passed[r.IP] {
					kept = append(kept, r)
				}
			}
			wsOK = kept
			stats["xhttpTunnelOk"] = len(wsOK)
		} else if limit > 0 {
			// 全失败时保留阶段二结果，避免空结果
		}
		report(Progress{Stage: "probe",
			Message: fmt.Sprintf("XHTTP 隧道校验完成（通过 %d / %d）", len(passed), limit)})
	}

	// 地区过滤（机房信息来自阶段二的 101 / XHTTP 响应）
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

	// 按 101 延迟排序后截取进入测速。
	//
	// ⚠️ 截断必须**按网段轮流**，不能直接切前 SpeedLimit 名：
	// 延迟与机房强相关（同一网段 → 同一机房 → 相近延迟），
	// 直接切会让「稍慢一点的网段」整批出局 —— 多样性在这一层就被吃掉了，
	// 后面的 PickWithDiversity 再准也无济于事。
	// 2026-11-03 实测（IPv6 侧 14 个活跃 48 位段、294 候选、120 进阶段二、
	// 80 通过）：直接切时最终结果只剩 4 个段、其中一个段独占 12/30。
	sort.Slice(wsFiltered, func(i, j int) bool {
		return wsFiltered[i].Latency < wsFiltered[j].Latency
	})
	stage3 := wsFiltered
	if opt.TwoStageSpeed && !opt.SkipSpeed {
		// 两轮测速：先给全部 101 通过候选做短测粗排，再对粗排前 SpeedLimit 个精测。
		// 关闭时（默认零值）完全走上面的旧路径，行为逐字节不变。
		stage3 = coarsePreRank(ctx, opt, wsFiltered, report)
		stats["coarseTested"] = min(len(wsFiltered), opt.CoarseSpeedLimit)
	} else if len(stage3) > opt.SpeedLimit {
		stage3 = pickWSDiverse(wsFiltered, opt.SpeedLimit)
	}
	stats["stage3Input"] = len(stage3)

	// attachEvidence 把阶段二 PONG 与阶段二点五隧道结论带进条目（仅供质量报告落库）。
	// 未做校验的保持 nil，报告里显示「未执行」，绝不伪装通过。
	attachEvidence := func(e *Entry, r WSResult) {
		e.PongVerified = r.PongVerified
		if tr, ok := tunnelRes[r.IP]; ok {
			tunnelOK := tr.OK
			e.TunnelOK = &tunnelOK
			if !tr.OK {
				e.TunnelStage = tr.Stage
			}
		}
	}

	// ================= 阶段三：真实下行测速 =================
	//
	// SkipSpeed 时不做测速，直接把 101 通过的候选当作结果
	// （速度记 0，排序退化为按 101 延迟）。
	if opt.SkipSpeed {
		report(Progress{Stage: "speed", Total: len(stage3), Message: "阶段三：跳过测速（按延迟排序）"})
		entries := make([]Entry, 0, len(stage3))
		for _, r := range stage3 {
			e := Entry{
				IP:      r.IP,
				Family:  FamilyOf(r.IP),
				Port:    opt.Port,
				Colo:    r.Colo,
				Latency: r.Latency,
				TLSMs:   tlsMsOf[r.IP],
				Speed:   0,
				TCPMs:   tcpMsOf[r.IP],
			}
			attachEvidence(&e, r)
			entries = append(entries, e)
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
		e := Entry{
			IP:      sr.ws.IP,
			Family:  FamilyOf(sr.ws.IP),
			Port:    opt.Port,
			Colo:    sr.ws.Colo,
			Latency: sr.ws.Latency,
			TLSMs:   tlsMsOf[sr.ws.IP],
			// ⚠️ 对外报**稳态值**，不是窗口峰值（峰值只作诊断）。
			Speed: sr.dl.SteadyMBps,
			// 峰值留档给质量报告展示，不参与排序。
			PeakSpeed: sr.dl.PeakMBps,
			TCPMs:     tcpMsOf[sr.ws.IP],
		}
		attachEvidence(&e, sr.ws)
		entries = append(entries, e)
	}

	// 按速度降序，速度相同按延迟升序
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Speed != entries[j].Speed {
			return entries[i].Speed > entries[j].Speed
		}
		return entries[i].Latency < entries[j].Latency
	})
	// 下行速度下限过滤（0 = 不过滤）。
	//
	// 放在 PickWithDiversity **之前**：被淘汰的候选本可以补位，
	// 放在之后会得到不足 Top 条的结果。
	//
	// 判据是 Speed（稳态吞吐），不是峰值 —— 单窗口突发能把峰值翻倍，
	// 用它当门槛会把偶然冲高的 IP 当成好节点留下。
	entries = filterByMinSpeed(entries, opt.MinSpeedMBps)
	// 取前 N 时按 /16 轮流取（对照 CLI 的 pickWithDiversity）
	entries = PickWithDiversity(entries, opt.Top)

	stats["speedOk"] = len(speedResults)
	stats["final"] = len(entries)
	// 候选总数与整轮耗时：A/B 对照要靠它们判断两轮是否可比。
	stats["candidates"] = len(opt.Candidates)
	stats["elapsedMs"] = int(time.Since(startedAt).Milliseconds())

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

// PickWithDiversity 分族取前 top 条，并在**族内**按网段轮流，保证结果覆盖多个网段。
//
// ## 为什么必须分族（对照 CLI packages/cli/src/scan/scan.ts 的 pickWithDiversity）
//
// 不同地址族的成绩不能直接混排 —— v4 与 v6 走的是不同路径，
// 按速度混在一起取前 N 会让某一族被完全挤掉
// （实测 v4 通常更快，混排的结果就是 v6 一条都留不下）。
// 两族都有时各取 round(top/2)；一族为空则另一族拿满。
//
// ## 族内的网段分散
//
// IPv4 按**前两段**（/16）轮流：Cloudflare 的好 IP 高度集中在少数 /16
// （实测 104.16–104.19 占了大半），直接切前 N 名经常得到「同一个 /16 的 N 个 IP」，
// 它们走同一段路由、同一个入口，一旦那段拥塞或被 QoS，整批节点同时劣化。
//
// IPv6 按 **48 位前缀**轮流 —— 实测同一 /48 内的地址等价（同机房），
// 而不同 /48 落在不同机房（`2606:4700:3035`→AMS、`2606:4700:10`→FRA、
// `2a06:98c1:3100`→SIN），不分散就会整批挤在一个机房。
//
// 轮流取（每轮从每个网段取当前最好的一条）既保住速度排序，又保证网段覆盖；
// 桶内仍保持传入顺序（即速度降序）。只有一个网段时与直接截取完全一致。
func PickWithDiversity(entries []Entry, top int) []Entry {
	if top <= 0 {
		return nil
	}
	if len(entries) <= top {
		return entries
	}
	v4 := make([]Entry, 0, len(entries))
	v6 := make([]Entry, 0, len(entries))
	for _, e := range entries {
		if isIPv6Literal(e.IP) {
			v6 = append(v6, e)
		} else {
			v4 = append(v4, e)
		}
	}
	keyOf := func(e Entry) string { return entryBucketKey(e.IP) }
	switch {
	case len(v4) == 0:
		return roundRobinBy(v6, top, keyOf)
	case len(v6) == 0:
		return roundRobinBy(v4, top, keyOf)
	}
	half := (top + 1) / 2 // 与 CLI 的 Math.round(top/2) 一致
	return append(roundRobinBy(v4, half, keyOf), roundRobinBy(v6, half, keyOf)...)
}

// selectForFineTest 按粗测速度挑出进入精测的候选（纯逻辑，便于单测）。
// 对照 CLI packages/cli/src/scan/scan.ts 的 rankByCoarseSpeed。
//
// 语义：
//  1. 有粗测速度的按速度降序；未测 / 粗测失败记 0，排在后面
//     （SliceStable 保证同速时保留阶段二的 101 延迟顺序）；
//  2. 排序后仍走 pickWSDiverse 按网段轮流取，避免某一 /16 独占；
//  3. 粗测全失败时自动退化为旧的「延迟序 + 网段轮流」，不会产出空结果。
func selectForFineTest(items []WSResult, coarse map[string]float64, limit int) []WSResult {
	sort.SliceStable(items, func(i, j int) bool {
		return coarse[items[i].IP] > coarse[items[j].IP]
	})
	// 与 CLI 的 rankByCoarseSpeed 一致：候选不足上限时整批返回，
	// 不进 pickWSDiverse（它会按网段轮流，把顺序排成与 CLI 不同的样子）。
	if len(items) <= limit {
		return items
	}
	return pickWSDiverse(items, limit)
}

// coarsePreRank 是两轮测速的第一轮：对全部 101 通过候选做短测粗排。
// 对照 CLI 的 coarsePreRank。
//
// ⚠️ 三点硬约束：
//   - 串行（带宽共享，并行粗测会互相抢，相对排序同样失真）；
//   - 候选上限 + 阶段总预算双保险，带地区筛选时阶段二会放大到 500 个；
//   - 粗测数值只进排序 Map，**绝不写进 Entry.Speed**，对外速度仍来自精测。
func coarsePreRank(ctx context.Context, opt Options, candidates []WSResult, report func(Progress)) []WSResult {
	pool := candidates
	if len(pool) > opt.CoarseSpeedLimit {
		pool = pickWSDiverse(pool, opt.CoarseSpeedLimit)
	}
	// 文案里不要自带（x/y）：server 的 Progress → SSE 日志会统一附加计数。
	report(Progress{Stage: "coarse", Total: len(pool), Message: "全量粗筛：短测粗排"})

	coarseCtx, cancel := context.WithTimeout(ctx, msDuration(opt.CoarseBudgetMs))
	defer cancel()

	speeds := make(map[string]float64, len(pool))
	// concurrency=1 串行，fn 与 onProgress 在同一个 worker goroutine 内，无需加锁。
	measured := 0
	forEachIP(coarseCtx, pool, 1, func(r WSResult) (struct{}, bool) {
		if coarseCtx.Err() != nil {
			return struct{}{}, false
		}
		dl := MeasureThroughput(coarseCtx, MeasureOptions{
			IP:          r.IP,
			Port:        opt.Port,
			Host:        opt.Host,
			BytesWanted: defMeasureBytes,
			Path:        opt.ProbePath,
			Connections: opt.CoarseConnections,
			Duration:    msDuration(opt.CoarseDurationMs),
			Warmup:      msDuration(defCoarseWarmupMs),
			Window:      msDuration(defCoarseWindowMs),
			Timeout:     msDuration(opt.CoarseTimeoutMs),
		})
		measured++
		if dl.OK {
			speeds[r.IP] = dl.SteadyMBps
		}
		return struct{}{}, true
	}, func(done int) {
		report(Progress{Stage: "coarse", Done: done, Total: len(pool),
			Message: "全量粗筛 · 短测"})
	})
	if coarseCtx.Err() != nil {
		report(Progress{Stage: "coarse", Done: measured, Total: len(pool),
			Message: fmt.Sprintf("粗筛已达总预算 %ds，剩余 %d 个按延迟兜底",
				opt.CoarseBudgetMs/1000, len(pool)-measured)})
	}
	return selectForFineTest(candidates, speeds, opt.SpeedLimit)
}

// pickWSDiverse 对阶段二候选做同样的「分族 + 族内网段轮流」截断。
//
// 用在「101 通过 → 进入测速」这一刀上：延迟与机房强相关
// （同一网段 → 同一机房 → 相近延迟），直接切前 N 名会让稍慢的网段整批出局。
// 对照 CLI scan.ts 里对 stage2 的 pickWithDiversity 截断。
func pickWSDiverse(items []WSResult, top int) []WSResult {
	if top <= 0 || len(items) == 0 {
		return nil
	}
	if len(items) <= top {
		return items
	}
	v4 := make([]WSResult, 0, len(items))
	v6 := make([]WSResult, 0, len(items))
	for _, r := range items {
		if isIPv6Literal(r.IP) {
			v6 = append(v6, r)
		} else {
			v4 = append(v4, r)
		}
	}
	keyOf := func(r WSResult) string { return entryBucketKey(r.IP) }
	switch {
	case len(v4) == 0:
		return roundRobinBy(v6, top, keyOf)
	case len(v6) == 0:
		return roundRobinBy(v4, top, keyOf)
	}
	half := (top + 1) / 2
	return append(roundRobinBy(v4, half, keyOf), roundRobinBy(v6, half, keyOf)...)
}

// roundRobinBy 按给定分桶键轮流取前 top 条（桶内保持原顺序）。
func roundRobinBy[T any](items []T, top int, keyOf func(T) string) []T {
	if top <= 0 || len(items) == 0 {
		return nil
	}
	order := make([]string, 0, len(items))
	buckets := make(map[string][]T, len(items))
	for _, item := range items {
		key := keyOf(item)
		if _, ok := buckets[key]; !ok {
			order = append(order, key)
		}
		buckets[key] = append(buckets[key], item)
	}
	if len(order) <= 1 {
		if top >= len(items) {
			return items
		}
		return items[:top]
	}

	out := make([]T, 0, top)
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

// entryBucketKey 结果条目的分桶键：IPv4 → 前两段（/16），IPv6 → 48 位前缀。
func entryBucketKey(ip string) string {
	if isIPv6Literal(ip) {
		return IPv6Prefix48(ip)
	}
	return ipv4Prefix16(ip)
}

// isIPv6Literal 判断字面量是否为 IPv6（与 CLI 的 ip.includes(':') 同口径）。
func isIPv6Literal(s string) bool { return strings.Contains(s, ":") }

// ipv4Prefix16 取 IPv4 的前两段作为分桶键（如 104.16）。
// IPv6 或格式异常时退回整串（等价于不参与多样性分桶）。
func ipv4Prefix16(ip string) string {
	parts := strings.Split(ip, ".")
	if len(parts) != 4 {
		return ip
	}
	return parts[0] + "." + parts[1]
}
