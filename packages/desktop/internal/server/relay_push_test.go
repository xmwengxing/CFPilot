package server

// 反代优选结果写入**自定义反代入口池** —— 回归测试。
//
// ## 为什么钉住这个键
//
// 反代优选产出的是「第三方的反代服务器」，语义上属于反代入口池
// （`relayPool`）：目标解析到 Cloudflare 网段时靠它绕开 TCP Loop。
//
// 而 `proxyIp` 是另一回事：它是「配了 SOCKS5 / HTTP 落地代理」时的兜底入口。
// 写错池子的后果很隐蔽 —— 出站选路走的不是用户以为的那一路，
// 而且不会有任何报错。

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakePanelSession 假的「面板会话」：记录被写入的配置键与内容。
type fakePanelSession struct {
	cfg   map[string]any
	patch map[string]any
}

func (f *fakePanelSession) getConfig(_ context.Context) (map[string]any, error) {
	return f.cfg, nil
}

func (f *fakePanelSession) patchConfig(_ context.Context, patch map[string]any) (map[string]any, error) {
	f.patch = patch
	return patch, nil
}

// newRelayPushServer 起一个「已登录、已存 Token、已部署」的桌面服务：
//   - 面板会话换成假的（不真连控制面）；
//   - Cloudflare API 指向本地假服务器（清单从那里读）。
func newRelayPushServer(t *testing.T, fake *fakePanelSession) (*Server, string, *http.Cookie) {
	t.Helper()

	orig := openPanelSessionFn
	openPanelSessionFn = func(_ context.Context, _, _ string) (panelConfigClient, error) {
		return fake, nil
	}
	t.Cleanup(func() { openPanelSessionFn = orig })

	cf := newFakeCF()
	cf.accounts["cfat_test"] = []map[string]string{{"id": "acc-1", "name": "测试账号"}}
	cf.kv["ns-1"] = map[string]string{
		"CFP_DEPLOY_MANIFEST": manifestJSON("cpmanager", "panel-pw"),
	}
	cfServer := httptest.NewServer(cf.handler(t))
	t.Cleanup(cfServer.Close)

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
	return s, base, cookie
}

func TestRelayPushWritesRelayPool(t *testing.T) {
	fake := &fakePanelSession{cfg: map[string]any{}}
	_, base, cookie := newRelayPushServer(t, fake)

	code, body := postJSON(t, base+"/api/relay/push-results", cookie, map[string]any{
		"ips":  []string{"1.2.3.4:443", "5.6.7.8:443"},
		"mode": "overwrite",
	})
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d (%v)", code, body)
	}
	if body["ok"] != true {
		t.Fatalf("回填应成功：%v", body)
	}
	if fake.patch == nil {
		t.Fatal("应当写入面板配置")
	}
	// ⚠️ 必须是 relayPool，不是 proxyIp
	if _, ok := fake.patch["proxyIp"]; ok {
		t.Fatalf("不应写 proxyIp：%v", fake.patch)
	}
	got, ok := fake.patch["relayPool"].(string)
	if !ok {
		t.Fatalf("应写入 relayPool，实际 %v", fake.patch)
	}
	if got != "1.2.3.4:443\n5.6.7.8:443" {
		t.Errorf("反代入口池内容不对：%q", got)
	}
}

func TestRelayPushIncrementalKeepsExisting(t *testing.T) {
	fake := &fakePanelSession{cfg: map[string]any{"relayPool": "9.9.9.9:443"}}
	_, base, cookie := newRelayPushServer(t, fake)

	code, body := postJSON(t, base+"/api/relay/push-results", cookie, map[string]any{
		"ips":  []string{"1.2.3.4:443"},
		"mode": "incremental",
	})
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("应成功：code=%d body=%v", code, body)
	}
	got, _ := fake.patch["relayPool"].(string)
	if got != "9.9.9.9:443\n1.2.3.4:443" {
		t.Errorf("增量应保留原有条目，实际 %q", got)
	}
}
