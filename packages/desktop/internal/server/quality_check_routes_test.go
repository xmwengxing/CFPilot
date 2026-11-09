package server

import (
	"net/http"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/history"
)

// 质量检测路由的参数校验（不发真实网络请求）。
//
// 这里只断言「参数不合法时必须拒绝」与「不属于该会话的 IP 必须拒绝」，
// 真实的复测与信誉查询需要外网，由真机验证。
func TestQualityCheckValidatesParams(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)
	url := base + "/api/scan/quality-check"

	code, _ := getJSON(t, url, cookie)
	if code != http.StatusMethodNotAllowed {
		t.Fatal("只支持 POST")
	}

	// 非法 IP
	code, _ = postJSON(t, url, cookie, map[string]any{"sessionId": "q", "ip": "bad", "port": 443})
	if code != http.StatusBadRequest {
		t.Fatalf("非法 IP 应拒绝，实际 %d", code)
	}
	// 缺 sessionId
	code, _ = postJSON(t, url, cookie, map[string]any{"ip": "104.16.1.1", "port": 443})
	if code != http.StatusBadRequest {
		t.Fatalf("缺 sessionId 应拒绝，实际 %d", code)
	}
	// 会话存在但 IP 不在其中
	if err := s.historyStore().Save(history.Session{
		ID: "qc", At: "2026-11-01T00:00:00Z", Host: "example.com", SkipSpeed: true,
		Entries: []history.Entry{{IP: "104.16.1.1", Port: 443, TLSMs: 20, Latency: 10, Colo: "NRT"}},
	}); err != nil {
		t.Fatal(err)
	}
	code, body := postJSON(t, url, cookie, map[string]any{"sessionId": "qc", "ip": "1.2.3.4", "port": 443})
	if code != http.StatusBadRequest || body["ok"] != false {
		t.Fatalf("不属于该会话的 IP 应拒绝：%d %v", code, body)
	}
}
