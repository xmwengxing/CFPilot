package config

import (
	"os"
	"path/filepath"
	"testing"
)

// TestEnvAllowLANValue 覆盖「允许局域网」开关的全部取值写法。
//
// ⚠️ 这个开关决定服务是否监听 0.0.0.0 ——
// **判错方向必须是「更安全」那一侧**：任何看不懂的写法都要当成「关闭」。
func TestEnvAllowLANValue(t *testing.T) {
	cases := []struct {
		raw  string
		want bool
	}{
		// 明确开启
		{"1", true},
		{"true", true},
		{"TRUE", true},
		{"True", true},
		{"yes", true},
		{"YES", true},
		{"on", true},
		{"ON", true},
		{" true ", true}, // 前后空白
		// 明确关闭
		{"0", false},
		{"false", false},
		{"no", false},
		{"off", false},
		{"", false}, // 未设置
		// 无法识别的写法 → 一律按关闭处理（安全侧）
		{"enabled", false},
		{"allow", false},
		{"是", false},
		{"maybe", false},
	}
	for _, c := range cases {
		t.Setenv(EnvAllowLAN, c.raw)
		if got := EnvAllowLANValue(); got != c.want {
			t.Errorf("%s=%q 应为 %v，实际 %v", EnvAllowLAN, c.raw, c.want, got)
		}
	}
}

// TestEnvAllowLANUnset 默认必须是关闭。
func TestEnvAllowLANUnset(t *testing.T) {
	os.Unsetenv(EnvAllowLAN)
	if EnvAllowLANValue() {
		t.Error("未设置时必须为关闭（默认只监听回环地址）")
	}
}

// TestDirEnvOverride 数据目录可被环境变量覆盖（容器挂卷用）。
func TestDirEnvOverride(t *testing.T) {
	custom := filepath.Join(t.TempDir(), "data")
	t.Setenv(EnvDataDir, custom)
	got, err := Dir()
	if err != nil {
		t.Fatalf("Dir() 应成功：%v", err)
	}
	if got != custom {
		t.Errorf("配置目录应为 %s，实际 %s", custom, got)
	}
}

// TestDirEnvOverrideWhitespace 空白值视为未设置（回落到默认目录）。
func TestDirEnvOverrideWhitespace(t *testing.T) {
	t.Setenv(EnvDataDir, "   ")
	got, err := Dir()
	if err != nil {
		t.Fatalf("Dir() 应成功：%v", err)
	}
	if got == "" {
		t.Error("配置目录不应为空")
	}
	if filepath.Base(got) != ".cfpilot-gui" {
		t.Errorf("空白值应回落到默认目录，实际 %s", got)
	}
}

// TestEnvBootTokenValue 启动令牌可注入，且空白视为未设置。
func TestEnvBootTokenValue(t *testing.T) {
	t.Setenv(EnvBootToken, "fixed-token-123")
	if got := EnvBootTokenValue(); got != "fixed-token-123" {
		t.Errorf("启动令牌应为 fixed-token-123，实际 %q", got)
	}
	t.Setenv(EnvBootToken, "  ")
	if got := EnvBootTokenValue(); got != "" {
		t.Errorf("空白令牌应视为未设置，实际 %q", got)
	}
}

// TestEnvPortValue 端口可注入；非法值一律按「不覆盖」处理。
func TestEnvPortValue(t *testing.T) {
	cases := []struct {
		raw  string
		want int
	}{
		{"8080", 8080},
		{" 19726 ", 19726},
		{"", 0},      // 未设置
		{"abc", 0},   // 不是数字
		{"0", 0},     // 越界
		{"70000", 0}, // 越界
		{"-1", 0},    // 越界
	}
	for _, c := range cases {
		t.Setenv(EnvPort, c.raw)
		if got := EnvPortValue(); got != c.want {
			t.Errorf("%s=%q 应为 %d，实际 %d", EnvPort, c.raw, c.want, got)
		}
	}
}
