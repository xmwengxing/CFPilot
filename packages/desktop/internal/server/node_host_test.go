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
	// pagesMissing 里的项目返回 404（模拟改名 / 删除 / 读不到）
	pagesMissing map[string]bool
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
			if f.pagesMissing[name] {
				w.WriteHeader(http.StatusNotFound)
				_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "errors": []map[string]any{{"code": 8000007, "message": "project not found"}}})
				return
			}
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

// 控制面形态：绑了自定义域名就必须用它。
//
// 真机故障（2026-11-25）：双 Pages 模式、控制面绑了自定义域名，
// 但回填仍打 `*.pages.dev`，而该域名在本机网络下 TLS 握手超时 ——
// 用户看到的是「覆盖回填失败：Post ... TLS handshake timeout」。
func TestResolveControlHostPrefersCustomDomain(t *testing.T) {
	fake := &nodeHostFake{pagesDomains: map[string][]string{
		"cpmanager": {"cp.example.com", "cpmanager.pages.dev"},
	}}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()

	s, _ := newTestServer(t)
	s.SetCFAPIBase(srv.URL)

	m := &deploy.Manifest{
		ControlProject:   "cpmanager",
		ControlSubdomain: "cpmanager.pages.dev",
	}
	res := s.resolveControlHost(context.Background(), s.newCFClient("tok"), "acc1", m)
	if res.Host != "cp.example.com" {
		t.Errorf("控制面应优先用自定义域名，实际 %q", res.Host)
	}
	if !strings.Contains(res.Source, "自定义域名") {
		t.Errorf("来源应写明自定义域名，实际 %q", res.Source)
	}
}

// 没有自定义域名 → 回落 pages.dev（此时页面要能解释为什么回填失败）。
func TestResolveControlHostFallsBackToPagesDev(t *testing.T) {
	fake := &nodeHostFake{pagesDomains: map[string][]string{
		"cpmanager": {"cpmanager.pages.dev"},
	}}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()

	s, _ := newTestServer(t)
	s.SetCFAPIBase(srv.URL)

	m := &deploy.Manifest{ControlProject: "cpmanager", ControlSubdomain: "cpmanager.pages.dev"}
	res := s.resolveControlHost(context.Background(), s.newCFClient("tok"), "acc1", m)
	if res.Host != "cpmanager.pages.dev" {
		t.Errorf("没有自定义域名时应回落到 pages.dev，实际 %q", res.Host)
	}
}

// 读不到控制面项目 → 回落清单值，但必须带 warning（不能静默）。
func TestResolveControlHostWarnsWhenProjectUnreadable(t *testing.T) {
	fake := &nodeHostFake{pagesMissing: map[string]bool{"gone": true}}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()

	s, _ := newTestServer(t)
	s.SetCFAPIBase(srv.URL)

	m := &deploy.Manifest{ControlProject: "gone", ControlSubdomain: "cpmanager.pages.dev"}
	res := s.resolveControlHost(context.Background(), s.newCFClient("tok"), "acc1", m)
	if res.Host != "cpmanager.pages.dev" {
		t.Errorf("应回落到清单里的控制面域名，实际 %q", res.Host)
	}
	if res.Warning == "" {
		t.Error("读不到项目绑定时必须给出说明（否则用户无从判断为什么没用自定义域名）")
	}
}

// 数据面项目能读到、但确实没有自定义域名 → 说明「没绑」，而不是静默。
func TestResolveNodeHostPagesWarnsWhenNoCustomDomain(t *testing.T) {
	fake := &nodeHostFake{pagesDomains: map[string][]string{
		"mydata": {"mydata.pages.dev"},
	}}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()

	s, _ := newTestServer(t)
	s.SetCFAPIBase(srv.URL)

	m := manifestFor("mydata", "pages", "", "mydata.pages.dev")
	res := s.resolveNodeHost(context.Background(), s.newCFClient("tok"), "acc1", m)
	if res.Host != "mydata.pages.dev" {
		t.Errorf("应回落到 pages.dev，实际 %q", res.Host)
	}
	if res.Warning == "" {
		t.Error("项目没有绑定自定义域名时必须说明（否则用户以为自动识别坏了）")
	}
}

// 端到端：回填路径（resolvePanelAccess）必须解析到控制面自定义域名。
//
// 这一条覆盖用户看到的现象：界面上的「自动识别」给的是数据面域名，
// 而回填打的是控制面 —— 两者都必须是平台绑定优先，否则 pages.dev
// 在部分网络会被 TLS 握手超时挡住（真机 2026-11-25）。
func TestResolvePanelAccessUsesControlCustomDomain(t *testing.T) {
	cf := newFakeCF()
	cf.accounts["cfat_test"] = []map[string]string{{"id": "acc-1", "name": "测试账号"}}
	cf.kv["ns-1"] = map[string]string{deploy.ManifestKey: manifestJSON("cpmanager", "panel-pw")}
	cf.pagesDomains["cpmanager"] = []string{"cp.example.com", "cpmanager.pages.dev"}
	cfServer := httptest.NewServer(cf.handler(t))
	defer cfServer.Close()

	st := newEmptyStore(t)
	patch := patchTokenAndAccount("cfat_test", "acc-1")
	ns := "ns-1"
	patch.KVNamespaceID = &ns
	if _, err := st.SaveActive(patch); err != nil {
		t.Fatalf("保存 Token 失败：%v", err)
	}

	s, _ := newTestServer(t)
	s.SetStore(st)
	s.SetCFAPIBase(cfServer.URL)

	profile, err := st.Active()
	if err != nil || profile == nil {
		t.Fatalf("读取当前账户失败：%v", err)
	}
	m, host, pw := s.resolvePanelAccess(context.Background(), profile)
	if m == nil {
		t.Fatal("应读到部署清单")
	}
	if host != "cp.example.com" {
		t.Errorf("回填目标应是控制面自定义域名，实际 %q", host)
	}
	if pw != "panel-pw" {
		t.Errorf("面板密码应来自清单，实际 %q", pw)
	}
}

// 数据面绑了自定义域名、控制面没绑 → 识别结果要提醒「回填走的是控制面」。
//
// 用户的真实困惑：他在数据面上绑好自定义域名，以为回填也会走它；
// 实际回填与面板登录只能打控制面，于是打到 pages.dev，
// 在部分网络下直接 TLS 握手超时。
func TestDetectHostWarnsWhenControlPlaneLacksCustomDomain(t *testing.T) {
	cf := newFakeCF()
	cf.accounts["cfat_test"] = []map[string]string{{"id": "acc-1", "name": "测试账号"}}
	cf.kv["ns-1"] = map[string]string{deploy.ManifestKey: manifestJSON("cpmanager", "panel-pw")}
	cf.pagesDomains["cpmanager-data"] = []string{"cp.example.com", "cpmanager-data.pages.dev"}
	cfServer := httptest.NewServer(cf.handler(t))
	defer cfServer.Close()

	st := newEmptyStore(t)
	patch := patchTokenAndAccount("cfat_test", "acc-1")
	ns := "ns-1"
	patch.KVNamespaceID = &ns
	if _, err := st.SaveActive(patch); err != nil {
		t.Fatalf("保存 Token 失败：%v", err)
	}

	s, base := newTestServer(t)
	s.SetStore(st)
	s.SetCFAPIBase(cfServer.URL)
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/scan/detect-host", cookie, map[string]any{})
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d（%v）", code, body)
	}
	if got := str(body["host"]); got != "cp.example.com" {
		t.Errorf("识别到的应是数据面自定义域名，实际 %q", got)
	}
	if !strings.Contains(str(body["warning"]), "控制面") {
		t.Errorf("应提醒回填走控制面且那边还没绑域名，实际 %q", str(body["warning"]))
	}
}
