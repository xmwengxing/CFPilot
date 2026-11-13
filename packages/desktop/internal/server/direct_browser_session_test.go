package server

import (
	"net/http"
	"testing"
)

// 直接输入本地地址的浏览器没有 ?t=，首页下发 BootCookie 后也必须能建立会话。
func TestDirectBrowserAddressCanEstablishSession(t *testing.T) {
	_, base := newTestServer(t)
	client := &http.Client{}
	res, err := client.Get(base + "/")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("首页应 200，实际 %d", res.StatusCode)
	}
	boot := ""
	for _, c := range res.Cookies() {
		if c.Name == BootCookie {
			boot = c.Value
		}
	}
	if boot == "" {
		t.Fatal("首页应下发短期引导 Cookie")
	}
	req, err := http.NewRequest(http.MethodGet, base+"/__session", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: BootCookie, Value: boot})
	session, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = session.Body.Close()
	if session.StatusCode != http.StatusOK {
		t.Fatalf("直接地址换取会话应 200，实际 %d", session.StatusCode)
	}
	var cookie *http.Cookie
	for _, c := range session.Cookies() {
		if c.Name == SessionCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("应返回 API 会话 Cookie")
	}
	if code := doGet(t, base+"/api/service/status", map[string]string{"Cookie": cookie.String()}); code != http.StatusOK {
		t.Fatalf("新会话应可访问 API：%d", code)
	}
}
