package server

// 「面板请求代理」设置的读写。
//
// 这条设置存在的理由：回填与面板登录要访问用户自己的控制面域名，
// 而它常是 `*.pages.dev` —— 部分网络下直连会被阻断。
// 桌面版拿不到用户 shell 的环境变量，系统代理又可能没开
// （TUN 模式、或客户端只监听本地端口），于是需要一个显式输入。

import (
	"net/http"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

// 用临时 HOME 隔离：保存设置会写 desktop.json，绝不能碰到真实用户目录。
func withTempHome(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("USERPROFILE", dir) // Windows
	t.Setenv("HOME", dir)        // Linux / macOS
	t.Cleanup(func() { scan.SetPanelProxy("") })
}

// 保存后要能立刻生效，并回读到「当前实际会用的来源」。
func TestPanelProxySaveAndClear(t *testing.T) {
	withTempHome(t)

	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	// 初始：没设置
	code, body := getJSON(t, base+"/api/panel-proxy", cookie)
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("读取应 200 且 ok，实际 %d（%v）", code, body)
	}
	if str(body["proxy"]) != "" {
		t.Errorf("初始应为空，实际 %q", str(body["proxy"]))
	}

	// 保存（省略协议，后端补 http://）
	code, body = postJSON(t, base+"/api/panel-proxy", cookie, map[string]any{
		"proxy": "127.0.0.1:7890",
	})
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("保存应成功，实际 %d（%v）", code, body)
	}
	if got := str(body["proxy"]); got != "http://127.0.0.1:7890" {
		t.Errorf("应归一化出协议，实际 %q", got)
	}
	if got := str(body["effective"]); got != "设置里的代理 http://127.0.0.1:7890" {
		t.Errorf("实际生效来源应指向设置值，实际 %q", got)
	}

	// 立即生效（不需要重启）：scan 包拿到的就是它
	manual, _ := scan.PanelProxyStatus()
	if manual != "http://127.0.0.1:7890" {
		t.Errorf("scan 应立即用上新值，实际 %q", manual)
	}

	// 重新读一次也能拿到（写进了 desktop.json）
	code, body = getJSON(t, base+"/api/panel-proxy", cookie)
	if code != http.StatusOK || str(body["proxy"]) != "http://127.0.0.1:7890" {
		t.Errorf("回读应得到已保存的值，实际 %d（%v）", code, body)
	}

	// 清空 → 回到自动
	code, body = postJSON(t, base+"/api/panel-proxy", cookie, map[string]any{"proxy": ""})
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("清空应成功，实际 %d（%v）", code, body)
	}
	if got := str(body["proxy"]); got != "" {
		t.Errorf("清空后应为空，实际 %q", got)
	}
	if manual, _ := scan.PanelProxyStatus(); manual != "" {
		t.Errorf("清空后 scan 不应再有值，实际 %q", manual)
	}
}

// 不支持的协议要在保存时就被拒绝，而不是等到请求时静默失败。
func TestPanelProxyRejectsUnsupportedScheme(t *testing.T) {
	withTempHome(t)

	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/panel-proxy", cookie, map[string]any{
		"proxy": "ss://YWVzOnB3@1.2.3.4:8388",
	})
	if code != http.StatusOK {
		t.Fatalf("应 200 + ok:false（界面按 ok 判断），实际 %d", code)
	}
	if body["ok"] != false {
		t.Fatal("不支持的协议必须拒绝")
	}
	if str(body["error"]) == "" {
		t.Error("应说明为什么不接受")
	}
	// 不能被写进设置
	if st, err := config.LoadSettings(); err == nil && st.PanelProxy != "" {
		t.Errorf("拒绝的值不该落盘，实际 %q", st.PanelProxy)
	}
}
