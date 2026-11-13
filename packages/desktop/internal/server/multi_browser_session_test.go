package server

import (
	"net/http"
	"testing"
	"time"
)

// 不同浏览器的 Cookie 必须独立，后建立的会话不得覆盖先前会话。
func TestMultipleBrowserSessionsRemainValid(t *testing.T) {
	s, base := newTestServer(t)
	boot := s.BootToken()
	var cookies []*http.Cookie
	for i := 0; i < 2; i++ {
		res, err := http.Get(base + "/__session?t=" + boot)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("浏览器 %d 换取会话：%d", i, res.StatusCode)
		}
		var cookie *http.Cookie
		for _, c := range res.Cookies() {
			if c.Name == SessionCookie {
				cookie = c
			}
		}
		if cookie == nil {
			t.Fatal("缺少会话 Cookie")
		}
		cookies = append(cookies, cookie)
	}
	if cookies[0].Value == cookies[1].Value {
		t.Fatal("浏览器会话必须独立")
	}
	for _, cookie := range cookies {
		if code := doGet(t, base+"/api/service/status", map[string]string{"Cookie": cookie.String()}); code != http.StatusOK {
			t.Fatalf("已建立会话应有效：%d", code)
		}
	}
	s.mu.Lock()
	s.sessions[cookies[0].Value] = time.Now().Add(-time.Second)
	s.mu.Unlock()
	if code := doGet(t, base+"/api/service/status", map[string]string{"Cookie": cookies[0].String()}); code != http.StatusUnauthorized {
		t.Fatalf("服务端过期应拒绝：%d", code)
	}
	if code := doGet(t, base+"/api/service/status", map[string]string{"Cookie": cookies[1].String()}); code != http.StatusOK {
		t.Fatalf("一个会话过期不得影响另一会话：%d", code)
	}
}
