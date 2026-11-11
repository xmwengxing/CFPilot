package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// TestApiFailureIsLogged 接口失败必须写进日志。
//
// ## 为什么这条很重要
//
// 用户反馈的典型症状是「点了按钮没反应，日志里什么都没有」。
// 根因是**两层都不出声**：
//   - 服务端：接口出错只回一个带 error 的 JSON，不写日志；
//   - 界面：按钮的处理函数没接住异常，Promise 拒绝被静默吞掉。
//
// 服务端这一层由 logApiFailures 兜底：任何 /api/ 请求返回 4xx/5xx
// 都记一条日志，带上具体原因。
//
// 没有这条，用户就只能来问「是不是坏了」—— 而日志里什么都没有。
func TestApiFailureIsLogged(t *testing.T) {
	srv, base := newTestServer(t)
	testBootToken = srv.BootToken()
	srv.SetStore(newEmptyStore(t))

	ch := srv.events.subscribe()
	defer srv.events.unsubscribe(ch)

	// 更新一个不存在的账户 → 400
	req := httptest.NewRequest(http.MethodPost, "/api/profile/update",
		strings.NewReader(`{"id":"acc_not_exists","cfToken":"x"}`))
	req.RemoteAddr = "127.0.0.1:1234"
	req.Host = "127.0.0.1:19726"
	addSession(t, base, req)
	rec := httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("期望 400，实际 %d", rec.Code)
	}

	got := waitForLog(t, ch)
	if !strings.Contains(got, "/api/profile/update") {
		t.Fatalf("日志里没有接口路径：%s", got)
	}
	if !strings.Contains(got, "400") {
		t.Fatalf("日志里没有状态码：%s", got)
	}
}

// TestApiSuccessNotLogged 成功请求不该刷错误日志。
func TestApiSuccessNotLogged(t *testing.T) {
	srv, base := newTestServer(t)
	testBootToken = srv.BootToken()
	srv.SetStore(newEmptyStore(t))

	ch := srv.events.subscribe()
	defer srv.events.unsubscribe(ch)

	req := httptest.NewRequest(http.MethodPost, "/api/profile/create",
		strings.NewReader(`{"name":"测试账户"}`))
	req.RemoteAddr = "127.0.0.1:1234"
	req.Host = "127.0.0.1:19726"
	addSession(t, base, req)
	rec := httptest.NewRecorder()
	srv.routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", rec.Code)
	}

	select {
	case msg := <-ch:
		t.Fatalf("成功请求不该记错误日志，却收到：%s", string(msg.data))
	default:
	}
}

// testBootToken 是当前测试服务器的启动令牌。
var testBootToken string

// addSession 给请求带上会话 Cookie（guard 要求）。
//
// 走真实的会话交换（/__session）—— 与浏览器打开面板时的路径一致。
func addSession(t *testing.T, base string, req *http.Request) {
	t.Helper()
	res, err := http.Get(base + "/__session?t=" + url.QueryEscape(testBootToken))
	if err != nil {
		t.Fatalf("换取会话失败：%v", err)
	}
	defer res.Body.Close()
	for _, c := range res.Cookies() {
		if c.Name == SessionCookie {
			req.AddCookie(c)
			return
		}
	}
	t.Fatal("没拿到会话 Cookie")
}

// waitForLog 等一条日志事件。
func waitForLog(t *testing.T, ch chan sseMessage) string {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case msg := <-ch:
			if msg.event != "log" {
				continue
			}
			var entry LogEntry
			if err := json.Unmarshal(msg.data, &entry); err == nil {
				return entry.Message
			}
		case <-deadline:
			t.Fatalf("接口失败了但日志里没有任何记录")
			return ""
		}
	}
}
