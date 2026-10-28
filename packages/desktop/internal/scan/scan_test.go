package scan

// 探针与扫描器的测试。
//
// ## 测试策略
//
// 探针依赖真实网络，不能直接测「连 Cloudflare 快不快」。
// 这里用 **本地 TLS 服务器** 模拟各种情形：
//
//   - 返回 101 的（正常节点）
//   - 返回 200 的（路径上没有 WS 处理器）
//   - 返回 403 的（被风控）
//   - 带 cf-ray 头（验证机房提取）
//   - 慢响应 / 半途断开（验证超时与异常处理）
//
// 这样能覆盖全部判定分支，而且不依赖外网。

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// ------------------------------------------------------------------
// 测试用 TLS 服务器
// ------------------------------------------------------------------

// testServer 是一个本地 TLS 服务器，handler 决定返回什么。
type testServer struct {
	Addr string
	Port int
	stop func()
}

// newTLSServer 起一个自签证书的 TLS 服务器。
func newTLSServer(t *testing.T, handler http.Handler) *testServer {
	t.Helper()

	cert := selfSignedCert(t)

	// 用原始 TCP 监听 + tls.NewListener，便于控制 ALPN
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	tlsLn := tls.NewListener(ln, &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"http/1.1"},
		MinVersion:   tls.VersionTLS12,
	})

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		// 测速默认开 3 条连接，收满字节后会立刻关闭其余连接 ——
		// 服务端看到的是「TLS 握手期间 EOF」，属预期行为，别刷测试输出。
		ErrorLog: log.New(io.Discard, "", 0),
	}
	go func() { _ = srv.Serve(tlsLn) }()

	addr := ln.Addr().(*net.TCPAddr)
	return &testServer{
		Addr: addr.IP.String(),
		Port: addr.Port,
		stop: func() { _ = srv.Close() },
	}
}

// selfSignedCert 生成测试用自签证书。
func selfSignedCert(t *testing.T) tls.Certificate {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "cfpilot-test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		DNSNames:              []string{"test.example.com"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// ------------------------------------------------------------------
// 探针测试
// ------------------------------------------------------------------

// 返回 101 的服务器应判定为可用，并能提取机房。
func TestProbeWS101Success(t *testing.T) {
	srv := newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 检查这是不是一个合法的 WS 升级请求
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			t.Errorf("缺少 Upgrade 头")
		}
		if r.Header.Get("Sec-WebSocket-Key") == "" {
			t.Errorf("缺少 Sec-WebSocket-Key")
		}
		if r.Host != "test.example.com" {
			t.Errorf("Host 应为 test.example.com，实际 %q", r.Host)
		}

		// ⚠️ 延迟 5ms 再回 101。
		//
		// 探针的延迟是 `time.Since(start).Milliseconds()`（整毫秒），
		// 而回环地址的 TLS 握手 + 101 交换常常**不足 1 毫秒** →
		// 延迟被截断成 0 → 下面的 `Latency > 0` 断言随机失败。
		//
		// 这是**测试的缺陷**而非生产代码的问题：真机网络延迟是 10~200ms，
		// 毫秒粒度足够；CLI 版用 Date.now() 差值，粒度相同、语义一致。
		// 这里加一点延迟把测试变成确定性的。
		time.Sleep(5 * time.Millisecond)

		// 伪造 101 响应
		w.Header().Set("Cf-Ray", "8a1b2c3d4e5f-NRT")
		w.Header().Set("Upgrade", "websocket")
		w.Header().Set("Connection", "Upgrade")
		w.WriteHeader(http.StatusSwitchingProtocols)
	}))
	defer srv.stop()

	res := ProbeWS101(context.Background(), srv.Addr, srv.Port, "test.example.com",
		3*time.Second, "/__edge_probe")

	if !res.OK {
		t.Fatalf("应判定成功，实际 error=%q status=%d", res.Error, res.Status)
	}
	if res.Status != 101 {
		t.Errorf("状态应为 101，实际 %d", res.Status)
	}
	if res.Colo != "NRT" {
		t.Errorf("机房应为 NRT，实际 %q", res.Colo)
	}
	if res.Latency <= 0 {
		t.Errorf("延迟应大于 0，实际 %d", res.Latency)
	}
}

// 返回 200（路径上没有 WS 处理器）必须判失败 ——
// 这是「速度很快但导入客户端全是 -1」的典型来源。
func TestProbeWS101Rejects200(t *testing.T) {
	srv := newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("hello"))
	}))
	defer srv.stop()

	res := ProbeWS101(context.Background(), srv.Addr, srv.Port, "test.example.com",
		3*time.Second, "/__edge_probe")

	if res.OK {
		t.Fatal("HTTP 200 不能判定为可用节点")
	}
	if res.Status != 200 {
		t.Errorf("应记录状态 200，实际 %d", res.Status)
	}
	if !strings.Contains(res.Error, "HTTP 200") {
		t.Errorf("错误信息应含状态码，实际 %q", res.Error)
	}
}

// 403（被风控）也要判失败，并保留机房信息（便于报告）。
func TestProbeWS101Rejects403(t *testing.T) {
	srv := newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cf-Ray", "ffffff-SIN")
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.stop()

	res := ProbeWS101(context.Background(), srv.Addr, srv.Port, "test.example.com",
		3*time.Second, "/__edge_probe")

	if res.OK {
		t.Fatal("403 不能判定为可用")
	}
	if res.Colo != "SIN" {
		t.Errorf("即使失败也应提取机房，实际 %q", res.Colo)
	}
}

// 连不上的地址判失败，且错误简短可读。
func TestProbeWS101ConnRefused(t *testing.T) {
	// 找一个大概率没人监听的端口
	res := ProbeWS101(context.Background(), "127.0.0.1", 1, "test.example.com",
		500*time.Millisecond, "/__edge_probe")

	if res.OK {
		t.Fatal("连不上不该判成功")
	}
	if res.Error == "" {
		t.Error("应给出错误原因")
	}
	if len(res.Error) > 40 {
		t.Errorf("错误信息应简短，实际 %q", res.Error)
	}
}

// TLS 握手成功且 ALPN 是 http/1.1 → 通过。
func TestProbeTLSSuccess(t *testing.T) {
	srv := newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.stop()

	res := ProbeTLS(context.Background(), srv.Addr, srv.Port, "test.example.com", 3*time.Second)

	if !res.OK {
		t.Fatalf("TLS 握手应成功，实际 error=%q", res.Error)
	}
	// 本地回环握手可能不足 1ms，取整后为 0 —— 不能断言 > 0
	if res.TLSMs < 0 {
		t.Errorf("握手耗时不该为负，实际 %d", res.TLSMs)
	}
	if res.ALPN != "http/1.1" {
		t.Errorf("ALPN 应为 http/1.1，实际 %q", res.ALPN)
	}
}

// 连不上时 TLS 探测也失败。
func TestProbeTLSConnRefused(t *testing.T) {
	res := ProbeTLS(context.Background(), "127.0.0.1", 1, "test.example.com", 500*time.Millisecond)
	if res.OK {
		t.Fatal("连不上不该判成功")
	}
}

// TCP 探测：能连上 → OK；连不上 → 失败。
func TestProbeTCP(t *testing.T) {
	srv := newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.stop()

	ok := ProbeTCP(context.Background(), srv.Addr, srv.Port, time.Second)
	if !ok.OK {
		t.Fatalf("应能建连，实际 %q", ok.Error)
	}

	bad := ProbeTCP(context.Background(), "127.0.0.1", 1, 500*time.Millisecond)
	if bad.OK {
		t.Error("连不上不该判成功")
	}
}

// 测速：能拿到数据即成功，并算出速度。
//
// 口径已对齐 CLI：多连接（默认 3）+ 丢预热后的**稳态吞吐**。
// 服务端必须回 `x-probe-bytes`，否则会被判成「不是探针端点」。
func TestMeasureDownload(t *testing.T) {
	payload := strings.Repeat("x", 64*1024)
	srv := newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 必须声明 Content-Length：否则 http.Server 会保持连接，
		// 客户端只能等到 deadline 才知道「数据发完了」（测试会白等十几秒）。
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		// 探针端点独有标记（新口径必校验）：少了它会被判成 Pages 欢迎页。
		w.Header().Set("X-Probe-Bytes", strconv.Itoa(len(payload)))
		_, _ = w.Write([]byte(payload))
	}))
	defer srv.stop()

	res := MeasureDownload(context.Background(), srv.Addr, srv.Port, "test.example.com",
		64*1024, 5*time.Second, "/__edge_probe")

	if !res.OK {
		t.Fatalf("测速应成功，实际 error=%q bytes=%d", res.Error, res.Bytes)
	}
	if res.Bytes < 64*1024 {
		t.Errorf("应收到至少 64KB，实际 %d", res.Bytes)
	}
	// 对外口径是稳态值；旧字段 SpeedMBps 必须等于它（防止调用方漏改）。
	if res.SteadyMBps <= 0 {
		t.Errorf("稳态速度应大于 0，实际 %f", res.SteadyMBps)
	}
	if res.SpeedMBps != res.SteadyMBps {
		t.Errorf("SpeedMBps 必须等于 SteadyMBps（兼容字段），实际 %f vs %f",
			res.SpeedMBps, res.SteadyMBps)
	}
	if res.Connections < 1 {
		t.Errorf("至少应有 1 条连接完成握手，实际 %d", res.Connections)
	}
}

// 只返回响应头没有 body → 测速失败。
//
// 这正是「connect 成功但收不到数据」的模拟。
func TestMeasureDownloadEmptyBody(t *testing.T) {
	srv := newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 带探针标记，确保失败原因是「没有载荷」而不是「响应头不匹配」。
		w.Header().Set("X-Probe-Bytes", "16384")
		w.WriteHeader(http.StatusOK)
		// 不写任何 body
	}))
	defer srv.stop()

	res := MeasureDownload(context.Background(), srv.Addr, srv.Port, "test.example.com",
		16*1024, 1500*time.Millisecond, "/__edge_probe")

	if res.OK {
		t.Errorf("没有 body 不该判成功（这正是「假活」的来源），bytes=%d", res.Bytes)
	}
	if res.Bytes != 0 {
		t.Errorf("没有 body 时不应收到负载字节，实际 %d", res.Bytes)
	}
	if res.Error == "" {
		t.Error("应给出可读的失败原因")
	}
}

// ------------------------------------------------------------------
// 扫描器测试
// ------------------------------------------------------------------

// 端到端：一个正常服务器 + 一个不通的地址，只应保留正常的。
func TestRunEndToEnd(t *testing.T) {
	payload := strings.Repeat("y", 32*1024)
	srv := newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 探测路径：101 + 带机房
		if strings.HasPrefix(r.URL.Path, "/__edge_probe") && r.URL.Query().Get("bytes") == "" {
			w.Header().Set("Cf-Ray", "abc123-HKG")
			w.Header().Set("Upgrade", "websocket")
			w.Header().Set("Connection", "Upgrade")
			w.WriteHeader(http.StatusSwitchingProtocols)
			return
		}
		// 测速路径
		// 必须声明 Content-Length：否则 http.Server 会保持连接，
		// 客户端只能等到 deadline 才知道「数据发完了」（测试会白等十几秒）。
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		// 新口径会校验探针标记，缺了它测速必失败（阶段三会跳过这个候选）。
		w.Header().Set("X-Probe-Bytes", strconv.Itoa(len(payload)))
		_, _ = w.Write([]byte(payload))
	}))
	defer srv.stop()

	var stages []string
	sum, err := Run(context.Background(), Options{
		Host:       "test.example.com",
		Port:       srv.Port,
		Candidates: []string{srv.Addr, "127.0.0.2"},
		WSPath:     "/__edge_probe",
		Top:        10,
		// 测试服务器只回 32KB，把要求的数据量与超时都调小，
		// 否则会按默认 5MB / 12s 白等到超时（不是缺陷，是测试参数不合适）
		SpeedBytes:     32 * 1024,
		SpeedTimeoutMs: 2000,
		Progress: func(p Progress) {
			if len(stages) == 0 || stages[len(stages)-1] != p.Stage {
				stages = append(stages, p.Stage)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// 阶段顺序必须是 tcp → tls → probe → speed
	want := []string{"tcp", "tls", "probe", "speed"}
	for i, s := range want {
		if i >= len(stages) || stages[i] != s {
			t.Errorf("阶段顺序应为 %v，实际 %v", want, stages)
			break
		}
	}

	if len(sum.Entries) != 1 {
		t.Fatalf("应只有 1 个可用节点，实际 %d（stats=%v）", len(sum.Entries), sum.Stats)
	}
	e := sum.Entries[0]
	if e.IP != srv.Addr {
		t.Errorf("IP 不对：%q", e.IP)
	}
	if e.Colo != "HKG" {
		t.Errorf("机房应为 HKG，实际 %q", e.Colo)
	}
	if e.Speed <= 0 {
		t.Errorf("速度应大于 0，实际 %f", e.Speed)
	}
	// TLS 耗时可能为 0：本地回环握手常常不足 1ms，取整后就是 0。
	// CI 的 Linux runner 上尤其明显（实测每次都 0）。
	// 这里只断言「不为负」，因为 0 是合法值。
	if e.TLSMs < 0 {
		t.Errorf("TLS 耗时不应为负，实际 %d", e.TLSMs)
	}
}

// 缺域名要报错（优选必须知道用哪个域名做 SNI）。
func TestRunRequiresHost(t *testing.T) {
	_, err := Run(context.Background(), Options{Candidates: []string{"1.2.3.4"}})
	if err == nil {
		t.Fatal("缺域名应报错")
	}
	if !strings.Contains(err.Error(), "域名") {
		t.Errorf("错误信息应提到域名，实际 %v", err)
	}
}

// 候选为空要报错。
func TestRunRequiresCandidates(t *testing.T) {
	_, err := Run(context.Background(), Options{Host: "x.com"})
	if err == nil {
		t.Fatal("候选为空应报错")
	}
}

// 全部候选不通时返回空结果（不报错）。
func TestRunAllFail(t *testing.T) {
	sum, err := Run(context.Background(), Options{
		Host:         "test.example.com",
		Candidates:   []string{"127.0.0.1", "127.0.0.2"},
		Port:         1, // 没人监听
		TCPTimeoutMs: 300,
		Retries:      1,
	})
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if len(sum.Entries) != 0 {
		t.Errorf("应无结果，实际 %d", len(sum.Entries))
	}
	if sum.Stats["tcpOk"] != 0 {
		t.Errorf("tcpOk 应为 0，实际 %d", sum.Stats["tcpOk"])
	}
}

// 地区筛选：匹配时只保留该地区。
func TestRunCountryFilter(t *testing.T) {
	// ⚠️ 载荷必须 ≥32KB：新口径（对照 CLI）固定要求 32KB 才算拿到真二进制流，
	// 与 SpeedBytes 无关。这里用 64KB，避免「响应头 OK 但载荷不足」被淘汰。
	payload := strings.Repeat("z", 64*1024)
	srv := newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("bytes") == "" && strings.HasPrefix(r.URL.Path, "/__edge") {
			w.Header().Set("Cf-Ray", "abc123-NRT")
			w.WriteHeader(http.StatusSwitchingProtocols)
			return
		}
		// 必须声明 Content-Length：否则 http.Server 会保持连接，
		// 客户端只能等到 deadline 才知道「数据发完了」（测试会白等十几秒）。
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		// 新口径会校验探针标记，缺了它测速必失败（阶段三会跳过这个候选）。
		w.Header().Set("X-Probe-Bytes", strconv.Itoa(len(payload)))
		_, _ = w.Write([]byte(payload))
	}))
	defer srv.stop()

	// 要求 SIN，但实际是 NRT → 筛完为空 → 应**忽略筛选**而不是返回空结果
	sum, err := Run(context.Background(), Options{
		Host:           "test.example.com",
		Port:           srv.Port,
		Candidates:     []string{srv.Addr},
		Countries:      []string{"SIN"},
		Top:            10,
		SpeedBytes:     64 * 1024,
		SpeedTimeoutMs: 2000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if sum.Stats["countryFilterIgnored"] != 1 {
		t.Errorf("应记录「忽略地区筛选」，实际 stats=%v", sum.Stats)
	}
	if len(sum.Entries) != 1 {
		t.Errorf("筛完为空时应忽略筛选并保留结果，实际 %d 个", len(sum.Entries))
	}
}

// 并发执行器：结果数量正确、并发上限被遵守。
func TestForEachIPConcurrency(t *testing.T) {
	const n = 50
	items := make([]int, n)
	for i := range items {
		items[i] = i
	}

	// 用真正的 sync.Mutex 保护计数。
	// 早期版本用「容量 1 的 channel 当互斥锁」，但初始 token 被拿走两次，
	// 导致所有 goroutine 卡在 <-mu 上死锁 —— 别再用 channel 模拟锁。
	var mu sync.Mutex
	inFlight := 0
	maxInFlight := 0

	out := forEachIP(context.Background(), items, 4, func(i int) (int, bool) {
		mu.Lock()
		inFlight++
		if inFlight > maxInFlight {
			maxInFlight = inFlight
		}
		mu.Unlock()

		time.Sleep(2 * time.Millisecond)

		mu.Lock()
		inFlight--
		mu.Unlock()

		return i, i%2 == 0
	}, nil)

	if len(out) != 25 {
		t.Errorf("偶数应有 25 个，实际 %d", len(out))
	}

	mu.Lock()
	peak := maxInFlight
	mu.Unlock()
	if peak > 4 {
		t.Errorf("并发不应超过 4，实际 %d", peak)
	}
	if peak < 2 {
		t.Errorf("应有并发（否则执行器退化成了串行），实际峰值 %d", peak)
	}
}

// ctx 取消后应立即停止（不把全部候选跑完）。
func TestForEachIPCancellation(t *testing.T) {
	items := make([]int, 1000)
	for i := range items {
		items[i] = i
	}

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	start := time.Now()
	_ = forEachIP(ctx, items, 8, func(i int) (int, bool) {
		time.Sleep(5 * time.Millisecond)
		return i, true
	}, nil)
	elapsed := time.Since(start)

	// 如果没在取消后停止，1000 个 × 5ms / 8 并发 ≈ 625ms
	if elapsed > 400*time.Millisecond {
		t.Errorf("取消后应立即停止，实际耗时 %v", elapsed)
	}
}

// ------------------------------------------------------------------
// 工具函数测试
// ------------------------------------------------------------------

func TestExtractColo(t *testing.T) {
	cases := []struct{ in, want string }{
		{"cf-ray: 8a1b2c3d4e5f-NRT\r\n", "NRT"},
		{"CF-Ray: abc123-hkg\r\n", "HKG"}, // 大小写不敏感，输出大写
		{"server: cloudflare\r\n", ""},
		{"", ""},
	}
	for _, tc := range cases {
		if got := extractColo(tc.in); got != tc.want {
			t.Errorf("extractColo(%q) = %q，期望 %q", tc.in, got, tc.want)
		}
	}
}

func TestShortErr(t *testing.T) {
	cases := []struct{ in, want string }{
		{"dial tcp: i/o timeout", "超时"},
		{"connection refused", "连接被拒"},
		{"no such host", "域名解析失败"},
		{"connection reset by peer", "连接被重置"},
		{"EOF", "连接被关闭"},
		{"use of closed network connection", "连接被关闭"},
		{"something else entirely", "something else entirely"},
	}
	for _, tc := range cases {
		got := shortErr(fmt.Errorf("%s", tc.in))
		if got != tc.want {
			t.Errorf("shortErr(%q) = %q，期望 %q", tc.in, got, tc.want)
		}
	}
}

func TestDefaults(t *testing.T) {
	o := Options{}.withDefaults()
	checks := map[string][2]int{
		"Port":             {o.Port, 443},
		"Concurrency":      {o.Concurrency, defConcurrency},
		"TCPTimeoutMs":     {o.TCPTimeoutMs, defTCPTimeoutMs},
		"Retries":          {o.Retries, defRetries},
		"TLSConcurrency":   {o.TLSConcurrency, defTLSConcurrency},
		"TLSTimeoutMs":     {o.TLSTimeoutMs, defTLSTimeoutMs},
		"ProbeLimit":       {o.ProbeLimit, defProbeLimit},
		"ProbeConcurrency": {o.ProbeConcurrency, defProbeConcurrency},
		"ProbeTimeoutMs":   {o.ProbeTimeoutMs, defProbeTimeoutMs},
		"SpeedLimit":       {o.SpeedLimit, defSpeedLimit},
		"SpeedConcurrency": {o.SpeedConcurrency, defSpeedConcurrency},
		"SpeedConnections": {o.SpeedConnections, defSpeedConnections},
		"SpeedDurationMs":  {o.SpeedDurationMs, defSpeedDurationMs},
		"SpeedTimeoutMs":   {o.SpeedTimeoutMs, defSpeedTimeoutMs},
		"SpeedBytes":       {o.SpeedBytes, defSpeedBytes},
		"Top":              {o.Top, defTop},
	}
	for name, pair := range checks {
		if pair[0] != pair[1] {
			t.Errorf("%s 默认值应为 %d，实际 %d", name, pair[1], pair[0])
		}
	}
	if o.WSPath != ProbeDefaultPath {
		t.Errorf("WSPath 默认应为 %q，实际 %q", ProbeDefaultPath, o.WSPath)
	}
}

// TestSpeedDefaults 守护阶段三的两条「口径级」默认值：
//
//  1. 候选测速**串行**（SpeedConcurrency = 1）——带宽是整条链路共享的，
//     4 路并行测候选会让每个只测到约 1/4（「优选出来的 IP 全都只有
//     0.1~0.9 MB/s」的主因）；
//  2. 每个候选**多连接**（SpeedConnections = 3）——单条 TCP 受拥塞窗口 /
//     BDP 限制，真机同一链路单流 0.47 MB/s、3 流 1.14 MB/s。
//
// 对照 CLI packages/cli/src/scan/scan.ts 的 speedConcurrency（默认 1）
// 与 true-probe.ts 的 measureThroughput（connections 默认 3）。
func TestSpeedDefaults(t *testing.T) {
	o := Options{}.withDefaults()
	if o.SpeedConcurrency != 1 {
		t.Errorf("阶段三候选测速必须串行（SpeedConcurrency=1），实际 %d", o.SpeedConcurrency)
	}
	if o.SpeedConnections != 3 {
		t.Errorf("每个候选应默认 3 条连接（SpeedConnections=3），实际 %d", o.SpeedConnections)
	}
	if o.SpeedDurationMs != 6000 {
		t.Errorf("单次测量时长默认应为 6000ms，实际 %d", o.SpeedDurationMs)
	}
	if o.SpeedTimeoutMs != 12000 {
		t.Errorf("整体预算默认应为 12000ms，实际 %d", o.SpeedTimeoutMs)
	}

	// 显式传正值时不能被默认值覆盖（自动化 / 界面仍可调）。
	custom := Options{SpeedConcurrency: 2, SpeedConnections: 5, SpeedDurationMs: 3000}.withDefaults()
	if custom.SpeedConcurrency != 2 || custom.SpeedConnections != 5 || custom.SpeedDurationMs != 3000 {
		t.Errorf("显式参数被默认值覆盖了：%+v", custom)
	}
}
