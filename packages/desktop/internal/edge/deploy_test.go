package edge

import (
	"strings"
	"testing"
)

func TestSplitSQL(t *testing.T) {
	sql := `-- 注释行
CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY);
-- 第二条注释
CREATE INDEX idx ON devices(id);`
	stmts := splitSQL(sql)
	if len(stmts) != 2 {
		t.Fatalf("应拆出 2 条，实际 %d: %v", len(stmts), stmts)
	}
	if !strings.Contains(stmts[0], "CREATE TABLE") || strings.Contains(stmts[0], "--") {
		t.Errorf("第一条应保留 CREATE 且剥掉注释：%q", stmts[0])
	}
	if !strings.Contains(stmts[1], "CREATE INDEX") {
		t.Errorf("第二条应为 CREATE INDEX：%q", stmts[1])
	}
}

func TestSplitSchemaAsset(t *testing.T) {
	raw, err := assets.ReadFile("assets/schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	stmts := splitSQL(string(raw))
	if len(stmts) != 5 {
		t.Fatalf("内置 schema 应拆出 5 条语句，实际 %d", len(stmts))
	}
	joined := strings.Join(stmts, "\n")
	for _, want := range []string{"devices", "idx_devices_last_seen", "auth", "sessions", "idx_sessions_expires"} {
		if !strings.Contains(joined, want) {
			t.Errorf("schema 缺少 %s", want)
		}
	}
}

func TestReplaceDefaultAPI(t *testing.T) {
	html := "<script>const DEFAULT_API = 'https://relay.shijingtian.de5.net';</script>"
	got := replaceDefaultAPI(html, "https://relay.example.com")
	if !strings.Contains(got, "const DEFAULT_API = 'https://relay.example.com'") {
		t.Errorf("未替换默认 API：%s", got)
	}
	if strings.Contains(got, "shijingtian") {
		t.Errorf("旧默认 API 仍残留：%s", got)
	}
}

func TestZoneNameFromDomain(t *testing.T) {
	cases := map[string]string{
		"relay.example.com": "example.com",
		"a.b.Example.COM":   "example.com",
		"example.com":       "example.com",
	}
	for in, want := range cases {
		if got := zoneNameFromDomain(in); got != want {
			t.Errorf("zoneNameFromDomain(%q) = %q，期望 %q", in, got, want)
		}
	}
}

func TestRandomHex(t *testing.T) {
	a, b := randomHex(24), randomHex(24)
	if len(a) != 48 || len(b) != 48 {
		t.Errorf("24 字节应编码为 48 hex，实际 %d/%d", len(a), len(b))
	}
	if a == b {
		t.Error("两次随机令牌不应相同")
	}
}

func TestEmbeddedAssets(t *testing.T) {
	for _, name := range []string{"assets/worker.js", "assets/dashboard.html", "assets/schema.sql"} {
		b, err := assets.ReadFile(name)
		if err != nil {
			t.Errorf("缺少内置资产 %s: %v", name, err)
			continue
		}
		if len(b) < 100 {
			t.Errorf("资产 %s 过小（%d B）", name, len(b))
		}
	}
	code, _ := assets.ReadFile("assets/worker.js")
	if !strings.Contains(string(code), "export") {
		t.Error("worker.js 应含 export（ES module）")
	}
}
