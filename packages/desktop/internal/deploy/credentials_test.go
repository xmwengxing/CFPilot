package deploy

// 凭据沿用与面板路径格式的回归测试。
//
// ## 背景
//
// 三个连锁问题：
//
//  1. 更新部署后**面板密码被改**，用户进不去面板。
//     根因：部署时从不读 profile.PanelPassword，每次都随机生成新密码。
//
//  2. PANEL_PATH **丢了前导斜杠**（清单里是 `g8ih0p7amfsh`，
//     而 WS 路径是 `/fthiqeowoe`）。
//     根因：RandomPanelPath() 没加 "/"。
//
//  3. 部署成功后**不显示面板密码**，而云端环境变量是加密的，
//     用户彻底拿不到密码。
//     根因：Go 版缺少汇总输出（Electron 版一直有）。
//
// 本文件覆盖 1 和 2；3 由 TestLogSummary* 覆盖。

import (
	"strings"
	"testing"
)

// 面板路径必须带前导斜杠。
func TestRandomPanelPathHasLeadingSlash(t *testing.T) {
	for i := 0; i < 20; i++ {
		p := RandomPanelPath()
		if !strings.HasPrefix(p, "/") {
			t.Fatalf("面板路径必须带前导斜杠，实际 %q", p)
		}
		// 长度：斜杠 + 12 位
		if len(p) != 13 {
			t.Errorf("面板路径长度应为 13（/ + 12），实际 %d：%q", len(p), p)
		}
		// 斜杠后只能是字母数字
		for _, r := range p[1:] {
			isAlnum := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
			if !isAlnum {
				t.Errorf("面板路径含非法字符 %q：%q", r, p)
			}
		}
	}
}

// WS 路径同样必须带前导斜杠（与面板路径保持一致）。
func TestRandomWSPathHasLeadingSlash(t *testing.T) {
	for i := 0; i < 20; i++ {
		p := RandomWSPath()
		if !strings.HasPrefix(p, "/") {
			t.Fatalf("WS 路径必须带前导斜杠，实际 %q", p)
		}
	}
}

// 更新模式下，清单里的凭据必须被沿用（除非用户显式要求重新生成）。
func TestMergeCredentialsPreservesExisting(t *testing.T) {
	manifestCreds := Credentials{
		PanelPath:      "/keep-me-123",
		PanelPassword:  "KeepThisPassword",
		UUID:           "11111111-2222-3333-4444-555555555555",
		TrojanPassword: "KeepTrojanPw",
		WSPath:         "/keep-ws",
	}

	// 场景 A：本次没提供任何凭据（更新部署的常见情况）
	empty := effective{}
	got := mergeCredentials(empty, manifestCreds)

	if got.panelPath != manifestCreds.PanelPath {
		t.Errorf("面板路径应沿用清单：期望 %q，实际 %q", manifestCreds.PanelPath, got.panelPath)
	}
	if got.panelPassword != manifestCreds.PanelPassword {
		t.Errorf("⚠️ 面板密码必须沿用清单！期望 %q，实际 %q\n"+
			"   否则更新部署会把用户原密码覆盖掉，而云端变量加密后无法读回",
			manifestCreds.PanelPassword, got.panelPassword)
	}
	if got.uuid != manifestCreds.UUID {
		t.Errorf("UUID 应沿用清单，实际 %q", got.uuid)
	}
	if got.wsPath != manifestCreds.WSPath {
		t.Errorf("WS 路径应沿用清单，实际 %q", got.wsPath)
	}
	if got.trojanPassword != manifestCreds.TrojanPassword {
		t.Errorf("Trojan 密码应沿用清单，实际 %q", got.trojanPassword)
	}
}

// 用户显式填了新值时，必须用新值而不是清单里的旧值。
func TestMergeCredentialsPrefersUserInput(t *testing.T) {
	manifestCreds := Credentials{
		PanelPassword: "OldPassword",
		UUID:          "old-uuid",
		WSPath:        "/old-ws",
	}
	userInput := effective{
		panelPassword: "NewUserPassword",
	}

	got := mergeCredentials(userInput, manifestCreds)

	if got.panelPassword != "NewUserPassword" {
		t.Errorf("用户显式填的密码必须优先，实际 %q", got.panelPassword)
	}
	// 用户没提供的项仍要沿用
	if got.uuid != "old-uuid" {
		t.Errorf("用户没提供 UUID 时应沿用清单，实际 %q", got.uuid)
	}
}
