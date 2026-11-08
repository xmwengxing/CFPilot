package scan

import "testing"

// 内置来源由 packages/cli/assets/sources-builtin.json 生成。
// 这里只验证「运行时能不能用」：URL 过 SSRF 校验、id 唯一、默认停用、
// 且没有混进 API 型源（API 型不提供清单文本，弹窗拉不到内容）。
func TestBuiltinSourcesAreUsable(t *testing.T) {
	got := BuiltinSources()
	if len(got) != BuiltinSourcesCount || len(got) == 0 {
		t.Fatalf("内置来源数量不对：得到 %d，期望 %d", len(got), BuiltinSourcesCount)
	}
	seen := map[string]bool{}
	for _, s := range got {
		if seen[s.ID] {
			t.Errorf("内置来源 id 重复：%s", s.ID)
		}
		seen[s.ID] = true
		if s.Name == "" {
			t.Errorf("内置来源缺少名称：%s", s.ID)
		}
		if s.Enabled {
			t.Errorf("内置来源应默认停用，避免首次同步撞失效链接：%s", s.ID)
		}
		if IsAPISource(s) {
			t.Errorf("内置来源不应是 API 型（弹窗拉不到清单文本）：%s", s.ID)
		}
		if _, err := ValidateSourceURL(s.URL, false); err != nil {
			t.Errorf("内置来源 URL 不合法：%s —— %v", s.ID, err)
		}
	}
}

func TestEmptySourcesSeedsBuiltinList(t *testing.T) {
	cfg := EmptySources()
	if len(cfg.Sources) != BuiltinSourcesCount {
		t.Fatalf("配置文件不存在时应播种内置来源：得到 %d，期望 %d", len(cfg.Sources), BuiltinSourcesCount)
	}
	if len(cfg.Runs) != 0 {
		t.Fatalf("新配置不应带采集记录，得到 %d 条", len(cfg.Runs))
	}
}
