package server

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
)

// newTestServer 起一个监听随机端口的服务实例。
func newTestServer(t *testing.T) (*Server, string) {
	t.Helper()

	// 找一个空闲端口
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()

	settings := config.DefaultSettings()
	settings.Port = port

	s, err := New(settings)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start(); err != nil {
		t.Fatalf("启动失败：%v", err)
	}
	t.Cleanup(func() { _ = s.Stop() })

	return s, "http://127.0.0.1:" + strconv.Itoa(port)
}

func doGet(t *testing.T, url string, hdr map[string]string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range hdr {
		// Host 是 Go 的**特殊头**：不能走 Header.Set，
		// 必须赋给 req.Host，否则会被忽略、发出去用的还是 URL 里的 Host。
		// 早期测试就是踩了这个坑，导致「Host 校验」看起来通过、实际没被测到。
		if http.CanonicalHeaderKey(k) == "Host" {
			req.Host = v
			continue
		}
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败 %s：%v", url, err)
	}
	defer func() { _ = res.Body.Close() }()
	return res.StatusCode
}

// 未带会话 Cookie 调 API 必须 401。
func TestAPIRRequiresSession(t *testing.T) {
	_, base := newTestServer(t)
	if code := doGet(t, base+"/api/service/status", nil); code != http.StatusUnauthorized {
		t.Errorf("应 401，实际 %d", code)
	}
}

// 错误的启动令牌换不到会话。
func TestSessionRejectsWrongToken(t *testing.T) {
	_, base := newTestServer(t)
	if code := doGet(t, base+"/__session?t=wrong", nil); code != http.StatusForbidden {
		t.Errorf("应 403，实际 %d", code)
	}
}

// 正确令牌能换到 HttpOnly 会话 Cookie。
func TestSessionExchangeHappyPath(t *testing.T) {
	s, base := newTestServer(t)

	res, err := http.Get(base + "/__session?t=" + s.BootToken())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("应 200，实际 %d", res.StatusCode)
	}
	var found *http.Cookie
	for _, c := range res.Cookies() {
		if c.Name == SessionCookie {
			found = c
		}
	}
	if found == nil {
		t.Fatalf("未找到 %s Cookie", SessionCookie)
	}
	if !found.HttpOnly {
		t.Error("会话 Cookie 必须是 HttpOnly")
	}
	// 2026-10-26 从 Strict 改为 Lax：
	// Strict 在「地址栏直接粘贴 URL 打开」等场景下会导致浏览器不回传 Cookie，
	// 表现为会话建立了但 API 全 401。Lax 仍阻止跨站 POST，安全性等价。
	if found.SameSite == http.SameSiteStrictMode {
		t.Error("会话 Cookie 不应是 SameSite=Strict（会丢 Cookie），应为 Lax")
	}

	// 带 Cookie 再调 API 应该通过
	req, _ := http.NewRequest(http.MethodGet, base+"/api/service/status", nil)
	req.AddCookie(found)
	res2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res2.Body.Close() }()
	if res2.StatusCode != http.StatusOK {
		t.Errorf("带会话调 API 应 200，实际 %d", res2.StatusCode)
	}

	var body map[string]any
	if err := json.NewDecoder(res2.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["running"] != true {
		t.Errorf("running 应为 true，实际 %v", body["running"])
	}
	if body["host"] != "127.0.0.1" {
		t.Errorf("host 应回环，实际 %v", body["host"])
	}
}

// DNS Rebinding 防护：Host 头不是回环就拒绝。
func TestRejectsNonLoopbackHost(t *testing.T) {
	_, base := newTestServer(t)

	for _, host := range []string{"evil.com", "example.com:19726", "192.168.1.1:19726"} {
		if code := doGet(t, base+"/", map[string]string{"Host": host}); code != http.StatusForbidden {
			t.Errorf("Host=%q 应 403，实际 %d", host, code)
		}
	}
	// 回环 Host 正常
	for _, host := range []string{"127.0.0.1", "localhost"} {
		if code := doGet(t, base+"/", map[string]string{"Host": host}); code != http.StatusOK {
			t.Errorf("Host=%q 应 200，实际 %d", host, code)
		}
	}
}

// 跨站 Origin 必须拒绝（防恶意网页打本地端口）。
func TestRejectsCrossSiteOrigin(t *testing.T) {
	_, base := newTestServer(t)

	if code := doGet(t, base+"/", map[string]string{"Origin": "https://evil.com"}); code != http.StatusForbidden {
		t.Errorf("跨站 Origin 应 403，实际 %d", code)
	}
	if code := doGet(t, base+"/", map[string]string{"Origin": "null"}); code != http.StatusForbidden {
		t.Errorf("Origin=null 应 403，实际 %d", code)
	}
}

// 内嵌界面必须能取到，否则浏览器打开是空白页。
//
// 注意：assets/ 里的 index.html / renderer.js 是构建中间产物，
// 不入库（见 assets/README.md）。CI 上刚 clone 下来时它们不存在，
// 只有走完 scripts/build-desktop.mjs 才会有 —— 那种情况下本测试跳过，
// 而不是判失败，否则每次新建 clone 跑测试都会红。
func TestServesEmbeddedUI(t *testing.T) {
	if _, err := embeddedFS.ReadFile("assets/index.html"); err != nil {
		t.Skip("界面资源尚未构建（缺 assets/index.html），跳过。先执行 npm run build -w @cfpilot/gui")
	}

	_, base := newTestServer(t)

	for _, p := range []string{"/", "/index.html", "/renderer.js"} {
		if code := doGet(t, base+p, nil); code != http.StatusOK {
			t.Errorf("%s 应 200，实际 %d", p, code)
		}
	}
}

// 非法端口要 400，且服务不能被搞坏。
func TestPortValidation(t *testing.T) {
	s, base := newTestServer(t)
	cookie := loginCookie(t, s, base)

	for _, port := range []int{0, -1, 65536, 99999} {
		code, body := postJSON(t, base+"/api/service/port", cookie, map[string]any{"port": port})
		if code != http.StatusBadRequest {
			t.Errorf("端口 %d 应 400，实际 %d (%s)", port, code, body)
		}
	}
	// 服务仍应存活
	if code := doGet(t, base+"/api/service/status", nil); code != http.StatusUnauthorized {
		t.Errorf("服务状态应以 401 响应未授权而不是崩溃，实际 %d", code)
	}
}

// 端口未变化时直接返回成功提示。
func TestPortUnchangedIsNoop(t *testing.T) {
	s, base := newTestServer(t)
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/service/port", cookie, map[string]any{"port": s.Settings().Port})
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d (%s)", code, body)
	}
	if body["note"] != "端口未变化" {
		t.Errorf("应提示端口未变化，实际 %v", body["note"])
	}
}

// 换端口失败（目标被占用）时要回滚，服务保持可用。
func TestPortChangeRollsBackWhenOccupied(t *testing.T) {
	s, base := newTestServer(t)
	cookie := loginCookie(t, s, base)

	// 占住一个端口
	blocker, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Close() }()
	busyPort := blocker.Addr().(*net.TCPAddr).Port

	code, body := postJSON(t, base+"/api/service/port", cookie, map[string]any{"port": busyPort})
	if code != http.StatusBadRequest {
		t.Fatalf("被占用的端口应 400，实际 %d (%s)", code, body)
	}
	// 原端口必须还在服务
	if code := doGet(t, base+"/", nil); code != http.StatusOK {
		t.Errorf("换端口失败后原端口应仍可用，实际 %d", code)
	}
}

// ---------- 测试辅助 ----------

func loginCookie(t *testing.T, s *Server, base string) *http.Cookie {
	t.Helper()
	res, err := http.Get(base + "/__session?t=" + s.BootToken())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	for _, c := range res.Cookies() {
		if c.Name == SessionCookie {
			return c
		}
	}
	t.Fatal("换会话失败")
	return nil
}

func postJSON(t *testing.T, url string, cookie *http.Cookie, payload map[string]any) (int, map[string]any) {
	t.Helper()
	buf, _ := json.Marshal(payload)
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(buf))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败：%v", err)
	}
	defer func() { _ = res.Body.Close() }()
	var body map[string]any
	_ = json.NewDecoder(res.Body).Decode(&body)
	return res.StatusCode, body
}
