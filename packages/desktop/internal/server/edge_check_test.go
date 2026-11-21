package server

// /api/edge/check 的路由级测试：鉴权 + 只读 + 响应结构。
//
// 探测逻辑本身由 internal/edge 的单测覆盖；这里不碰真实网络：
// 假账号故意**不返回自定义域名**，检测因此跳过 /health 探测。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func fakeEdgeCheckCF(t *testing.T) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("检测不应发非 GET 请求：%s %s", r.Method, r.URL.Path)
		}
		out := func(result any) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": result})
		}
		switch r.URL.Path {
		case "/accounts/acc-1/workers/scripts":
			out([]map[string]string{{"id": "mobihop-edge-relay"}})
		case "/accounts/acc-1/workers/scripts/mobihop-edge-relay/settings":
			out(map[string]any{"bindings": []map[string]any{
				{"type": "d1", "name": "DB", "id": "db-1"},
				{"type": "durable_object_namespace", "name": "MESH_ROOM", "class_name": "MeshRoom"},
				{"type": "plain_text", "name": "MONITOR_TOKEN", "text": "monitor-token-123456"},
			}})
		case "/accounts/acc-1/workers/domains":
			out([]map[string]any{})
		case "/accounts/acc-1/d1/database":
			out([]map[string]any{{"uuid": "db-1", "name": "mobihop-edge-relay-monitor"}})
		case "/accounts/acc-1/pages/projects":
			out([]map[string]any{})
		case "/zones":
			out([]map[string]any{})
		case "/accounts/acc-1/workers/subdomain":
			out(map[string]string{"subdomain": "demo"})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}
}

func TestEdgeCheckRequiresSession(t *testing.T) {
	_, base := newTestServer(t)
	code, _ := getJSON(t, base+"/api/edge/check", &http.Cookie{Name: "cfp_session", Value: "bogus"})
	if code != http.StatusUnauthorized {
		t.Fatalf("未登录应 401，实际 %d", code)
	}
}

func TestEdgeCheckReturnsInstances(t *testing.T) {
	cfSrv := httptest.NewServer(fakeEdgeCheckCF(t))
	t.Cleanup(cfSrv.Close)

	s, base := newTestServer(t)
	s.SetCFAPIBase(cfSrv.URL)
	st := newEmptyStore(t)
	if _, err := st.Create("测试账号", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SaveActive(patchTokenAndAccount("cfat_test", "acc-1")); err != nil {
		t.Fatal(err)
	}
	s.SetStore(st)
	cookie := loginCookie(t, s, base)

	code, body := getJSON(t, base+"/api/edge/check", cookie)
	if code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200；响应：%v", code, body)
	}
	if ok, _ := body["ok"].(bool); !ok {
		t.Fatalf("ok 字段缺失：%v", body)
	}
	if id, _ := body["accountId"].(string); id != "acc-1" {
		t.Fatalf("accountId = %q，期望 acc-1", id)
	}
	if running, _ := body["deployInProgress"].(bool); running {
		t.Fatalf("没有部署在跑时 deployInProgress 应为 false")
	}
	list, _ := body["instances"].([]any)
	if len(list) != 1 {
		t.Fatalf("应返回 1 个实例，实际 %d：%v", len(list), body)
	}
	ins, _ := list[0].(map[string]any)
	if name, _ := ins["workerName"].(string); name != "mobihop-edge-relay" {
		t.Fatalf("workerName = %q", name)
	}
	if token, _ := ins["monitorToken"].(string); token != "monitor-token-123456" {
		t.Fatalf("令牌应回填，实际 %q", token)
	}
	if warns, _ := body["warnings"].([]any); warns == nil {
		t.Fatalf("warnings 应是数组（空也要有），实际 %v", body["warnings"])
	}
}

func TestEdgeCheckRejectsNonGet(t *testing.T) {
	s, base := newTestServer(t)
	st := newEmptyStore(t)
	if _, err := st.Create("测试账号", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SaveActive(patchTokenAndAccount("cfat_test", "acc-1")); err != nil {
		t.Fatal(err)
	}
	s.SetStore(st)
	cookie := loginCookie(t, s, base)
	code, _ := postJSON(t, base+"/api/edge/check", cookie, map[string]any{})
	if code != http.StatusMethodNotAllowed {
		t.Fatalf("POST 应 405，实际 %d", code)
	}
}