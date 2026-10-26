package deploy

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/kernel"
)

// 端到端：首次部署 → 更新部署，验证凭据沿用。
func TestE2ECredentialPersistence(t *testing.T) {
	token := os.Getenv("CFPILOT_LIVE_TOKEN")
	account := os.Getenv("CFPILOT_LIVE_ACCOUNT")
	kv := os.Getenv("CFPILOT_LIVE_KV")
	if token == "" || account == "" || kv == "" {
		t.Skip("需要环境变量")
	}

	k, err := kernel.Load()
	if err != nil {
		t.Fatal(err)
	}
	suffix := time.Now().Format("150405")

	mk := func(mode string) *Result {
		opt := DefaultOptions()
		opt.Token = token
		opt.AccountID = account
		opt.KVNamespaceID = kv
		opt.ControlScript = k.Control
		opt.DataScript = k.Data
		opt.LocalBuild = k.Build
		opt.Mode = mode
		opt.SkipSameVersion = false
		opt.ControlProject = "e2ectl-" + suffix
		opt.DataProject = "e2edata-" + suffix
		opt.WaitTimeout = 90 * time.Second
		opt.WaitInterval = 2 * time.Second
		opt.Log = func(m string) { t.Logf("  %s", m) }

		res, err := New(opt).Run(context.Background())
		if err != nil {
			t.Fatalf("%s 部署失败: %v", mode, err)
		}
		return res
	}

	t.Log("========== 首次部署 ==========")
	first := mk("fresh")
	t.Logf("面板路径: %q", first.PanelPath)
	t.Logf("面板密码: %q", first.PanelPassword)
	t.Logf("WS 路径:  %q", first.WSPath)

	// ---- 断言 1：面板路径必须带前导斜杠 ----
	if len(first.PanelPath) == 0 || first.PanelPath[0] != '/' {
		t.Errorf("❌ 面板路径必须带前导斜杠，实际 %q", first.PanelPath)
	}

	// ---- 断言 2：首次部署必须生成密码并返回 ----
	if first.PanelPassword == "" {
		t.Fatal("❌ 首次部署必须返回面板密码")
	}

	t.Log("========== 更新部署（不提供任何凭据）==========")
	second := mk("auto")
	t.Logf("面板路径: %q", second.PanelPath)
	t.Logf("面板密码: %q", second.PanelPassword)
	t.Logf("WS 路径:  %q", second.WSPath)

	// ---- 断言 3：更新部署必须沿用原密码 ----
	if second.PanelPassword != first.PanelPassword {
		t.Errorf("❌ 更新部署改了面板密码！原 %q → 现 %q\n"+
			"   用户会因此进不去面板（云端变量加密，读不回来）",
			first.PanelPassword, second.PanelPassword)
	}
	if second.PanelPath != first.PanelPath {
		t.Errorf("❌ 更新部署改了面板路径：原 %q → 现 %q", first.PanelPath, second.PanelPath)
	}
	if second.WSPath != first.WSPath {
		t.Errorf("❌ 更新部署改了 WS 路径：原 %q → 现 %q", first.WSPath, second.WSPath)
	}
	if second.UUID != first.UUID {
		t.Errorf("❌ 更新部署改了 UUID：原 %q → 现 %q", first.UUID, second.UUID)
	}
}
