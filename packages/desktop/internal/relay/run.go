package relay

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// RunOptions 是一次批量体检的参数。
type RunOptions struct {
	/** 数据面域名 */
	Host string
	/** 数据面的 WebSocket 路径 */
	WSPath string
	/** VLESS UUID */
	UUID string
	/** 轮数（每轮把全部候选重测一次，用成功率抗抖动），默认 2 */
	Rounds int
	/** 备选条数（写入池 / 输出的上限），默认 10 */
	Top int
	/** 单候选超时，默认 DefaultTimeout */
	Timeout time.Duration
	/** 并发，默认 DefaultConcurrency */
	Concurrency int
	/** 候选 IPv4 列表 */
	Candidates []string
	/** 数据面 build；留空则自动拉取 */
	ExpectedBuild string
	/**
	 * 校验网址（Cloudflare 网段站点）：终检候选能否转发到 CF 边缘。
	 *
	 * 留空 = 不做终检。已由调用方完成「剔除非 CF 网段网址」
	 * （relay.resolveVerifyHosts），这里拿到的是最终列表。
	 */
	VerifyHosts []string
	/** 进度回调（每完成一个候选调一次），可为空 */
	OnProgress func(done, total int, ip string, ok bool)
}

// Aggregate 是单个候选的多轮汇总。
type Aggregate struct {
	IP         string `json:"ip"`
	Rounds     int    `json:"rounds"`
	Passed     int    `json:"passed"`
	SuccessPct int    `json:"successPct"`
	TunnelMs   int64  `json:"tunnelMs"`
	TLSMs      int64  `json:"tlsMs"`
	TLSP95     int64  `json:"tlsP95"`
	HTTPMs     int64  `json:"httpMs"`
	// VerifyOK 是「校验网址终检」结论；nil = 未执行终检（没配校验网址）。
	// false = 候选能转发到数据面、却转发不了 CF 网段站点（假入口），已剔除。
	VerifyOK *bool    `json:"verifyOk,omitempty"`
	Errors   []string `json:"errors"`
}

// Summary 是一次批量体检的完整结果。
type Summary struct {
	GeneratedAt   time.Time
	ExpectedBuild string
	Aggregates    []Aggregate
	AlwaysOK      int
	NeverOK       int
	Flaky         int
}

// Picked 取「全通」的前 n 条 IP（已按质量排序）。
//
// 池子不是越大越好：每条都要参与 Worker 的出站拨号竞速，
// 塞几百条反而拖慢选路。
//
// 校验网址终检失败的候选（VerifyOK=false）不进池 ——
// 它们转发不了 CF 网段站点，进池反而让 Worker 出站走到坏入口。
func (s *Summary) Picked(top int) []string {
	if top <= 0 {
		top = 10
	}
	out := make([]string, 0, top)
	for _, a := range s.Aggregates {
		if a.SuccessPct != 100 {
			continue
		}
		if a.VerifyOK != nil && !*a.VerifyOK {
			continue
		}
		out = append(out, a.IP)
		if len(out) >= top {
			break
		}
	}
	return out
}

// Run 对全部候选跑 rounds 轮并汇总。
func Run(ctx context.Context, opt RunOptions) (*Summary, error) {
	if opt.Host == "" || opt.WSPath == "" || opt.UUID == "" {
		return nil, errors.New("缺少数据面域名 / WS 路径 / UUID")
	}
	if len(opt.Candidates) == 0 {
		return nil, errors.New("候选列表为空")
	}
	rounds := opt.Rounds
	if rounds <= 0 {
		rounds = 2
	}
	concurrency := opt.Concurrency
	if concurrency <= 0 {
		concurrency = DefaultConcurrency
	}
	timeout := opt.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}

	expected := opt.ExpectedBuild
	if expected == "" {
		got, err := FetchExpectedBuild(ctx, opt.Host, timeout)
		if err != nil {
			return nil, err
		}
		expected = got
	}

	probeOpt := Options{
		Host:          opt.Host,
		WSPath:        opt.WSPath,
		UUID:          opt.UUID,
		ExpectedBuild: expected,
		Timeout:       timeout,
	}

	type bucket struct {
		results []Result
	}
	buckets := make(map[string]*bucket, len(opt.Candidates))
	order := make([]string, 0, len(opt.Candidates))
	for _, ip := range opt.Candidates {
		if _, ok := buckets[ip]; ok {
			continue
		}
		buckets[ip] = &bucket{}
		order = append(order, ip)
	}

	total := len(order) * rounds
	done := 0
	var mu sync.Mutex

	jobs := make([]string, 0, total)
	for r := 0; r < rounds; r++ {
		jobs = append(jobs, order...)
	}

	index := 0
	worker := func() {
		for {
			mu.Lock()
			i := index
			index++
			mu.Unlock()
			if i >= len(jobs) {
				return
			}
			ip := jobs[i]
			result := Probe(ctx, probeOpt, ip)

			mu.Lock()
			buckets[ip].results = append(buckets[ip].results, result)
			done++
			current := done
			mu.Unlock()

			if opt.OnProgress != nil {
				opt.OnProgress(current, total, ip, result.BuildOK)
			}
		}
	}

	var wg sync.WaitGroup
	workers := concurrency
	if workers > len(jobs) {
		workers = len(jobs)
	}
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			worker()
		}()
	}
	wg.Wait()

	if ctx.Err() != nil && !errors.Is(ctx.Err(), context.Canceled) {
		return nil, ctx.Err()
	}

	summary := &Summary{GeneratedAt: time.Now(), ExpectedBuild: expected}
	for _, ip := range order {
		summary.Aggregates = append(summary.Aggregates, aggregate(ip, buckets[ip].results))
	}
	// 成功率是硬门槛，其次看 TLS 尾部（P95），再看中位
	sort.SliceStable(summary.Aggregates, func(i, j int) bool {
		a, b := summary.Aggregates[i], summary.Aggregates[j]
		if a.SuccessPct != b.SuccessPct {
			return a.SuccessPct > b.SuccessPct
		}
		if a.TLSP95 != b.TLSP95 {
			return a.TLSP95 < b.TLSP95
		}
		return a.TLSMs < b.TLSMs
	})

	// ---- 校验网址终检 ----
	//
	// 只对「多轮全通」的候选做（候选全通的量级有限，成本可控）：
	// 逐个建独立隧道，实测「能不能把流量转到 CF 网段站点」。
	// 任一网址转发成功即通过；全部失败 = 假入口，从池里剔除。
	if len(opt.VerifyHosts) > 0 {
		var toVerify []int
		for i, a := range summary.Aggregates {
			if a.SuccessPct == 100 {
				toVerify = append(toVerify, i)
			}
		}
		if len(toVerify) > 0 {
			totalVerify := len(toVerify)
			verifyDone := 0
			var vmu sync.Mutex
			vIdx := 0
			vWorker := func() {
				for {
					vmu.Lock()
					k := vIdx
					vIdx++
					vmu.Unlock()
					if k >= len(toVerify) {
						return
					}
					i := toVerify[k]
					ip := summary.Aggregates[i].IP

					passed := false
					var firstErr error
					for _, host := range opt.VerifyHosts {
						if ctx.Err() != nil {
							break
						}
						ok, err := verifyForwarding(ctx, probeOpt, ip, host)
						if ok {
							passed = true
							break
						}
						if firstErr == nil {
							firstErr = err
						}
					}

					vmu.Lock()
					verifyDone++
					current := verifyDone
					vmu.Unlock()

					mu.Lock()
					summary.Aggregates[i].VerifyOK = &passed
					if !passed && firstErr != nil {
						summary.Aggregates[i].Errors = append(summary.Aggregates[i].Errors,
							"校验网址失败："+shortErr(firstErr))
					}
					mu.Unlock()

					if opt.OnProgress != nil {
						// 终检进度接在主循环之后，进度条连续推进不回退
						opt.OnProgress(total+current, total+totalVerify, ip, passed)
					}
				}
			}
			var vWg sync.WaitGroup
			vWorkers := concurrency
			if vWorkers > len(toVerify) {
				vWorkers = len(toVerify)
			}
			for w := 0; w < vWorkers; w++ {
				vWg.Add(1)
				go func() {
					defer vWg.Done()
					vWorker()
				}()
			}
			vWg.Wait()
		}
	}

	for _, a := range summary.Aggregates {
		switch a.SuccessPct {
		case 100:
			summary.AlwaysOK++
		case 0:
			summary.NeverOK++
		default:
			summary.Flaky++
		}
	}
	return summary, nil
}

// aggregate 把多轮结果压成一行。
func aggregate(ip string, results []Result) Aggregate {
	out := Aggregate{IP: ip, Rounds: len(results)}
	var tlsValues []int64
	var tunnelValues []int64
	var httpValues []int64
	seenErr := make(map[string]bool)

	for _, r := range results {
		if r.BuildOK {
			out.Passed++
		}
		if r.TLSMs > 0 {
			tlsValues = append(tlsValues, r.TLSMs)
		}
		if r.TunnelMs > 0 && r.BuildOK {
			tunnelValues = append(tunnelValues, r.TunnelMs)
		}
		if r.HTTPMs > 0 && r.BuildOK {
			httpValues = append(httpValues, r.HTTPMs)
		}
		if !r.BuildOK && r.Error != "" && !seenErr[r.Error] {
			seenErr[r.Error] = true
			if len(out.Errors) < 2 {
				out.Errors = append(out.Errors, r.Error)
			}
		}
	}
	if len(results) > 0 {
		out.SuccessPct = int(float64(out.Passed) / float64(len(results)) * 100)
	}
	out.TLSMs = median(tlsValues)
	out.TLSP95 = percentile(tlsValues, 95)
	out.TunnelMs = median(tunnelValues)
	out.HTTPMs = median(httpValues)
	return out
}

func median(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]int64(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	mid := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[mid]
	}
	return (sorted[mid-1] + sorted[mid]) / 2
}

func percentile(values []int64, p int) int64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]int64(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	idx := (p*len(sorted) + 99) / 100
	if idx < 1 {
		idx = 1
	}
	if idx > len(sorted) {
		idx = len(sorted)
	}
	return sorted[idx-1]
}

// FormatError 把错误列表压成一行（给界面与日志用）。
func FormatError(errs []string) string {
	if len(errs) == 0 {
		return ""
	}
	if len(errs) == 1 {
		return errs[0]
	}
	return fmt.Sprintf("%s 等 %d 类", errs[0], len(errs))
}
