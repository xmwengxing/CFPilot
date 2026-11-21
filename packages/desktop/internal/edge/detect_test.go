package edge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
)

/* ---------------- 纯函数 ---------------- */

func relayBindingSet() []cfapi.WorkerBinding {
	return []cfapi.WorkerBinding{
		{"type": "d1", "name": "DB", "id": "db-uuid-1"},
		{"type": "durable_object_namespace", "name": "MESH_ROOM", "class_name": "MeshRoom"},
		{"type": "plain_text", "name": "MONITOR_TOKEN", "text": "monitor-token-abc123456789"},
		{"type": "plain_text", "name": "WINDOW_MS", "text": "1000"},
		{"type": "plain_text", "name": "MAX_BYTES_PER_WINDOW", "text": "1048576"},
		{"type": "plain_text", "name": "MAX_PACKETS_PER_WINDOW", "text": "2000"},
		{"type": "plain_text", "name": "MAX_PEERS_PER_ROOM", "text": "512"},
	}
}

func TestIsEdgeRelayBindings(t *testing.T) {
	if !isEdgeRelayBindings(relayBindingSet()) {
		t.Fatal("带 MONITOR_TOKEN + MeshRoom + DB 的绑定应被识别为盲中继")
	}
	if isEdgeRelayBindings([]cfapi.WorkerBinding{{"type": "plain_text", "name": "FOO", "text": "bar"}}) {
		t.Fatal("普通 Worker 不应被识别")
	}
	// 只有 D1、没有令牌：不是我们的脚本
	if isEdgeRelayBindings([]cfapi.WorkerBinding{{"type": "d1", "name": "DB", "id": "x"}}) {
		t.Fatal("缺 MONITOR_TOKEN 不应被识别")
	}
	// secret_text 的令牌：算本脚本，但值不可读
	secret := []cfapi.WorkerBinding{
		{"type": "d1", "name": "DB", "id": "db-uuid-1"},
		{"type": "secret_text", "name": "MONITOR_TOKEN"},
	}
	if !isEdgeRelayBindings(secret) {
		t.Fatal("secret_text 令牌仍应视为盲中继脚本")
	}
	if got := readPlainText(secret, "MONITOR_TOKEN"); got != "" {
		t.Fatalf("secret 令牌不应读到值，实际 %q", got)
	}
}

func TestPickWorkerDomain(t *testing.T) {
	domains := []cfapi.WorkerDomain{
		{ID: "a", Hostname: "b.example.com", Service: "w", Enabled: false},
		{ID: "b", Hostname: "a.example.com", Service: "w", Enabled: true},
		{ID: "c", Hostname: "other.example.com", Service: "other", Enabled: true},
	}
	if got := pickWorkerDomain(domains, "w"); got != "a.example.com" {
		t.Fatalf("应优先选启用的域名，实际 %q", got)
	}
	if got := pickWorkerDomain(domains, "missing"); got != "" {
		t.Fatalf("没有匹配服务时应返回空，实际 %q", got)
	}
}

func TestPickDashboardProject(t *testing.T) {
	projects := []cfapi.PagesProject{{Name: "edge-dashboard"}}
	if got, guessed := pickDashboardProject(projects, "edge"); got != "edge-dashboard" || guessed {
		t.Fatalf("精确名应直接命中：%q guessed=%v", got, guessed)
	}
	fuzzy := []cfapi.PagesProject{{Name: "my-monitor"}}
	if got, guessed := pickDashboardProject(fuzzy, "edge"); got != "my-monitor" || !guessed {
		t.Fatalf("唯一 dashboard/monitor 项目应兜底并标记 guessed：%q guessed=%v", got, guessed)
	}
	if got, _ := pickDashboardProject(nil, "edge"); got != "" {
		t.Fatalf("没有项目时应返回空，实际 %q", got)
	}
}

func TestMatchZoneByDomain(t *testing.T) {
	zones := []cfapi.Zone{
		{ID: "z1", Name: "example.com"},
		{ID: "z2", Name: "sub.example.com"},
	}
	if z := matchZoneByDomain("relay.sub.example.com", zones); z == nil || z.ID != "z2" {
		t.Fatalf("最长后缀匹配失败：%+v", z)
	}
	if z := matchZoneByDomain("relay.example.com", zones); z == nil || z.ID != "z1" {
		t.Fatalf("主域匹配失败：%+v", z)
	}
	if z := matchZoneByDomain("other.net", zones); z != nil {
		t.Fatalf("不相关域名不应匹配：%+v", z)
	}
}

func TestRankScriptNames(t *testing.T) {
	got := rankScriptNames([]string{"zzz", "edge-relay", "mobihop-edge-relay"}, "mobihop-edge-relay")
	if got[0] != "mobihop-edge-relay" {
		t.Fatalf("指定名字应排最前：%v", got)
	}
	if got[2] != "zzz" {
		t.Fatalf("不像盲中继的排最后：%v", got)
	}
}

/* ---------------- 假 Cloudflare API ---------------- */

type fakeEdgeCF struct {
	mu      sync.Mutex
	methods []string
	fail    map[string]int // path 前缀 → 状态码（模拟 403）
	// noDomains 模拟「没有绑定自定义域名」
	noDomains bool
	// secretToken 模拟「MONITOR_TOKEN 被改成了 secret_text」
	secretToken bool
}

func (f *fakeEdgeCF) handler(t *testing.T) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.methods = append(f.methods, r.Method+" "+r.URL.Path)
		f.mu.Unlock()

		if r.Method != http.MethodGet {
			t.Errorf("检测不应发非 GET 请求：%s %s", r.Method, r.URL.Path)
		}
		for prefix, code := range f.fail {
			if strings.HasPrefix(r.URL.Path, prefix) {
				w.WriteHeader(code)
				return
			}
		}
		writeResult := func(result any) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": result})
		}

		path := r.URL.Path
		switch {
		case path == "/accounts/acc/workers/scripts":
			writeResult([]map[string]string{{"id": "mobihop-edge-relay"}, {"id": "my-other-worker"}})
		case strings.HasSuffix(path, "/settings"):
			name := path[strings.LastIndex(path, "/workers/scripts/")+len("/workers/scripts/"):]
			name = strings.TrimSuffix(name, "/settings")
			switch {
			case name == "mobihop-edge-relay" && f.secretToken:
				bindings := relayBindingSet()
				for i := range bindings {
					if bindingString(bindings[i], "name") == "MONITOR_TOKEN" {
						bindings[i] = cfapi.WorkerBinding{"type": "secret_text", "name": "MONITOR_TOKEN"}
					}
				}
				writeResult(map[string]any{"bindings": bindings})
			case name == "mobihop-edge-relay":
				writeResult(map[string]any{"bindings": relayBindingSet()})
			default:
				writeResult(map[string]any{"bindings": []map[string]string{{"type": "plain_text", "name": "FOO", "text": "bar"}}})
			}
		case path == "/accounts/acc/workers/domains":
			if f.noDomains {
				writeResult([]map[string]any{})
				return
			}
			writeResult([]map[string]any{{
				"id": "d1", "hostname": "relay.example.com", "service": "mobihop-edge-relay", "enabled": true,
			}})
		case strings.HasPrefix(path, "/accounts/acc/d1/database"):
			writeResult([]map[string]any{{"uuid": "db-uuid-1", "name": "mobihop-edge-relay-monitor"}})
		case path == "/accounts/acc/pages/projects":
			writeResult([]map[string]any{{"id": "p1", "name": "mobihop-edge-relay-dashboard", "production_branch": "main"}})
		case path == "/zones":
			writeResult([]map[string]any{{"id": "zone-1", "name": "example.com", "status": "active"}})
		case path == "/accounts/acc/workers/subdomain":
			writeResult(map[string]string{"subdomain": "demo"})
		default:
			t.Logf("未处理的假路由：%s %s", r.Method, path)
			w.WriteHeader(http.StatusNotFound)
		}
	}
}

func newFakeClient(t *testing.T) (*cfapi.Client, *fakeEdgeCF) {
	t.Helper()
	f := &fakeEdgeCF{fail: map[string]int{}}
	srv := httptest.NewServer(f.handler(t))
	t.Cleanup(srv.Close)
	return cfapi.New(cfapi.Options{Token: "t", APIBase: srv.URL}), f
}

/* ---------------- Detect ---------------- */

func TestDetectFindsInstanceAndMapsFields(t *testing.T) {
	client, fake := newFakeClient(t)
	probed := ""
	instances, warnings, err := Detect(context.Background(), client, "acc", DetectOptions{
		Probe: true,
		Prober: func(_ context.Context, baseURL string) (bool, bool, bool, error) {
			probed = baseURL
			return true, true, true, nil
		},
	})
	if err != nil {
		t.Fatalf("检测不应失败：%v", err)
	}
	if len(instances) != 1 {
		t.Fatalf("应识别出 1 个实例，实际 %d（warnings=%v）", len(instances), warnings)
	}
	ins := instances[0]
	if ins.WorkerName != "mobihop-edge-relay" {
		t.Errorf("workerName = %q", ins.WorkerName)
	}
	if ins.Domain != "relay.example.com" || ins.WorkerURL != "https://relay.example.com" {
		t.Errorf("域名回填错误：domain=%q url=%q", ins.Domain, ins.WorkerURL)
	}
	if !strings.Contains(ins.WssEndpoint, "wss://relay.example.com/mesh/") {
		t.Errorf("WSS 端点错误：%q", ins.WssEndpoint)
	}
	if ins.ZoneID != "zone-1" || ins.ZoneName != "example.com" {
		t.Errorf("Zone 回填错误：%q/%q", ins.ZoneID, ins.ZoneName)
	}
	if ins.DashboardURL != "https://relay.example.com" || !ins.DashboardReady {
		t.Errorf("面板地址错误：%q", ins.DashboardURL)
	}
	if ins.D1Name != "mobihop-edge-relay-monitor" {
		t.Errorf("D1 回填错误：%q", ins.D1Name)
	}
	if ins.MonitorToken != "monitor-token-abc123456789" {
		t.Errorf("令牌回填错误：%q", ins.MonitorToken)
	}
	if ins.Limits.WindowMs != "1000" || ins.Limits.MaxPeers != "512" {
		t.Errorf("限速参数回填错误：%+v", ins.Limits)
	}
	if !ins.Reachable || !ins.PasswordSet {
		t.Errorf("探测结果未写入：reachable=%v passwordSet=%v", ins.Reachable, ins.PasswordSet)
	}
	if probed != "https://relay.example.com" {
		t.Errorf("探测地址错误：%q", probed)
	}
	// 只读：全部都是 GET
	fake.mu.Lock()
	defer fake.mu.Unlock()
	for _, m := range fake.methods {
		if !strings.HasPrefix(m, http.MethodGet+" ") {
			t.Fatalf("检测发出非 GET 请求：%s", m)
		}
	}
}

func TestProbeRelayHTTPRequiresRootDashboardHTML(t *testing.T) {
	rootStatus := http.StatusUpgradeRequired
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "/":
			w.WriteHeader(rootStatus)
			if rootStatus == http.StatusOK {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				_, _ = w.Write([]byte("<!doctype html><html></html>"))
			}
		case "/auth/status":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"setupRequired":false}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	reachable, dashboardReady, passwordSet, err := probeRelayHTTP(context.Background(), server.URL)
	if err != nil || !reachable || dashboardReady || !passwordSet {
		t.Fatalf("426 root probe = reachable %v dashboard %v password %v err %v", reachable, dashboardReady, passwordSet, err)
	}

	rootStatus = http.StatusOK
	_, dashboardReady, _, err = probeRelayHTTP(context.Background(), server.URL)
	if err != nil || !dashboardReady {
		t.Fatalf("HTML root should mark dashboard ready: ready=%v err=%v", dashboardReady, err)
	}
}

func TestDetectNoDomainFallsBackToWorkersDev(t *testing.T) {
	client, fake := newFakeClient(t)
	fake.noDomains = true
	instances, _, err := Detect(context.Background(), client, "acc", DetectOptions{Probe: false})
	if err != nil {
		t.Fatal(err)
	}
	if len(instances) != 1 {
		t.Fatalf("应识别出 1 个实例：%+v", instances)
	}
	ins := instances[0]
	if ins.Domain != "" {
		t.Fatalf("未绑定域名时应留空，实际 %q", ins.Domain)
	}
	if ins.WorkerURL != "https://mobihop-edge-relay.demo.workers.dev" {
		t.Fatalf("应退回 workers.dev 兜底地址，实际 %q", ins.WorkerURL)
	}
	joined := strings.Join(ins.Warnings, " ")
	if !strings.Contains(joined, "未绑定自定义域名") {
		t.Fatalf("缺少未绑定域名的提示：%v", ins.Warnings)
	}
}

func TestDetectSkipsUnrelatedScripts(t *testing.T) {
	client, _ := newFakeClient(t)
	instances, _, err := Detect(context.Background(), client, "acc", DetectOptions{Probe: false})
	if err != nil {
		t.Fatal(err)
	}
	for _, ins := range instances {
		if ins.WorkerName == "my-other-worker" {
			t.Fatal("普通 Worker 不应被当成盲中继实例")
		}
	}
}

func TestDetectPartialFailureOnlyWarns(t *testing.T) {
	client, fake := newFakeClient(t)
	fake.fail["/accounts/acc/pages/projects"] = http.StatusForbidden
	fake.fail["/accounts/acc/d1/database"] = http.StatusForbidden
	instances, warnings, err := Detect(context.Background(), client, "acc", DetectOptions{Probe: false})
	if err != nil {
		t.Fatalf("局部失败不应中断：%v", err)
	}
	if len(instances) != 1 {
		t.Fatalf("仍应识别出实例：%+v", instances)
	}
	joined := strings.Join(warnings, " ")
	if !strings.Contains(joined, "Pages") || !strings.Contains(joined, "D1") {
		t.Fatalf("缺少降级提示：%v", warnings)
	}
	if len(instances[0].Warnings) == 0 {
		t.Fatal("实例级也应有提示（D1 缺失）")
	}
}

func TestDetectScriptListFailureIsFatal(t *testing.T) {
	client, fake := newFakeClient(t)
	fake.fail["/accounts/acc/workers/scripts"] = http.StatusForbidden
	_, _, err := Detect(context.Background(), client, "acc", DetectOptions{})
	if err == nil || !strings.Contains(err.Error(), "Workers Scripts") {
		t.Fatalf("脚本列表失败应给出权限提示，实际：%v", err)
	}
}

func TestDetectSecretTokenWarns(t *testing.T) {
	client, fake := newFakeClient(t)
	fake.secretToken = true
	instances, _, err := Detect(context.Background(), client, "acc", DetectOptions{Probe: false})
	if err != nil {
		t.Fatal(err)
	}
	if len(instances) != 1 {
		t.Fatalf("secret 令牌的脚本仍应被识别：%+v", instances)
	}
	if instances[0].MonitorToken != "" {
		t.Fatalf("secret 令牌不应有值，实际 %q", instances[0].MonitorToken)
	}
	if !strings.Contains(strings.Join(instances[0].Warnings, " "), "无法回填") {
		t.Fatalf("缺少令牌不可读提示：%v", instances[0].Warnings)
	}
}
