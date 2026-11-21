package config

import (
	"os"
	"path/filepath"
	"testing"
)

// 用临时 HOME 隔离测试，绝不能读写真实用户目录。
func withTempHome(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("USERPROFILE", dir) // Windows
	t.Setenv("HOME", dir)        // Linux / macOS
}

func TestLoadSettingsDefaultsWhenMissing(t *testing.T) {
	withTempHome(t)

	s, err := LoadSettings()
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if s.Port != DefaultPort {
		t.Errorf("默认端口应为 %d，实际 %d", DefaultPort, s.Port)
	}
	if s.Host != "127.0.0.1" {
		t.Errorf("Host 必须固定回环，实际 %q", s.Host)
	}
}

func TestSaveAndLoadRoundTrip(t *testing.T) {
	withTempHome(t)

	want := DesktopSettings{
		Port:              20001,
		Host:              "127.0.0.1",
		KeepRunningInTray: true,
		PanelMode:         PanelModeAuto,
	}
	if err := SaveSettings(want); err != nil {
		t.Fatalf("保存失败：%v", err)
	}

	got, err := LoadSettings()
	if err != nil {
		t.Fatalf("读取失败：%v", err)
	}
	if got != want {
		t.Errorf("往返不一致：want %+v, got %+v", want, got)
	}
}

func TestSaveRejectsInvalidPort(t *testing.T) {
	withTempHome(t)

	for _, port := range []int{0, -1, 65536, 99999} {
		if err := SaveSettings(DesktopSettings{Port: port}); err == nil {
			t.Errorf("端口 %d 应被拒绝", port)
		}
	}
}

// Host 不允许被外部改成 0.0.0.0 —— 这个服务持有 Token 读写能力，
// 暴露到局域网就是安全事故。
func TestHostAlwaysForcedLoopback(t *testing.T) {
	withTempHome(t)

	if err := SaveSettings(DesktopSettings{
		Port: 20002,
		Host: "0.0.0.0",
	}); err != nil {
		t.Fatalf("保存失败：%v", err)
	}
	got, _ := LoadSettings()
	if got.Host != "127.0.0.1" {
		t.Errorf("Host 必须被强制回环，实际 %q", got.Host)
	}
}

func TestLoadSettingsToleratesCorruptFile(t *testing.T) {
	withTempHome(t)

	dir, err := EnsureDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "desktop.json"), []byte("{ 坏掉的 json"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 设置文件损坏不该让程序起不来
	s, err := LoadSettings()
	if err != nil {
		t.Fatalf("损坏的文件也应回退出厂值而不报错：%v", err)
	}
	if s.Port != DefaultPort {
		t.Errorf("应回退出厂端口，实际 %d", s.Port)
	}
}

func TestNormalizePanelMode(t *testing.T) {
	cases := map[string]string{
		"":        PanelModeAuto,
		"auto":    PanelModeAuto,
		"window":  PanelModeWindow,
		"browser": PanelModeBrowser,
		"WINDOW":  PanelModeAuto, // 大小写不匹配就是非法值
		"gui":     PanelModeAuto,
	}
	for in, want := range cases {
		if got := NormalizePanelMode(in); got != want {
			t.Errorf("NormalizePanelMode(%q) = %q，期望 %q", in, got, want)
		}
	}
}

func TestEffectivePanelModeEnvWins(t *testing.T) {
	t.Setenv(EnvPanel, "browser")
	if got := EffectivePanelMode(DesktopSettings{PanelMode: PanelModeWindow}); got != PanelModeBrowser {
		t.Fatalf("环境变量应优先，得到 %q", got)
	}

	// 非法值不能把用户锁死：退回设置文件里的值。
	t.Setenv(EnvPanel, "nonsense")
	if got := EffectivePanelMode(DesktopSettings{PanelMode: PanelModeWindow}); got != PanelModeWindow {
		t.Fatalf("非法环境变量应被忽略，得到 %q", got)
	}
}

func TestLoadSettingsMigratesMissingPanelMode(t *testing.T) {
	withTempHome(t)

	dir, err := EnsureDir()
	if err != nil {
		t.Fatalf("建目录失败：%v", err)
	}
	// 旧版本写下的设置文件没有 panelMode 字段。
	if err := os.WriteFile(filepath.Join(dir, "desktop.json"), []byte(`{"port":19726}`), 0o600); err != nil {
		t.Fatalf("写设置失败：%v", err)
	}

	s, err := LoadSettings()
	if err != nil {
		t.Fatalf("读取失败：%v", err)
	}
	if s.PanelMode != PanelModeAuto {
		t.Errorf("旧配置应迁移为 auto，实际 %q", s.PanelMode)
	}
}

func TestParsePort(t *testing.T) {
	ok := []string{"1", "80", "19726", "65535"}
	for _, s := range ok {
		if _, err := ParsePort(s); err != nil {
			t.Errorf("%q 应被接受：%v", s, err)
		}
	}
	bad := []string{"0", "-5", "65536", "abc", ""}
	for _, s := range bad {
		if _, err := ParsePort(s); err == nil {
			t.Errorf("%q 应被拒绝", s)
		}
	}
}
