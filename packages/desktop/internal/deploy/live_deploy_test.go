package deploy

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/kernel"
)

// 真机部署测试：用真实账号和真实 KV 走完整流程。
func TestLiveDeploy(t *testing.T) {
	token := os.Getenv("CFPILOT_LIVE_TOKEN")
	account := os.Getenv("CFPILOT_LIVE_ACCOUNT")
	kv := os.Getenv("CFPILOT_LIVE_KV")
	if token == "" || account == "" || kv == "" {
		t.Skip("需要 CFPILOT_LIVE_TOKEN / CFPILOT_LIVE_ACCOUNT / CFPILOT_LIVE_KV")
	}

	k, err := kernel.Load()
	if err != nil {
		t.Fatalf("内核加载失败: %v", err)
	}
	t.Logf("内核来源: %s  control=%dKB data=%dKB build=%s",
		k.Source, len(k.Control)/1024, len(k.Data)/1024, k.Build)

	opt := DefaultOptions()
	opt.Token = token
	opt.AccountID = account
	opt.KVNamespaceID = kv
	opt.ControlScript = k.Control
	opt.DataScript = k.Data
	opt.LocalBuild = k.Build
	opt.Mode = "fresh"
	opt.SkipSameVersion = false
	// 用带时间戳的项目名，避免与已有项目冲突
	suffix := time.Now().Format("150405")
	opt.ControlProject = "cptestctl-" + suffix
	opt.DataProject = "cptestdata-" + suffix
	opt.WaitTimeout = 60 * time.Second
	opt.WaitInterval = 2 * time.Second
	opt.Log = func(m string) { t.Logf("  %s", m) }

	res, err := New(opt).Run(context.Background())
	if err != nil {
		t.Fatalf("部署失败: %v", err)
	}
	t.Logf("结果: control=%s data=%s", res.Control.Name, res.Data.Name)
	t.Logf("  controlSub=%s", res.Control.Subdomain)
	t.Logf("  dataSub=%s", res.Data.Subdomain)
	for _, w := range res.Warnings {
		t.Logf("  ⚠ %s", w)
	}
}
