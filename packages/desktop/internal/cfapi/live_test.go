package cfapi

// 真机集成测试。
//
// ## 为什么需要
//
// mock 测试只能证明「我照着 TS 抄对了」，证明不了「Cloudflare 认这套请求」。
// 真实 API 的契约细节（multipart 字段名、metadata 结构、域名子接口路径）
// 只有真机才能验证。
//
// ## 怎么运行
//
// 需要显式设置环境变量才跑，避免 CI 上误用真实凭据：
//
//	CFPILOT_LIVE_TOKEN=cfat_xxx \
//	CFPILOT_LIVE_ACCOUNT=70ec011b... \
//	go test ./internal/cfapi/ -run TestLive -v
//
// 未设置时自动跳过。
//
// ## 安全约束
//
// 这里**只做只读操作**（列账号 / 列 KV / 列项目 / 校验 Token），
// 绝不在这里创建或删除任何资源。写操作的验证留给手工步骤。

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func liveClient(t *testing.T) (*Client, string) {
	t.Helper()
	token := strings.TrimSpace(os.Getenv("CFPILOT_LIVE_TOKEN"))
	if token == "" {
		t.Skip("未设置 CFPILOT_LIVE_TOKEN，跳过真机测试")
	}
	account := strings.TrimSpace(os.Getenv("CFPILOT_LIVE_ACCOUNT"))
	return New(Options{Token: token, TimeoutMs: 20000}), account
}

// 真机：Token 能通过校验。
func TestLiveVerifyToken(t *testing.T) {
	c, account := liveClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	r, err := c.VerifyToken(ctx, account)
	if err != nil {
		t.Fatalf("Token 校验失败：%v", err)
	}
	if r.Status != "active" {
		t.Errorf("Token 状态应为 active，实际 %q", r.Status)
	}
	t.Logf("Token 状态：%s", r.Status)
}

// 真机：能列出账号，且返回的 ID 是 32 位十六进制。
func TestLiveListAccounts(t *testing.T) {
	c, account := liveClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	accounts, err := c.ListAccounts(ctx)
	if err != nil {
		t.Fatalf("列账号失败：%v", err)
	}
	if len(accounts) == 0 {
		t.Fatal("账号列表为空")
	}
	t.Logf("共 %d 个账号", len(accounts))

	found := false
	for _, a := range accounts {
		t.Logf("  %s  %s", a.ID, a.Name)
		if a.ID == account {
			found = true
		}
		if len(a.ID) != 32 {
			t.Errorf("账号 ID 应 32 位，实际 %d 位：%s", len(a.ID), a.ID)
		}
	}
	if account != "" && !found {
		t.Errorf("环境变量里的账号 %s 不在账号列表里", account)
	}
}

// 真机：能列 KV 命名空间。
func TestLiveListKVNamespaces(t *testing.T) {
	c, account := liveClient(t)
	if account == "" {
		t.Skip("未设置 CFPILOT_LIVE_ACCOUNT")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	ns, err := c.ListKVNamespaces(ctx, account)
	if err != nil {
		t.Fatalf("列 KV 失败：%v", err)
	}
	t.Logf("共 %d 个 KV 命名空间", len(ns))
	for _, n := range ns {
		t.Logf("  %s  %s", n.ID, n.Title)
	}
}

// 真机：能列 Pages 项目，并验证 GetPagesProject 的 404 → nil 语义。
func TestLivePagesProjects(t *testing.T) {
	c, account := liveClient(t)
	if account == "" {
		t.Skip("未设置 CFPILOT_LIVE_ACCOUNT")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	projects, err := c.ListPagesProjects(ctx, account)
	if err != nil {
		t.Fatalf("列 Pages 项目失败：%v", err)
	}
	t.Logf("共 %d 个 Pages 项目", len(projects))
	for _, p := range projects {
		t.Logf("  %s  subdomain=%s", p.Name, p.Subdomain)

		// 逐个验证详情接口能取到
		detail, err := c.GetPagesProject(ctx, account, p.Name)
		if err != nil {
			t.Errorf("取项目 %s 详情失败：%v", p.Name, err)
			continue
		}
		if detail == nil {
			t.Errorf("项目 %s 明明在列表里，详情却返回 nil", p.Name)
			continue
		}
		if detail.Name != p.Name {
			t.Errorf("名称不一致：列表 %q 详情 %q", p.Name, detail.Name)
		}

		// 验证 /domains 子接口可用
		domains, err := c.ListPagesDomains(ctx, account, p.Name)
		if err != nil {
			t.Errorf("列域名失败（%s）：%v", p.Name, err)
			continue
		}
		for _, d := range domains {
			t.Logf("    域名：%s (%s)", d.Name, d.Status)
		}
	}

	// 一个绝对不存在的项目，必须返回 (nil, nil) 而不是报错
	missing, err := c.GetPagesProject(ctx, account, "cfpilot-nonexistent-project-zzz-99999")
	if err != nil {
		t.Errorf("不存在的项目应返回 nil 而不是报错，实际：%v", err)
	}
	if missing != nil {
		t.Errorf("不存在的项目应返回 nil，实际 %+v", missing)
	}
}

// 真机：KV 读取不存在键要静默返回 false。
func TestLiveGetKVValueMissingKey(t *testing.T) {
	c, account := liveClient(t)
	if account == "" {
		t.Skip("未设置 CFPILOT_LIVE_ACCOUNT")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	ns, err := c.ListKVNamespaces(ctx, account)
	if err != nil || len(ns) == 0 {
		t.Skip("没有可用的 KV 命名空间")
	}

	val, ok := c.GetKVValue(ctx, account, ns[0].ID, "__cfpilot_definitely_missing_key__")
	if ok {
		t.Errorf("不存在的键不该读到值，实际 %q", val)
	}
}
