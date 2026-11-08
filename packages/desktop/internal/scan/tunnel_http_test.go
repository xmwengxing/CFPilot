package scan

import (
	"net/http"
	"testing"
)

// 判定优先级对照 CLI website-compatibility：挑战头 → 403 → 429 → 非 2xx →
// 压缩/超限 → 挑战正文 → 正文标记 → ok。
func TestClassifyTunnelResponsePriorities(t *testing.T) {
	mk := func(status int, headers map[string]string, body string) TunnelWebsiteResult {
		h := http.Header{}
		for k, v := range headers {
			h.Set(k, v)
		}
		return classifyTunnelResponse(status, h, []byte(body), "")
	}
	if got := mk(200, map[string]string{"Cf-Mitigated": "challenge"}, ""); got.Status != "challenge" || !got.ChallengeHeader {
		t.Fatalf("挑战头应优先: %+v", got)
	}
	if got := mk(403, nil, ""); got.Status != "forbidden" {
		t.Fatalf("403 应为 forbidden: %+v", got)
	}
	if got := mk(429, nil, ""); got.Status != "rate_limited" {
		t.Fatalf("429 应为 rate_limited: %+v", got)
	}
	if got := mk(302, nil, ""); got.Status != "http_error" {
		t.Fatalf("重定向不跟随应为 http_error: %+v", got)
	}
	if got := mk(200, map[string]string{"Content-Encoding": "gzip"}, "x"); got.Status != "invalid_response" {
		t.Fatalf("压缩内容应为 invalid_response: %+v", got)
	}
	if got := mk(200, map[string]string{"Content-Type": "text/html"}, `<script src="/cdn-cgi/challenge-platform/x.js">`); got.Status != "challenge" {
		t.Fatalf("挑战正文应为 challenge: %+v", got)
	}
	if got := mk(200, map[string]string{"Content-Type": "text/plain"}, "hello"); got.Status != "ok" {
		t.Fatalf("普通 2xx 应为 ok: %+v", got)
	}
	// 正文标记不匹配 → invalid_response 且 expectedContentOk=false。
	h := http.Header{}
	got := classifyTunnelResponse(200, h, []byte("something else"), "ready")
	if got.Status != "invalid_response" || got.ExpectedContentOK == nil || *got.ExpectedContentOK {
		t.Fatalf("正文标记不匹配应为 invalid_response: %+v", got)
	}
}

func TestValidateTunnelTargetRejectsLocal(t *testing.T) {
	for _, bad := range []TunnelWebsiteTarget{
		{Host: "127.0.0.1", Port: 80, Path: "/"},
		{Host: "192.168.1.1", Port: 80, Path: "/"},
		{Host: "localhost", Port: 80, Path: "/"},
		{Host: "example.com", Port: 443, Path: "no-slash"},
		{Host: "example.com", Port: 0, Path: "/"},
	} {
		if err := validateTunnelTarget(bad); err == nil {
			t.Fatalf("应拒绝: %+v", bad)
		}
	}
	if err := validateTunnelTarget(TunnelWebsiteTarget{Host: "example.com", Port: 443, Path: "/"}); err != nil {
		t.Fatalf("公网域名应放行: %v", err)
	}
}
