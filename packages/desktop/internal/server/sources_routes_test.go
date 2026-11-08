package server

// Phase 5 回归：桌面版「外部 IP 数据源」API 的鉴权、SSRF 拦截与配置往返。
//
// 用 httptest 直接挂 s.routes()，不占真实端口、不启动定时同步
// （startSourceScheduler 只在 Start() 里调用）。
// 会话 Cookie 直接注入，避免为每条用例走一遍 /__session。

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

func newSourcesAPIServer(t *testing.T) (*httptest.Server, *http.Client, string) {
	t.Helper()
	t.Setenv("CFPILOT_CONFIG_DIR", t.TempDir())
	s, err := New(config.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	s.sessionToken = "test-session-token"
	ts := httptest.NewServer(s.routes())
	t.Cleanup(ts.Close)
	return ts, ts.Client(), ts.URL
}

func sourcesRequest(t *testing.T, client *http.Client, method, url, body string) (int, map[string]any) {
	t.Helper()
	var reader *bytes.Reader
	if body == "" {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader([]byte(body))
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: SessionCookie, Value: "test-session-token"})
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func TestSourcesAPIRequiresSession(t *testing.T) {
	ts, _, _ := newSourcesAPIServer(t)
	res, err := http.Get(ts.URL + "/api/sources/list")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("无会话应 401，实际 %d", res.StatusCode)
	}
}

func TestSourcesAPIListSeedsBuiltin(t *testing.T) {
	_, client, base := newSourcesAPIServer(t)
	code, body := sourcesRequest(t, client, http.MethodGet, base+"/api/sources/list", "")
	if code != 200 || body["ok"] != true {
		t.Fatalf("list 失败：code=%d body=%v", code, body)
	}
	cfg, ok := body["config"].(map[string]any)
	// 配置文件不存在时，列表接口应返回随版本内置的来源清单
	if !ok || len(cfg["sources"].([]any)) != scan.BuiltinSourcesCount {
		t.Fatalf("首次 list 应播种内置来源：%v", body["config"])
	}
	if _, ok := body["pool"].(map[string]any); !ok {
		t.Fatal("缺少池统计")
	}
	if _, ok := body["scheduler"].(map[string]any); !ok {
		t.Fatal("缺少调度器状态")
	}
}

func TestSourcesAPISaveRejectsPrivateURL(t *testing.T) {
	_, client, base := newSourcesAPIServer(t)
	payload := `{"config":{"schema":1,"updatedAt":0,"sources":[` +
		`{"id":"bad","name":"bad","type":"custom-url","url":"https://127.0.0.1/admin",` +
		`"mirrors":[],"enabled":true,"intervalHours":24,"etag":"","lastModified":"",` +
		`"lastSyncAt":0,"lastError":"","failCount":0}],"runs":[]}}`
	code, body := sourcesRequest(t, client, http.MethodPost, base+"/api/sources/save", payload)
	if code != http.StatusBadRequest {
		t.Fatalf("私网 URL 应 400，实际 %d body=%v", code, body)
	}
	if body["ok"] != false {
		t.Fatal("失败响应必须带 ok=false")
	}
}

func TestSourcesAPISaveAndListRoundTrip(t *testing.T) {
	_, client, base := newSourcesAPIServer(t)
	src := scan.MakeSource("gh", "", scan.SourceTypeGitHubRaw,
		"https://raw.githubusercontent.com/owner/repo/main/ips.txt", nil, true, 12)
	raw, err := json.Marshal(map[string]any{
		"config": scan.SourcesFile{
			Schema: scan.SourcesSchema, UpdatedAt: 0,
			Sources: []scan.SourceConfig{src}, Runs: []scan.SyncRun{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	code, body := sourcesRequest(t, client, http.MethodPost, base+"/api/sources/save", string(raw))
	if code != 200 || body["ok"] != true {
		t.Fatalf("保存失败：code=%d body=%v", code, body)
	}
	_, listed := sourcesRequest(t, client, http.MethodGet, base+"/api/sources/list", "")
	cfg := listed["config"].(map[string]any)
	sources := cfg["sources"].([]any)
	if len(sources) != 1 {
		t.Fatalf("配置没有持久化：%v", cfg)
	}
	first := sources[0].(map[string]any)
	if first["id"] != "gh" || first["type"] != "github-raw" {
		t.Fatalf("字段不对：%v", first)
	}
}

func TestSourcesAPIPoolUpdateAndEmptyPool(t *testing.T) {
	_, client, base := newSourcesAPIServer(t)
	_, pool := sourcesRequest(t, client, http.MethodGet, base+"/api/sources/pool", "")
	if pool["ok"] != true || len(pool["candidates"].([]any)) != 0 {
		t.Fatalf("空池读取不对：%v", pool)
	}
	code, body := sourcesRequest(t, client, http.MethodPost, base+"/api/sources/pool/update",
		`{"keys":["104.16.0.1:443"],"action":"disable"}`)
	if code != 200 || body["changed"] != float64(0) {
		t.Fatalf("空池批量操作应返回 changed=0：code=%d body=%v", code, body)
	}
	_, bad := sourcesRequest(t, client, http.MethodPost, base+"/api/sources/pool/update",
		`{"keys":[],"action":"unknown"}`)
	if bad["ok"] != false {
		t.Fatalf("非法 action 必须被拒：%v", bad)
	}
}

func TestSourcesAPISyncWithNoSources(t *testing.T) {
	_, client, base := newSourcesAPIServer(t)
	code, body := sourcesRequest(t, client, http.MethodPost, base+"/api/sources/sync", `{}`)
	if code != 200 || body["ok"] != true {
		t.Fatalf("无数据源时同步应正常返回空报告：code=%d body=%v", code, body)
	}
	if report, ok := body["report"].(map[string]any); !ok || len(report["outcomes"].([]any)) != 0 {
		t.Fatalf("报告结构不对：%v", body["report"])
	}
}
