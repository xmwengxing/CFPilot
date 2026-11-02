package server

// 节点域名的权威解析（真机事故 2026-11-02 的回归测试）。
//
// 事故：部署清单里的 dataCustomDomain 被写成了**另一个账号**的域名，
// 「检查部署状态」照着清单回填输入框 → 用户看不出填错 → 更新部署又写坏一次。
//
// 修复：节点域名一律**以平台上的真实绑定为准**，清单只作参考；
// 两者不一致时顺手把清单修正，让它自愈。

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/deploy"
)

// nodeHostFake 是节点域名解析用的假 Cloudflare API。
type nodeHostFake struct {
	// domains 是账号下的 Worker 自定义域名绑定
	domains []map[string]any
	// subdomain 是账号的 workers.dev 子域（空 = 没注册）
	subdomain string
	// pagesDomains 是 Pages 项目名 → 它实际绑定的域名
	pagesDomains map[string][]string
}

// handler 返回假 API 的处理器。
func (f *nodeHostFake) handler(t *testing.T) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/workers/domains"):
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": f.domains})
		case strings.HasSuffix(r.URL.Path, "/workers/subdomain"):
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": map[string]any{"subdomain": f.subdomain}})
		case strings.Contains(r.URL.Path, "/pages/projects/"):
			name := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
			domains := f.pagesDomains[name]
			if domains == nil {
				domains = []string{name + ".pages.dev"}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": map[string]any{
				"name": name, "subdomain": name + ".pages.dev", "domains": domains,
			}})
		default:
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "errors": []map[string]any{{"code": 10404, "message": "No route"}}})
		}
	}
}

// manifestFor 造一份部署清单。
func manifestFor(dataProject, mode, customDomain, dataSubdomain string) *deploy.Manifest {
	return &deploy.Manifest{
		DataProject:      dataProject,
		DataPlaneMode:    mode,
		DataCustomDomain: customDomain,
		DataSubdomain:    dataSubdomain,
	}
}

// resolveNodeHostPrefersLiveBinding：清单被写脏时，必须以平台真实绑定为准。
func TestResolveNodeHostPrefersLiveBinding(t *testing.T) {
	fake := &nodeHostFake{domains: []map[string]any{
		{"id": "d1", "hostname": "data.shijingtian.dpdns.org", "service": "aytwi20y", "enabled": true},
	}}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()

	s, _ := newTestServer(t)
	s.SetCFAPIBase(srv.URL)

	m := manifestFor("aytwi20y", "workers", "cp.dongyao.dpdns.org", "")
	res := s.resolveNodeHost(context.Background(), s.newCFClient("tok"), "acc1", m)

	if res.Host != "data.shijingtian.dpdns.org" {
		t.Errorf("应取平台上真实绑定的域名，实际 %q", res.Host)
	}
	if !res.Stale {
		t.Error("清单与平台不一致时应标记为过期")
	}
	if res.ManifestValue != "cp.dongyao.dpdns.org" {
		t.Errorf("应保留清单里的原值用于提示，实际 %q", res.ManifestValue)
	}
}

// 没有绑定自定义域名 → 回落到 workers.dev 生产域名。
func TestResolveNodeHostFallsBackToWorkersDev(t *testing.T) {
	fake := &nodeHostFake{subdomain: "acctsub"}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()

	s, _ := newTestServer(t)
	s.SetCFAPIBase(srv.URL)

	m := manifestFor("aytwi20y", "workers", "", "")
	res := s.resolveNodeHost(context.Background(), s.newCFClient("tok"), "acc1", m)

	if !strings.Contains(res.Host, "workers.dev") {
		t.Errorf("应回落到 workers.dev，实际 %q", res.Host)
	}
	if !strings.Contains(res.Source, "workers.dev") {
		t.Errorf("来源说明应写明是兜底，实际 %q", res.Source)
	}
}

// 账号没注册 workers.dev 子域 → 读不到，给出提示而不是瞎填。
func TestResolveNodeHostWarnsWhenUnreadable(t *testing.T) {
	fake := &nodeHostFake{}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()

	s, _ := newTestServer(t)
	s.SetCFAPIBase(srv.URL)

	m := manifestFor("aytwi20y", "workers", "", "")
	res := s.resolveNodeHost(context.Background(), s.newCFClient("tok"), "acc1", m)

	if res.Host != "" {
		t.Errorf("读不到时不应瞎填，实际 %q", res.Host)
	}
	if res.Warning == "" {
		t.Error("读不到时必须给出提示")
	}
}

// Pages 形态：优先项目实际绑定的自定义域名，其次 pages.dev 子域名。
func TestResolveNodeHostPages(t *testing.T) {
	fake := &nodeHostFake{pagesDomains: map[string][]string{
		"mydata": {"cp.example.com", "mydata.pages.dev"},
	}}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()

	s, _ := newTestServer(t)
	s.SetCFAPIBase(srv.URL)

	m := manifestFor("mydata", "pages", "cp.dongyao.dpdns.org", "mydata.pages.dev")
	res := s.resolveNodeHost(context.Background(), s.newCFClient("tok"), "acc1", m)
	if res.Host != "cp.example.com" {
		t.Errorf("Pages 应优先用项目实际绑定的域名，实际 %q", res.Host)
	}
	if !res.Stale {
		t.Error("清单与平台不一致时应标记为过期")
	}

	fake.pagesDomains["mydata"] = []string{"mydata.pages.dev"}
	m = manifestFor("mydata", "pages", "", "mydata.pages.dev")
	res = s.resolveNodeHost(context.Background(), s.newCFClient("tok"), "acc1", m)
	if res.Host != "mydata.pages.dev" {
		t.Errorf("没有自定义域名时应回落到 pages.dev 子域名，实际 %q", res.Host)
	}
}
