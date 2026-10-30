package server

// 优选历史与复测 API 的测试。
//
// 重点验证：
//   - 空库 GET 返回 ok + 空列表（不能报错或返回 null）
//   - DELETE 缺 id 要 400
//   - 复测缺域名 / 缺目标要 400，且提示可操作
//   - 复测对不可达 IP 返回分层失败结果（不 500、不挂起）
//
// 历史库本身的读写（保存 / 裁剪 / 复测写回）在 internal/history 包里有单测。

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 空库 GET：必须 ok=true 且 sessions 是空数组（不是 null）。
func TestScanHistoryEmpty(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := getJSON(t, base+"/api/scan/history", cookie)
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", code)
	}
	if body["ok"] != true {
		t.Errorf("应返回 ok=true，实际 %v", body["ok"])
	}
	sessions, ok := body["sessions"].([]any)
	if !ok {
		t.Fatalf("sessions 应为数组，实际 %T (%v)", body["sessions"], body["sessions"])
	}
	if len(sessions) != 0 {
		t.Errorf("空库应返回空数组，实际 %d 条", len(sessions))
	}
}

// DELETE 缺 id 参数要 400。
func TestScanHistoryDeleteRequiresID(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := callDelete(t, base+"/api/scan/history", cookie)
	if code != http.StatusBadRequest {
		t.Fatalf("缺 id 应 400，实际 %d (%v)", code, body)
	}
}

// 复测缺域名要 400，提示要说清「用历史会话的域名」。
func TestReTestRequiresHost(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/scan/re-test", cookie, map[string]any{
		"targets": []map[string]any{{"ip": "127.0.0.1", "port": 1}},
	})
	if code != http.StatusBadRequest {
		t.Fatalf("缺域名应 400，实际 %d (%v)", code, body)
	}
	if !strings.Contains(str(body["error"]), "域名") {
		t.Errorf("错误信息应提到域名，实际 %v", body["error"])
	}
}

// 复测缺目标要 400。
func TestReTestRequiresTargets(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/scan/re-test", cookie, map[string]any{
		"host": "cf.example.com",
	})
	if code != http.StatusBadRequest {
		t.Fatalf("缺目标应 400，实际 %d (%v)", code, body)
	}
	if !strings.Contains(str(body["error"]), "IP") {
		t.Errorf("错误信息应提到 IP，实际 %v", body["error"])
	}
}

// 复测超上限要 400（挡住误当批量扫描器用）。
func TestReTestRejectsTooManyTargets(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	targets := make([]map[string]any, 0, maxReTestTargets+1)
	for i := 0; i <= maxReTestTargets; i++ {
		targets = append(targets, map[string]any{"ip": "127.0.0.1", "port": 1})
	}
	code, body := postJSON(t, base+"/api/scan/re-test", cookie, map[string]any{
		"host":    "cf.example.com",
		"targets": targets,
	})
	if code != http.StatusBadRequest {
		t.Fatalf("超上限应 400，实际 %d (%v)", code, body)
	}
}

// 复测不可达 IP：必须 200 且给出分层失败结果（TCP 层失败，不 500、不挂起）。
//
// 127.0.0.1:1 基本必然「连接被拒」，失败得快，不会拖慢测试。
func TestReTestUnreachableTarget(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/scan/re-test", cookie, map[string]any{
		"host": "cf.example.com",
		"targets": []map[string]any{
			{"ip": "127.0.0.1", "port": 1},
		},
	})
	if code != http.StatusOK {
		t.Fatalf("应 200（复测失败不是接口失败），实际 %d (%v)", code, body)
	}
	if body["ok"] != true {
		t.Errorf("应返回 ok=true，实际 %v", body["ok"])
	}
	results, ok := body["results"].([]any)
	if !ok || len(results) != 1 {
		t.Fatalf("results 应为 1 条，实际 %v", body["results"])
	}
	r0, _ := results[0].(map[string]any)
	if r0["ok"] == true {
		t.Errorf("不可达 IP 不应判为可用：%v", r0)
	}
	if str(r0["error"]) == "" {
		t.Errorf("失败结果应带 error 原因：%v", r0)
	}
}

// callDelete 发 DELETE 请求并解析 JSON 响应。
func callDelete(t *testing.T, url string, cookie *http.Cookie) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodDelete, url, nil)
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}
	req.AddCookie(cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("DELETE %s 失败：%v", url, err)
	}
	defer func() { _ = res.Body.Close() }()
	var body map[string]any
	_ = json.NewDecoder(res.Body).Decode(&body)
	return res.StatusCode, body
}
