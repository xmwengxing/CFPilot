package server

// 会话建立流程的端到端测试。
//
// ## 为什么单独写这个文件（2026-10-26 真实故障复盘）
//
// 最初的实现里，**前端从来没有调用过 `/__session`**：
// 欢迎 URL 带 `?t=令牌` 打开界面，但没有任何代码用这个令牌换 Cookie，
// 于是所有 `/api/*` 请求都是 401，用户点「添加并保存」直接报
// 「未授权：请从托盘菜单打开界面」。
//
// 为什么之前的测试没发现？
//   - 我用 curl / Invoke-WebRequest 测时**手动调了 `/__session`**，
//     所以接口测试全过
//   - 典型的「测试用手动步骤掩盖了真实缺陷」
//   - 只有真实浏览器打开界面才暴露
//
// 因此这里模拟**浏览器的完整动作序列**：
//   1. 打开欢迎 URL（带 ?t=）
//   2. 页面里的 JS 调 /__session 换 Cookie
//   3. 带着 Cookie 调各种 API
//
// 这样能覆盖「前端忘了换会话」这类集成缺陷。

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// 完整流程：欢迎 URL → 换会话 → 带 Cookie 调 API。
//
// 这是最贴近真实浏览器的一条路径，任何一环断掉都会 401。
func TestSessionFlowFullPath(t *testing.T) {
	// assets 是构建中间物（不入库），CI 刚 clone 时不存在 → 跳过而不是失败
	if _, err := embeddedFS.ReadFile("assets/index.html"); err != nil {
		t.Skip("界面资源尚未构建（先跑 node scripts/build-desktop.mjs）")
	}

	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))

	// ---- 1. 打开欢迎 URL（浏览器地址栏的动作）----
	// 服务端返回 index.html，其中含 adapter.js 的 script 标签
	res, err := http.Get(base + "/?t=" + s.BootToken())
	if err != nil {
		t.Fatal(err)
	}
	// 必须完整读取：index.html 有 37KB，单次 Read 可能读不全，
	// 导致「script 标签在后面」时误判成缺失（我踩过这个坑）。
	htmlBytes, err := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if err != nil {
		t.Fatal(err)
	}

	html := string(htmlBytes)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("欢迎页应 200，实际 %d", res.StatusCode)
	}
	// 关键断言：页面必须引用 adapter.js —— 它负责换会话
	if !strings.Contains(html, "adapter.js") {
		t.Fatalf("欢迎页没有引用 adapter.js，前端无法建立会话（页面 %d 字节）", len(html))
	}

	// ---- 2. 前端换会话（adapter.js 的动作）----
	sessionRes, err := http.Get(base + "/__session?t=" + s.BootToken())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sessionRes.Body.Close() }()

	if sessionRes.StatusCode != http.StatusOK {
		t.Fatalf("换会话应 200，实际 %d", sessionRes.StatusCode)
	}

	var cookie *http.Cookie
	for _, c := range sessionRes.Cookies() {
		if c.Name == SessionCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("换会话没有返回 Cookie")
	}

	// ---- 3. 带 Cookie 调各种 API（界面初始化时全部会调）----
	apis := []struct {
		name   string
		method string
		path   string
	}{
		{"账户列表", http.MethodGet, "/api/profile/list"},
		{"凭据状态", http.MethodGet, "/api/cred/state"},
		{"国家列表", http.MethodGet, "/api/scan/countries"},
		{"服务状态", http.MethodGet, "/api/service/status"},
		{"KV 列表", http.MethodPost, "/api/kv/list"},
		{"部署状态", http.MethodPost, "/api/deploy/check"},
	}

	for _, api := range apis {
		req, err := http.NewRequest(api.method, base+api.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(cookie)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Errorf("%s 请求失败：%v", api.name, err)
			continue
		}
		code := res.StatusCode
		_ = res.Body.Close()
		// 允许 400（参数不足），但**绝不允许 401**
		if code == http.StatusUnauthorized {
			t.Errorf("%s 在有会话的情况下仍然 401 —— 会话机制失效", api.name)
		}
	}
}

// Cookie 必须是 Lax 而不是 Strict。
//
// Strict 会让「从地址栏粘贴 URL 打开」这类场景在部分浏览器上不带 Cookie，
// 表现为会话建立了但后续 API 全 401。
func TestSessionCookieSameSite(t *testing.T) {
	s, base := newTestServer(t)

	res, err := http.Get(base + "/__session?t=" + s.BootToken())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()

	var cookie *http.Cookie
	for _, c := range res.Cookies() {
		if c.Name == SessionCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("没有会话 Cookie")
	}
	if cookie.SameSite == http.SameSiteStrictMode {
		t.Error("会话 Cookie 不应用 SameSite=Strict（会让地址栏直接打开时丢 Cookie），应为 Lax")
	}
	if !cookie.HttpOnly {
		t.Error("会话 Cookie 必须是 HttpOnly")
	}
}

// 错误令牌不能换到会话（安全底线）。
func TestSessionRejectsInvalidToken(t *testing.T) {
	_, base := newTestServer(t)

	for _, token := range []string{"", "wrong", "0000000000000000"} {
		res, err := http.Get(base + "/__session?t=" + token)
		if err != nil {
			t.Fatal(err)
		}
		code := res.StatusCode
		_ = res.Body.Close()
		if code == http.StatusOK {
			t.Errorf("令牌 %q 不该换到会话", token)
		}
	}
}

// 前端产物里必须真的有「调用 /__session」的代码。
//
// 这条断言直接盯住当初的缺陷：JS 里不能只有欢迎 URL 而忘了换会话。
func TestAdapterContainsSessionExchange(t *testing.T) {
	// 读内嵌的 adapter.js
	raw, err := embeddedFS.ReadFile("assets/adapter.js")
	if err != nil {
		t.Skip("adapter.js 尚未构建（先跑 node scripts/build-desktop.mjs）")
	}
	src := string(raw)

	if !strings.Contains(src, "/__session") {
		t.Fatal("adapter.js 里没有调用 /__session —— 前端不会建立会话，所有 API 都会 401")
	}
	if !strings.Contains(src, "location.search") {
		t.Error("adapter.js 没有从 URL 读取启动令牌（location.search）")
	}
	// 必须等会话建立后再发 API 请求
	if !strings.Contains(src, "sessionReady") {
		t.Error("adapter.js 没有 sessionReady 机制 —— API 请求可能在会话建立前发出")
	}
}
