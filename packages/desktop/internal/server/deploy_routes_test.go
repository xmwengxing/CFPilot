package server

// 部署 API 与 SSE 的测试。
//
// 重点验证：
//   - SSE 连接能建立、能收到事件、能正常断开
//   - 慢客户端不会阻塞广播（这是 eventBus 设计的核心）
//   - 部署接口的前置校验（缺 Token / 缺账号 / 缺 KV）
//   - 版本端点的响应解析（两种形态）
//   - 版本串提取（含「绝不返回 unknown」）

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// ---------- SSE ----------

// SSE 连接能建立并收到 hello 事件。
func TestSSEConnectAndHello(t *testing.T) {
	s, base := newTestServer(t)
	cookie := loginCookie(t, s, base)

	req, _ := http.NewRequest(http.MethodGet, base+"/api/events", nil)
	req.AddCookie(cookie)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req = req.WithContext(ctx)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()

	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("Content-Type 应为 text/event-stream，实际 %q", ct)
	}
	if cc := res.Header.Get("Cache-Control"); !strings.Contains(cc, "no-cache") {
		t.Errorf("Cache-Control 应含 no-cache，实际 %q", cc)
	}

	// 读第一帧：应是 hello
	line := readSSEEvent(t, res, 2*time.Second)
	if !strings.Contains(line, "event: hello") {
		t.Errorf("第一帧应是 hello，实际 %q", line)
	}
}

// 广播的事件能被已连接的客户端收到。
func TestSSEReceiveBroadcast(t *testing.T) {
	s, base := newTestServer(t)
	cookie := loginCookie(t, s, base)

	req, _ := http.NewRequest(http.MethodGet, base+"/api/events", nil)
	req.AddCookie(cookie)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req = req.WithContext(ctx)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()

	// 等 hello
	readSSEEvent(t, res, 2*time.Second)

	// 等订阅者注册完成（handleEvents 里 hello 之后才 subscribe）
	deadline := time.Now().Add(time.Second)
	for s.events.SubscriberCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if s.events.SubscriberCount() == 0 {
		t.Fatal("订阅者未注册")
	}

	// 广播一条日志
	s.logLevel("测试日志消息", "ok")

	// 应能读到
	got := readSSEEvent(t, res, 2*time.Second)
	if !strings.Contains(got, "event: log") {
		t.Errorf("应为 log 事件，实际 %q", got)
	}
	if !strings.Contains(got, "测试日志消息") {
		t.Errorf("应含日志内容，实际 %q", got)
	}
}

// 客户端断开后订阅者要被清理（否则内存泄漏）。
func TestSSECleanupOnDisconnect(t *testing.T) {
	s, base := newTestServer(t)
	cookie := loginCookie(t, s, base)

	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequest(http.MethodGet, base+"/api/events", nil)
	req.AddCookie(cookie)
	req = req.WithContext(ctx)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}

	readSSEEvent(t, res, 2*time.Second)

	deadline := time.Now().Add(time.Second)
	for s.events.SubscriberCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if s.events.SubscriberCount() != 1 {
		t.Fatalf("应有 1 个订阅者，实际 %d", s.events.SubscriberCount())
	}

	// 断开
	cancel()
	_ = res.Body.Close()

	// 应被清理
	deadline = time.Now().Add(2 * time.Second)
	for s.events.SubscriberCount() > 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := s.events.SubscriberCount(); n != 0 {
		t.Errorf("断开后订阅者应清零，实际 %d", n)
	}
}

// SSE 未登录必须 401。
func TestSSERequiresSession(t *testing.T) {
	_, base := newTestServer(t)
	if code := doGet(t, base+"/api/events", nil); code != http.StatusUnauthorized {
		t.Errorf("未登录应 401，实际 %d", code)
	}
}

// 慢客户端（不读 body）不能阻塞广播。
//
// 这是 eventBus 的核心设计：每个订阅者有独立缓冲，
// 满了就丢该条消息，绝不阻塞发布方。
func TestEventBusSlowSubscriberDoesNotBlock(t *testing.T) {
	bus := newEventBus()

	// 造一个「从不读取」的订阅者
	slow := bus.subscribe()
	_ = slow // 故意不读

	// 第二个正常订阅者
	normal := bus.subscribe()

	// 广播 200 条（远超 64 的缓冲）
	done := make(chan struct{})
	go func() {
		for i := 0; i < 200; i++ {
			bus.publish("log", map[string]any{"message": "x", "i": i})
		}
		close(done)
	}()

	select {
	case <-done:
		// 正常完成，没被慢客户端卡住
	case <-time.After(2 * time.Second):
		t.Fatal("广播被慢客户端阻塞了 —— 一个卡住的浏览器会拖死整个服务")
	}

	// 正常订阅者应至少收到一批（缓冲 64，能收到前 64 条）
	received := 0
loop:
	for {
		select {
		case <-normal:
			received++
		default:
			break loop
		}
	}
	if received == 0 {
		t.Error("正常订阅者应收到消息")
	}
	if received > 64 {
		t.Errorf("缓冲应为 64，实际收到 %d", received)
	}

	bus.unsubscribe(slow)
	bus.unsubscribe(normal)
}

// ---------- 部署接口前置校验 ----------

// 缺凭据时部署接口要给出明确提示，而不是启动一个注定失败的任务。
func TestDeployRunMissingCredentials(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/deploy/run", cookie, map[string]any{})
	if code != http.StatusBadRequest {
		t.Fatalf("缺凭据应 400，实际 %d (%v)", code, body)
	}
	if !strings.Contains(str(body["error"]), "凭据") {
		t.Errorf("错误信息应提到凭据，实际 %v", body["error"])
	}
}

// 有 Token 但缺账号 ID → 提示去检测账号。
func TestDeployRunMissingAccount(t *testing.T) {
	s, base := newTestServer(t)
	st := newEmptyStore(t)
	tok := "cfat_x"
	if _, err := st.Create("a", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SaveActive(patchToken(tok)); err != nil {
		t.Fatal(err)
	}
	s.SetStore(st)
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/deploy/run", cookie, map[string]any{})
	if code != http.StatusBadRequest {
		t.Fatalf("缺账号应 400，实际 %d (%v)", code, body)
	}
	if !strings.Contains(str(body["error"]), "账号") {
		t.Errorf("错误信息应提到账号，实际 %v", body["error"])
	}
}

// 有账号但缺 KV → 提示去选 KV。
func TestDeployRunMissingKV(t *testing.T) {
	s, base := newTestServer(t)
	st := newEmptyStore(t)
	if _, err := st.Create("a", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SaveActive(patchTokenAndAccount("cfat_x", "acc123")); err != nil {
		t.Fatal(err)
	}
	s.SetStore(st)
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/deploy/run", cookie, map[string]any{})
	if code != http.StatusBadRequest {
		t.Fatalf("缺 KV 应 400，实际 %d (%v)", code, body)
	}
	if !strings.Contains(str(body["error"]), "KV") {
		t.Errorf("错误信息应提到 KV，实际 %v", body["error"])
	}
}

// 部署接口只接受 POST。
func TestDeployRunRejectsGET(t *testing.T) {
	s, base := newTestServer(t)
	cookie := loginCookie(t, s, base)
	if code := doGetWithCookie(t, base+"/api/deploy/run", cookie); code != http.StatusMethodNotAllowed {
		t.Errorf("GET 应 405，实际 %d", code)
	}
}

// 检查部署状态：缺 KV 时返回 reason=no-kv（不是报错）。
func TestDeployCheckReasons(t *testing.T) {
	s, base := newTestServer(t)
	st := newEmptyStore(t)
	s.SetStore(st)
	cookie := loginCookie(t, s, base)

	// 完全没凭据
	code, body := postJSON(t, base+"/api/deploy/check", cookie, map[string]any{})
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", code)
	}
	if body["state"] != "none" || body["reason"] != "no-token" {
		t.Errorf("缺 Token 应返回 none/no-token，实际 %v", body)
	}

	// 有 Token 无账号
	if _, err := st.Create("a", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SaveActive(patchToken("cfat_x")); err != nil {
		t.Fatal(err)
	}
	_, body = postJSON(t, base+"/api/deploy/check", cookie, map[string]any{})
	if body["reason"] != "no-account" {
		t.Errorf("缺账号应返回 no-account，实际 %v", body)
	}

	// 有账号无 KV
	if _, err := st.SaveActive(patchTokenAndAccount("cfat_x", "acc123")); err != nil {
		t.Fatal(err)
	}
	_, body = postJSON(t, base+"/api/deploy/check", cookie, map[string]any{})
	if body["reason"] != "no-kv" {
		t.Errorf("缺 KV 应返回 no-kv，实际 %v", body)
	}
}

// 账号检测：没 Token 时给出提示。
func TestAccountDetectMissingToken(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/account/detect", cookie, map[string]any{})
	if code != http.StatusBadRequest {
		t.Fatalf("应 400，实际 %d", code)
	}
	if !strings.Contains(str(body["error"]), "Token") {
		t.Errorf("应提示填 Token，实际 %v", body["error"])
	}
}

// ---------- 版本解析 ----------

func TestParseVersionBody(t *testing.T) {
	cases := []struct {
		name        string
		body        string
		wantBuild   string
		wantVersion string
	}{
		{
			name:        "真实响应：build 是指纹、version 是语义版本",
			body:        `{"build":"a946dfa-1f2e3d4c","version":"0.12.5","ts":1}`,
			wantBuild:   "a946dfa-1f2e3d4c",
			wantVersion: "0.12.5",
		},
		{
			// ⚠️ 这条是回归用例：早期实现「优先取 version」，把语义版本当成
			// 构建指纹去比对，导致任何可达的数据面都显示「建议更新」。
			name:        "build 与 version 同时存在时不能被搞混",
			body:        `{"version":"0.12.5","build":"a946dfa-1f2e3d4c"}`,
			wantBuild:   "a946dfa-1f2e3d4c",
			wantVersion: "0.12.5",
		},
		{"只有 version", `{"version":"0.12.5"}`, "", "0.12.5"},
		{"只有 build", `{"build":"a946dfa-1f2e3d4c"}`, "a946dfa-1f2e3d4c", ""},
		{"纯文本当 build", "a946dfa-1f2e3d4c\n", "a946dfa-1f2e3d4c", ""},
		{"纯文本带 CRLF", "a946dfa-1f2e3d4c\r\nextra", "a946dfa-1f2e3d4c", ""},
		{"空响应", "", "", ""},
		{"JSON 无版本字段", `{"ok":true}`, "", ""},
		{"HTML 片段不当版本", "<!DOCTYPE html>", "", ""},
		{"超长文本不当版本", strings.Repeat("a", 100), "", ""},
	}
	for _, tc := range cases {
		got := parseVersionBody([]byte(tc.body))
		if got.Build != tc.wantBuild || got.Version != tc.wantVersion {
			t.Errorf("%s：期望 build=%q version=%q，实际 build=%q version=%q",
				tc.name, tc.wantBuild, tc.wantVersion, got.Build, got.Version)
		}
	}
}

// 版本串提取：新格式 / 旧格式 / 找不到。
func TestExtractBuildVersion(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want string
	}{
		{"新格式 hash", `const BUILD_VERSION = "a946dfa-1f2e3d4c";`, "a946dfa-1f2e3d4c"},
		{"新格式 数字后缀", `const BUILD_VERSION = "a946dfa-202610251200";`, "a946dfa-202610251200"},
		{"旧纯数字格式", `const BUILD_VERSION = "202610251200";`, "202610251200"},
		{"单引号", `var v = 'a946dfa-1f2e3d4c'`, "a946dfa-1f2e3d4c"},
		{"找不到", `console.log("hello")`, ""},
		{"绝不能返回 unknown", `const BUILD_VERSION = "unknown";`, ""},
	}
	for _, tc := range cases {
		got := extractBuildVersion(tc.src)
		if got != tc.want {
			t.Errorf("%s：期望 %q，实际 %q", tc.name, tc.want, got)
		}
	}
}

// ---------- 测试辅助 ----------

// readSSEEvent 读一帧 SSE 事件（到空行为止）。
func readSSEEvent(t *testing.T, res *http.Response, timeout time.Duration) string {
	t.Helper()

	type result struct {
		text string
		err  error
	}
	ch := make(chan result, 1)

	go func() {
		sc := bufio.NewScanner(res.Body)
		var sb strings.Builder
		for sc.Scan() {
			line := sc.Text()
			if line == "" {
				if sb.Len() > 0 {
					ch <- result{text: sb.String()}
					return
				}
				continue
			}
			// 跳过心跳注释（除非已经攒了内容）
			if strings.HasPrefix(line, ":") && sb.Len() == 0 {
				continue
			}
			sb.WriteString(line)
			sb.WriteString("\n")
		}
		ch <- result{err: sc.Err()}
	}()

	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatalf("读 SSE 失败：%v", r.err)
		}
		return r.text
	case <-time.After(timeout):
		t.Fatal("读 SSE 超时")
		return ""
	}
}

// str 把 any 转成字符串（用于断言包含关系）。
func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	b, _ := json.Marshal(v)
	return string(b)
}
