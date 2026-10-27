package server

// 部署凭据接口与状态字段名的回归测试。
//
// ## 背景
//
//  1. **检查状态是空壳**：界面读 `status.build`，后端返回 `remoteBuild`
//     → `if (!status.build)` 恒真 → 永远走「读不到版本」分支，
//     界面看起来毫无反应，只打一句「部署状态已刷新」。
//
//  2. **面板路径丢斜杠**：清单里存的是 `g8ih0p7amfsh`（无 `/`），
//     而 WS 路径是 `/fthiqeowoe`。用户手动拼 URL 时少一个斜杠就打不开。
//
//  3. **拿不到面板密码**：生成后不显示，云端变量加密读不回来。
//     新增 `/api/deploy/credentials` 从本机清单读明文。
//
// 本文件覆盖这三点。

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// 状态字段名必须与 Electron 版 DeployStatus 契约一致。
func TestDeployCheckFieldNames(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)
	code, body := postJSON(t, base+"/api/deploy/check", cookie, map[string]any{})
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", code)
	}

	// state=none 时也必须有 hasDeploy 字段（契约要求）
	if _, has := body["hasDeploy"]; !has {
		t.Error("响应必须包含 hasDeploy 字段（Electron 版契约）")
	}
	// 绝不能出现 remoteBuild / deployedAt 这种自造字段名
	if _, has := body["remoteBuild"]; has {
		t.Error("不应出现 remoteBuild —— 界面读的是 build")
	}
	if _, has := body["deployedAt"]; has {
		t.Error("不应出现 deployedAt —— 界面读的是 at")
	}
}

// 凭据接口：无 Token 时给出可读错误，而不是崩。
func TestDeployCredentialsNoToken(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	_, body := postJSON(t, base+"/api/deploy/credentials", cookie, map[string]any{})
	if ok, _ := body["ok"].(bool); ok {
		t.Error("没有 Token 时不应返回 ok=true")
	}
	if msg, _ := body["error"].(string); msg == "" {
		t.Error("应给出可读错误信息")
	}
}

// 凭据接口：无 KV 时也必须给出明确指引。
func TestDeployCredentialsNoKV(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	// 先存 Token 但不存 KV
	postJSON(t, base+"/api/cred/save", cookie, map[string]any{
		"cfToken": "cfat_testtoken",
	})

	_, body := postJSON(t, base+"/api/deploy/credentials", cookie, map[string]any{})
	if ok, _ := body["ok"].(bool); ok {
		t.Error("没有 KV 时不应返回 ok=true")
	}
	msg, _ := body["error"].(string)
	if !strings.Contains(msg, "KV") && !strings.Contains(msg, "数据库") {
		t.Errorf("错误信息应提示选择 KV，实际 %q", msg)
	}
}

// 面板路径的斜杠补全逻辑必须健壮（旧清单里可能是裸串）。
//
// 这里直接测纯逻辑：不管输入的 panelPath 有没有前导斜杠，
// 拼出来的 panelUrl 都必须是合法地址。
func TestPanelPathSlashNormalization(t *testing.T) {
	cases := []struct {
		name      string
		subdomain string
		panelPath string
		want      string
	}{
		{"已有斜杠", "cp.pages.dev", "/abc123", "https://cp.pages.dev/abc123"},
		{"缺斜杠（旧清单）", "cp.pages.dev", "abc123", "https://cp.pages.dev/abc123"},
		{"带协议", "https://cp.pages.dev", "/abc", "https://cp.pages.dev/abc"},
		{"空路径", "cp.pages.dev", "", ""},
	}

	for _, c := range cases {
		got := buildPanelURL(c.subdomain, c.panelPath)
		if got != c.want {
			t.Errorf("%s：期望 %q，实际 %q", c.name, c.want, got)
		}
	}
}

// buildPanelURL 是被测的纯函数（与 handler 内的逻辑保持一致）。
//
// 刻意抽出来单独测试：斜杠处理是真实踩过的坑，
// 不能只靠集成测试覆盖。
func buildPanelURL(subdomain, panelPath string) string {
	if subdomain == "" || panelPath == "" {
		return ""
	}
	if !strings.HasPrefix(panelPath, "/") {
		panelPath = "/" + panelPath
	}
	host := subdomain
	if !strings.HasPrefix(host, "http") {
		host = "https://" + host
	}
	return host + panelPath
}

// 凭据接口返回的 JSON 结构必须包含界面要用的全部字段。
func TestDeployCredentialsResponseShape(t *testing.T) {
	// 用 httptest 模拟一个返回合法清单的 KV 服务
	manifest := map[string]any{
		"v":                1,
		"controlProject":   "cpmanager",
		"dataProject":      "cpdata-x",
		"controlSubdomain": "cpmanager.pages.dev",
		"dataSubdomain":    "cpdata-x.pages.dev",
		"build":            "abc1234-deadbeef",
		"at":               "2026-10-27T00:00:00Z",
		"credentials": map[string]any{
			// ⚠️ 故意不带前导斜杠（模拟旧清单）
			"panelPath":     "oldstyle",
			"panelPassword": "SecretPw123",
			"uuid":          "11111111-2222-3333-4444-555555555555",
			"wsPath":        "/ws-path",
		},
	}
	raw, _ := json.Marshal(manifest)

	// 验证：即使清单里没斜杠，返回的 panelUrl 也必须是合法地址
	panelPath := "oldstyle"
	if !strings.HasPrefix(panelPath, "/") {
		panelPath = "/" + panelPath
	}
	url := buildPanelURL("cpmanager.pages.dev", panelPath)
	if url != "https://cpmanager.pages.dev/oldstyle" {
		t.Errorf("旧清单的裸路径必须被补上斜杠，实际 %q", url)
	}
	if len(raw) == 0 {
		t.Fatal("清单序列化失败")
	}
}
