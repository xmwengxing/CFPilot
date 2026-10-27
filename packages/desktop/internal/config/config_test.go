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
