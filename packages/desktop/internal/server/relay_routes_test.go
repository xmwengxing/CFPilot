package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// TestRelayParseCandidates 候选清洗：只收 IPv4，并报告被跳过的条数。
func TestRelayParseCandidates(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	raw := "No,Proxy IP,Port\n1,94.143.231.154,443\n2,[2606:4700::1]:443#LAX\n3.4.5.6\n"
	code, body := postJSON(t, base+"/api/relay/parse-candidates", cookie, map[string]any{"raw": raw})
	if code != http.StatusOK {
		t.Fatalf("解析候选失败：%d", code)
	}
	if body["count"] != float64(2) {
		t.Fatalf("应识别 2 个 IPv4，实际 %v", body["count"])
	}
	if body["skipped"] != float64(1) {
		t.Fatalf("应跳过 1 条非 IPv4，实际 %v", body["skipped"])
	}
}

// TestRelayFetchCandidatesRejectsInternal 远程导入必须拒绝本机 / 内网目标。
//
// 桌面版的面板跑在 127.0.0.1：放开这条就等于给了界面一个打本机服务的跳板。
func TestRelayFetchCandidatesRejectsInternal(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	for _, raw := range []string{
		"file:///etc/passwd",
		"http://127.0.0.1:8080/list.txt",
		"http://localhost/list.txt",
		"http://10.0.0.1/list.txt",
		"http://192.168.1.1/list.txt",
	} {
		code, body := postJSON(t, base+"/api/relay/fetch-candidates", cookie, map[string]any{"url": raw})
		if code != http.StatusOK {
			t.Fatalf("%s 应被拒绝但返回 %d", raw, code)
		}
		if body["ok"] != false {
			t.Fatalf("%s 不应被接受：%v", raw, body)
		}
	}
}

// TestRelayFetchCandidatesOK 正常链接返回原始文本与清洗结果。
func TestRelayFetchCandidatesOK(t *testing.T) {
	listener := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("1.2.3.4\n2606:4700::1\n"))
	}))
	defer listener.Close()

	// 测试机上的 httptest 只监听 127.0.0.1，会被「不放行内网目标」的守卫拦掉；
	// 这条用例要验的是拉取与清洗本身，因此临时替换守卫。
	oldGuard := relayFetchGuard
	relayFetchGuard = func(raw string) (*url.URL, error) { return url.Parse(raw) }
	defer func() { relayFetchGuard = oldGuard }()

	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/relay/fetch-candidates", cookie, map[string]any{"url": listener.URL})
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("应成功拉取：%d %v", code, body)
	}
	if body["count"] != float64(1) || body["skipped"] != float64(1) {
		t.Fatalf("应识别 1 个 IPv4 并跳过 1 个 IPv6：%v", body)
	}
}

// TestRelayRunValidation 参数不全时直接拒绝，不启动后台任务。
func TestRelayRunValidation(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	cases := []map[string]any{
		{"host": "", "wsPath": "/ws", "uuid": "u", "candidates": "1.2.3.4"},
		{"host": "data.example.com", "wsPath": "", "uuid": "u", "candidates": "1.2.3.4"},
		{"host": "data.example.com", "wsPath": "/ws", "uuid": "", "candidates": "1.2.3.4"},
		{"host": "data.example.com", "wsPath": "/ws", "uuid": "u", "candidates": ""},
		{"host": "data.example.com", "wsPath": "/ws", "uuid": "u", "candidates": "2606:4700::1"},
	}
	for _, req := range cases {
		code, body := postJSON(t, base+"/api/relay/run", cookie, req)
		if code != http.StatusOK || body["ok"] != false {
			t.Fatalf("应该拒绝：%v → %d %v", req, code, body)
		}
	}
}

// TestRelayRunRejectsConcurrent 同一时刻只允许一个反代体检。
func TestRelayRunRejectsConcurrent(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	s.relay.mu.Lock()
	s.relay.running = true
	s.relay.mu.Unlock()
	defer func() {
		s.relay.mu.Lock()
		s.relay.running = false
		s.relay.mu.Unlock()
	}()

	code, body := postJSON(t, base+"/api/relay/run", cookie, map[string]any{
		"host": "data.example.com", "wsPath": "/ws", "uuid": "u", "candidates": "1.2.3.4",
	})
	if code != http.StatusOK || body["ok"] != false {
		t.Fatalf("并发任务应被拒绝：%d %v", code, body)
	}
}

// TestSplitAndMergePool 增量语义：保留原有条目、去重、顺序稳定。
func TestSplitAndMergePool(t *testing.T) {
	existing := splitPool("1.1.1.1\n2.2.2.2, 3.3.3.3;4.4.4.4")
	if len(existing) != 4 {
		t.Fatalf("应拆出 4 条，实际 %v", existing)
	}
	merged := mergePool(existing, []string{"3.3.3.3", "5.5.5.5", " "})
	if len(merged) != 5 {
		t.Fatalf("增量合并后应为 5 条，实际 %v", merged)
	}
	if merged[0] != "1.1.1.1" || merged[4] != "5.5.5.5" {
		t.Fatalf("顺序应保持原有在前、新增在后：%v", merged)
	}
}

// TestValidatePublicURL 只放行公网 http/https。
func TestValidatePublicURL(t *testing.T) {
	if _, err := validatePublicURL("https://example.com/list.txt"); err != nil {
		t.Fatalf("公网链接应通过：%v", err)
	}
	for _, bad := range []string{"", "ftp://example.com/x", "http://127.0.0.1/x", "不是链接"} {
		if _, err := validatePublicURL(bad); err == nil {
			t.Fatalf("%q 应被拒绝", bad)
		}
	}
}
