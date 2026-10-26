package deploy

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
)

// 真机：找出孤儿项目（只读，不删）。
func TestLiveFindOrphans(t *testing.T) {
	token := os.Getenv("CFPILOT_LIVE_TOKEN")
	account := os.Getenv("CFPILOT_LIVE_ACCOUNT")
	kv := os.Getenv("CFPILOT_LIVE_KV")
	if token == "" || account == "" {
		t.Skip("需要 CFPILOT_LIVE_TOKEN / CFPILOT_LIVE_ACCOUNT")
	}

	d := &Deployer{
		client: cfapi.New(cfapi.Options{Token: token}),
		opt:    Options{AccountID: account, KVNamespaceID: kv, Log: func(string) {}},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// 1. 从清单里读出正在使用的项目
	active := map[string]bool{}
	if kv != "" {
		if m, err := d.readManifest(ctx); err == nil && m != nil {
			active[m.ControlProject] = true
			active[m.DataProject] = true
			t.Logf("清单里的活跃项目：control=%s data=%s", m.ControlProject, m.DataProject)
		}
	}
	if len(active) == 0 {
		t.Log("清单为空，无法确定活跃项目 —— 跳过（避免误删）")
		return
	}

	// 2. 以前缀找孤儿
	prefixes := []string{}
	for name := range active {
		if name != "" {
			prefixes = append(prefixes, name)
		}
	}
	orphans, err := d.FindOrphans(ctx, active, prefixes)
	if err != nil {
		t.Fatalf("查找失败：%v", err)
	}

	t.Logf("发现 %d 个疑似孤儿项目：", len(orphans))
	for _, o := range orphans {
		t.Logf("  %-28s  %s  (%s)", o.Name, o.Reason, o.Created)
	}
}

// 真机：删除孤儿项目。需显式设置 CFPILOT_DELETE_ORPHANS=1 才会真的删。
func TestLiveDeleteOrphans(t *testing.T) {
	if os.Getenv("CFPILOT_DELETE_ORPHANS") != "1" {
		t.Skip("需设置 CFPILOT_DELETE_ORPHANS=1 才会真的删除")
	}
	token := os.Getenv("CFPILOT_LIVE_TOKEN")
	account := os.Getenv("CFPILOT_LIVE_ACCOUNT")
	kv := os.Getenv("CFPILOT_LIVE_KV")
	if token == "" || account == "" || kv == "" {
		t.Skip("需要完整的环境变量")
	}

	d := &Deployer{
		client: cfapi.New(cfapi.Options{Token: token}),
		opt:    Options{AccountID: account, KVNamespaceID: kv, Log: func(string) {}},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()

	m, err := d.readManifest(ctx)
	if err != nil || m == nil {
		t.Skip("读不到清单，拒绝删除（避免误删）")
	}
	active := map[string]bool{m.ControlProject: true, m.DataProject: true}

	orphans, err := d.FindOrphans(ctx, active, []string{m.ControlProject, m.DataProject})
	if err != nil {
		t.Fatal(err)
	}
	if len(orphans) == 0 {
		t.Log("没有孤儿项目")
		return
	}

	names := make([]string, 0, len(orphans))
	for _, o := range orphans {
		names = append(names, o.Name)
	}
	deleted, failed := d.DeleteOrphans(ctx, names, func(s string) { t.Logf("  %s", s) })
	t.Logf("删除成功 %d 个，失败 %d 个", len(deleted), len(failed))
}
