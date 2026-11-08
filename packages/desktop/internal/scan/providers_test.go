package scan

// Phase 7 回归（FOFA 移除后）：schema v1→v2、RIPEstat Provider、
// API 源经 SyncSources 完整入池，以及「FOFA 已彻底移除」的回归断言。
//
// FOFA 曾短暂接入；真机验证免费账户 remain_api_query=0、查询返回
// [820031] F点余额不足，按用户裁决整体移除（含凭据层）。
// 网络层用自定义 http.Client.Transport 拦截：URL 仍是公网域名，
// SSRF / 重定向校验照常生效，但不真的发外网请求。

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func jsonOK(body string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}

func clientReturning(body string) *http.Client {
	return &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		return jsonOK(body), nil
	})}
}

func cleanProviderEnv(t *testing.T) {
	t.Helper()
	t.Setenv("CFPILOT_CONFIG_DIR", t.TempDir())
}

// ------------------------------------------------------------------
// schema 与「FOFA 已移除」
// ------------------------------------------------------------------

func TestParseSourcesV1Migration(t *testing.T) {
	cleanProviderEnv(t)
	raw := `{"schema":1,"updatedAt":1794000000000,"sources":[{` +
		`"id":"legacy","name":"legacy","type":"custom-url","url":"https://example.com/ips.txt",` +
		`"mirrors":[],"enabled":true,"intervalHours":24,"etag":"W/\"v1\"",` +
		`"lastModified":"","lastSyncAt":1794000000000,"lastError":"","failCount":0}],"runs":[]}`
	cfg := ParseSources(raw)
	if cfg.Schema != SourcesSchema || len(cfg.Sources) != 1 {
		t.Fatalf("v1 迁移失败：%+v", cfg)
	}
	if cfg.Sources[0].ETag != `W/"v1"` || cfg.Sources[0].LastSyncAt != 1794000000000 {
		t.Fatalf("迁移丢了历史字段：%+v", cfg.Sources[0])
	}
	if cfg.Sources[0].Query != "" || cfg.Sources[0].MaxResults != 200 {
		t.Fatalf("新字段没补齐：%+v", cfg.Sources[0])
	}
}

func TestOnlyRipeStatProviderRegistered(t *testing.T) {
	if len(ProviderSpecs) != 1 {
		t.Fatalf("应只注册 1 个 Provider，实际 %d：%v", len(ProviderSpecs), ProviderSpecs)
	}
	spec, ok := ProviderSpecs[SourceTypeRipeStat]
	if !ok || spec.RequiresKey {
		t.Fatal("ripe-stat 应存在且零 Key")
	}
	if DefaultProviderQuery(SourceTypeRipeStat) != "AS13335" {
		t.Fatal("默认 ASN 不对")
	}
	// FOFA 条目必须被配置校验与 Provider 同时拒绝
	fofa := MakeAPISource("fofa", "", "fofa", "", true, 24, 10)
	if IsAPISource(fofa) {
		t.Fatal("fofa 不该再被识别为 API 源")
	}
	if _, err := RunProvider(context.Background(), fofa, ProviderOptions{}); err == nil {
		t.Fatal("fofa 不该有可用 Provider")
	}
}

// ------------------------------------------------------------------
// RIPEstat
// ------------------------------------------------------------------

func TestRepresentativeIP(t *testing.T) {
	cases := map[string]string{
		"172.70.244.0/24":     "172.70.244.130",
		"2400:cb00:db65::/48": "2400:cb00:db65::1",
		"104.16.0.0/13":       "",
		"2606:4700::/32":      "",
		"not-a-cidr":          "",
	}
	for in, want := range cases {
		if got := RepresentativeIP(in); got != want {
			t.Errorf("RepresentativeIP(%q) = %q，期望 %q", in, got, want)
		}
	}
}

const ripePayload = `{"status":"ok","data":{"prefixes":[` +
	`{"prefix":"172.70.244.0/24"},{"prefix":"172.70.245.0/24"},` +
	`{"prefix":"104.16.5.0/24"},{"prefix":"2400:cb00:db65::/48"},` +
	`{"prefix":"8.8.8.0/24"}]}}`

func TestRipeStatProvider(t *testing.T) {
	cleanProviderEnv(t)
	var seenURL string
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		seenURL = r.URL.String()
		return jsonOK(ripePayload), nil
	})}
	s := MakeAPISource("ripe", "", SourceTypeRipeStat, "AS13335", true, 24, 10)
	res, err := RunProvider(context.Background(), s, ProviderOptions{Client: client})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(seenURL, "stat.ripe.net") || !strings.Contains(seenURL, "AS13335") {
		t.Fatalf("请求 URL 不对：%s", seenURL)
	}
	if res.UpstreamCount != 5 {
		t.Fatalf("上游计数不对：%d", res.UpstreamCount)
	}
	for _, c := range res.Candidates {
		if c.IP == "8.8.8.130" {
			t.Fatal("非 CF 段没被过滤")
		}
		if c.Port == nil || *c.Port != 443 {
			t.Fatalf("端口不对：%+v", c)
		}
	}
	if len(res.Candidates) == 0 || !strings.Contains(res.Note, "AS13335") {
		t.Fatalf("结果为空或 note 不对：%+v", res)
	}
}

func TestRipeStatProviderRejectsBadASN(t *testing.T) {
	cleanProviderEnv(t)
	s := MakeAPISource("ripe", "", SourceTypeRipeStat, "DROP TABLE", true, 24, 10)
	called := false
	client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		called = true
		return jsonOK("{}"), nil
	})}
	if _, err := RunProvider(context.Background(), s, ProviderOptions{Client: client}); err == nil {
		t.Fatal("非法 ASN 应报错")
	}
	if called {
		t.Fatal("非法 ASN 不该发请求")
	}
}

func TestSyncSourcesRipeStatIntegration(t *testing.T) {
	cleanProviderEnv(t)
	s := MakeAPISource("ripe", "", SourceTypeRipeStat, "AS13335", true, 24, 10)
	cfg := &SourcesFile{Schema: SourcesSchema, Sources: []SourceConfig{s}, Runs: []SyncRun{}}
	if err := SaveSources(cfg); err != nil {
		t.Fatal(err)
	}
	report := SyncSources(SyncOptions{
		Now:       sourcesNow,
		FetchOpts: SourceFetchOptions{Client: clientReturning(ripePayload)},
	})
	if len(report.Outcomes) != 1 || !report.Outcomes[0].OK {
		t.Fatalf("Provider 源同步失败：%+v", report.Outcomes)
	}
	pool := ParsePool(ReadPoolRaw())
	if len(pool.Candidates) == 0 {
		t.Fatal("候选没入池")
	}
	for _, c := range pool.Candidates {
		if len(c.Sources) != 1 || c.Sources[0] != "ripe" || c.Status != StatusPending {
			t.Fatalf("入池条目不对：%+v", c)
		}
	}
}
