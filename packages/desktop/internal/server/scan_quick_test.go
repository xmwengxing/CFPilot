package server

// 一键优选「按账号执行」与「并发保护」的回归测试。
//
// ## 背景
//
// 托盘「一键优选 IP」从单个菜单项改成了**账号子菜单**：点哪个账号，
// 就用哪个账号自己的 Token / KV 清单 / 面板密码跑，回填也回到它的面板。
// 于是服务端必须支持「指定账号」——不能只认 s.store.Active()。
//
// 这里覆盖四个容易回归的点：
//  1. 指定账号时用的是**它的** Token 与 KV（不串到活跃账号）；
//  2. 缺 Token / 缺 KV 时给出原来的中文提示，且**不发任何网络请求**；
//  3. 扫描互斥在 RunQuickScanFor 内部（托盘直接调方法也不能绕过）；
//  4. 兼容入口 RunQuickScan / HTTP 端点仍按活跃账号跑。
//
// 测试用假 Cloudflare API（Server.SetCFAPIBase）：KV 读取一律 404，
// 让流程恰好停在「没有找到部署清单」，从而能在**不访问真实网络**的前提下
// 断言「读了哪个账号的哪个 KV」。

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/store"
)

// newQuickScanServer 造一个不监听端口的服务实例（带隔离凭据库）。
func newQuickScanServer(t *testing.T, st *store.Store) *Server {
	t.Helper()
	s, err := New(config.DefaultSettings())
	if err != nil {
		t.Fatalf("创建服务失败：%v", err)
	}
	s.SetStore(st)
	return s
}

// kvHit 记录一次 KV 读取请求。
type kvHit struct {
	token string
	ns    string
}

// newKV404Server 起一台假 Cloudflare API：所有 KV 读取都回 404。
//
// 404 的语义是「键不存在」→ RunQuickScanFor 返回「没有找到部署清单」，
// 不会继续去读真实面板，测试因此不依赖网络。
func newKV404Server(t *testing.T, hits *[]kvHit, mu *sync.Mutex) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const marker = "/storage/kv/namespaces/"
		if !strings.Contains(r.URL.Path, marker) {
			t.Errorf("意料之外的请求：%s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		rest := r.URL.Path[strings.Index(r.URL.Path, marker)+len(marker):]
		ns := strings.SplitN(rest, "/", 2)[0]
		mu.Lock()
		*hits = append(*hits, kvHit{token: token, ns: ns})
		mu.Unlock()
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// 没有任何账号时，RunQuickScanFor 必须给出可操作的中文提示。
func TestRunQuickScanWithoutAnyProfile(t *testing.T) {
	s := newQuickScanServer(t, newEmptyStore(t))

	res := s.RunQuickScan(context.Background())
	if res.OK {
		t.Fatal("没有账号时不该成功")
	}
	if !strings.Contains(res.Error, "API Token") {
		t.Errorf("错误应提示先添加 API Token，实际：%s", res.Error)
	}
}

// 有 Token 但没检测账号 / 没选 KV 时，报错必须指向「凭据」页，
// 且**不能**发出任何网络请求（否则用户看到的是超时而不是提示）。
func TestRunQuickScanForRequiresKV(t *testing.T) {
	var (
		mu   sync.Mutex
		hits []kvHit
	)
	cfSrv := newKV404Server(t, &hits, &mu)

	st := newEmptyStore(t)
	p, err := st.Create("账号A", &store.Profile{
		CfToken:   "token-a",
		AccountID: "acct-a",
		// 故意不填 KVNamespaceID
	})
	if err != nil {
		t.Fatalf("保存账号失败：%v", err)
	}

	s := newQuickScanServer(t, st)
	s.SetCFAPIBase(cfSrv.URL)

	progressCalled := false
	res := s.RunQuickScanFor(context.Background(), p, func(scan.Progress) {
		progressCalled = true
	})
	if res.OK {
		t.Fatal("没有 KV 时不该成功")
	}
	if !strings.Contains(res.Error, "KV") {
		t.Errorf("错误应提示先选择 KV，实际：%s", res.Error)
	}
	mu.Lock()
	n := len(hits)
	mu.Unlock()
	if n != 0 {
		t.Errorf("校验未通过时不该请求 Cloudflare API，实际请求了 %d 次 KV", n)
	}
	if progressCalled {
		t.Error("校验未通过时不该回调进度（会让托盘显示一个假的进度）")
	}
}

// 指定账号时，必须用它**自己的** Token 读它**自己的** KV；
// 兼容入口 RunQuickScan 则按活跃账号跑。
func TestRunQuickScanForUsesGivenProfile(t *testing.T) {
	var (
		mu   sync.Mutex
		hits []kvHit
	)
	cfSrv := newKV404Server(t, &hits, &mu)

	st := newEmptyStore(t)
	a, err := st.Create("账号A", &store.Profile{
		CfToken:       "token-a",
		AccountID:     "acct-a",
		KVNamespaceID: "kv-a",
	})
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.Create("账号B", &store.Profile{
		CfToken:       "token-b",
		AccountID:     "acct-b",
		KVNamespaceID: "kv-b",
	})
	if err != nil {
		t.Fatal(err)
	}
	// Create 会把新账号设为激活。这里把 A 设回激活，
	// 这样「指定 B」与「按活跃跑（A）」两种路径的期望值不同，断言才有意义。
	if ok, _, err := st.SetActive(a.ID); !ok || err != nil {
		t.Fatalf("设置活跃账号失败：%v", err)
	}

	s := newQuickScanServer(t, st)
	s.SetCFAPIBase(cfSrv.URL)

	// ---- 指定 B：哪怕活跃账号是 A，也必须用 B 的凭据 ----
	res := s.RunQuickScanFor(context.Background(), b, nil)
	if res.OK {
		t.Fatal("清单不存在时不该成功")
	}
	if !strings.Contains(res.Error, "部署清单") {
		t.Errorf("错误应提示没有部署清单，实际：%s", res.Error)
	}
	mu.Lock()
	got := append([]kvHit(nil), hits...)
	hits = nil
	mu.Unlock()
	want := []kvHit{{token: "token-b", ns: "kv-b"}}
	if len(got) != len(want) || got[0] != want[0] {
		t.Errorf("应读取指定账号 B 的 KV，实际：%+v（期望 %+v）", got, want)
	}

	// ---- 兼容入口：按活跃账号 A 跑 ----
	res = s.RunQuickScan(context.Background())
	if res.OK {
		t.Fatal("清单不存在时不该成功")
	}
	mu.Lock()
	got = append([]kvHit(nil), hits...)
	mu.Unlock()
	want = []kvHit{{token: "token-a", ns: "kv-a"}}
	if len(got) != len(want) || got[0] != want[0] {
		t.Errorf("RunQuickScan 应读取活跃账号 A 的 KV，实际：%+v（期望 %+v）", got, want)
	}
}

// QuickScanProfile：按 ID 精确查（空串 = 活跃账号），查不到返回 nil。
func TestQuickScanProfileLookup(t *testing.T) {
	st := newEmptyStore(t)
	a, err := st.Create("账号A", &store.Profile{CfToken: "token-a", AccountID: "acct-a", KVNamespaceID: "kv-a"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.Create("账号B", &store.Profile{CfToken: "token-b", AccountID: "acct-b", KVNamespaceID: "kv-b"})
	if err != nil {
		t.Fatal(err)
	}
	s := newQuickScanServer(t, st)

	if p, err := s.QuickScanProfile(a.ID); err != nil || p == nil || p.ID != a.ID {
		t.Errorf("按 ID 查账号 A 失败：p=%+v err=%v", p, err)
	}
	// 空串 = 当前活跃账号（Create 最后创建的是 B）
	if p, err := s.QuickScanProfile(""); err != nil || p == nil || p.ID != b.ID {
		t.Errorf("空串应返回活跃账号 B，实际：p=%+v err=%v", p, err)
	}
	// 不存在的 ID 必须返回 nil（调用方据此报错，绝不能回落到活跃账号）
	if p, err := s.QuickScanProfile("acc_missing"); err != nil || p != nil {
		t.Errorf("不存在的账号应返回 nil，实际：p=%+v err=%v", p, err)
	}
}

// QuickScanAccounts：返回全部账号，且只有活跃账号 Active=true。
func TestQuickScanAccountsMarksActive(t *testing.T) {
	st := newEmptyStore(t)
	a, err := st.Create("账号A", &store.Profile{CfToken: "token-a", AccountID: "acct-a", KVNamespaceID: "kv-a"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.Create("账号B", &store.Profile{CfToken: "token-b", AccountID: "acct-b", KVNamespaceID: "kv-b"})
	if err != nil {
		t.Fatal(err)
	}
	if ok, _, err := st.SetActive(a.ID); !ok || err != nil {
		t.Fatalf("设置活跃账号失败：%v", err)
	}

	s := newQuickScanServer(t, st)
	list := s.QuickScanAccounts()
	if len(list) != 2 {
		t.Fatalf("应返回 2 个账号，实际 %d", len(list))
	}
	byID := map[string]QuickScanAccount{}
	for _, acc := range list {
		byID[acc.ID] = acc
	}
	if got := byID[a.ID]; !got.Active || got.Name != "账号A" || got.AccountID != "acct-a" {
		t.Errorf("账号 A 的摘要不对：%+v", got)
	}
	if got := byID[b.ID]; got.Active {
		t.Errorf("账号 B 不是活跃账号，不该打勾：%+v", got)
	}
}

// 扫描互斥必须在 RunQuickScanFor 内部就生效：
// 托盘菜单是直接调这个方法的，互斥只在 HTTP handler 里会被绕过。
func TestRunQuickScanHonorsScanMutex(t *testing.T) {
	s := newQuickScanServer(t, newEmptyStore(t))

	// 模拟「已有扫描在进行」
	s.scan.mu.Lock()
	s.scan.running = true
	s.scan.cancel = func() {}
	s.scan.mu.Unlock()
	t.Cleanup(func() {
		s.scan.mu.Lock()
		s.scan.running = false
		s.scan.cancel = nil
		s.scan.mu.Unlock()
	})

	res := s.RunQuickScan(context.Background())
	if res.OK {
		t.Fatal("已有扫描时不该开始新的扫描")
	}
	if !strings.Contains(res.Error, "已有扫描正在进行") {
		t.Errorf("错误应说明已有扫描在跑，实际：%s", res.Error)
	}

	// 抢锁失败的一方不能把别人的状态清掉
	s.scan.mu.Lock()
	stillRunning := s.scan.running
	s.scan.mu.Unlock()
	if !stillRunning {
		t.Error("抢锁失败时不该清除对方正在运行的标记")
	}
}

// HTTP 端点 /api/scan/quick 的行为保持不变：按活跃账号跑，返回 200 + ok=false。
func TestScanQuickEndpointStillUsesActiveProfile(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/scan/quick", cookie, nil)
	if code != http.StatusOK {
		t.Fatalf("应返回 200（业务失败放在 ok/error 里），实际 %d (%v)", code, body)
	}
	if body["ok"] != false {
		t.Errorf("没有账号时应返回 ok=false，实际 %v", body["ok"])
	}
	if !strings.Contains(str(body["error"]), "API Token") {
		t.Errorf("错误应提示先添加 API Token，实际 %v", body["error"])
	}
}
