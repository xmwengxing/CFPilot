package server

import (
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/history"
	"net/http"
	"testing"
)

func TestQualityReportAPI(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)
	if err := s.historyStore().Save(history.Session{ID: "quality", At: "2026-11-01T00:00:00Z", Host: "example.com", SkipSpeed: true, Entries: []history.Entry{{IP: "104.16.1.1", Port: 443, TLSMs: 20, Latency: 10, Colo: "NRT"}}}); err != nil {
		t.Fatal(err)
	}
	endpoint := base + "/api/scan/quality-report?sessionId=quality&ip=104.16.1.1&port=443"
	code, body := getJSON(t, endpoint, cookie)
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("报告读取失败：%d %v", code, body)
	}
	report, ok := body["report"].(map[string]any)
	if !ok || report["version"] != float64(1) || report["ip"] != "104.16.1.1" {
		t.Fatalf("报告契约错误：%v", body)
	}
	fields, ok := report["fields"].([]any)
	if !ok || len(fields) < 10 {
		t.Fatal("字段状态不完整")
	}
	code, _ = getJSON(t, base+"/api/scan/quality-report", cookie)
	if code != http.StatusBadRequest {
		t.Fatal("缺参数应拒绝")
	}
	code, body = getJSON(t, base+"/api/scan/quality-report?sessionId=quality&ip=104.16.1.1&port=8443", cookie)
	if code != http.StatusOK || body["ok"] != false {
		t.Fatal("不得混淆端口")
	}
	code, _ = postJSON(t, endpoint, cookie, map[string]any{})
	if code != http.StatusMethodNotAllowed {
		t.Fatal("报告只支持只读 GET")
	}
	response, err := http.Get(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusOK {
		t.Fatal("报告不得绕过会话校验")
	}
}
