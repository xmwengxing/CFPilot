package update

import "testing"

// TestPrereleaseLabel 验证预发布标识解析（beta/rc 标注，避免把测试版误当正式版）。
func TestPrereleaseLabel(t *testing.T) {
	cases := []struct {
		version string
		want    string
	}{
		{"0.50.0", ""},
		{"1.0.0", ""},
		{"1.0.0-beta.1", "beta.1"},
		{"0.60.0-beta.2", "beta.2"},
		{"1.0.0-rc.1", "rc.1"},
		{"1.0.0-beta.1+build.5", "beta.1"}, // build 元数据去掉
		{"2.0.0-alpha", "alpha"},
	}
	for _, c := range cases {
		if got := prereleaseLabel(c.version); got != c.want {
			t.Errorf("prereleaseLabel(%q) = %q，期望 %q", c.version, got, c.want)
		}
	}
}

// TestParseVersionBeta 验证 ParseVersion 对 beta 版本丢后缀的行为（有意为之）：
// 让 0.50.0 用户能收到 1.0.0-beta.1 的提示，但界面靠 Prerelease 字段标注测试版。
func TestParseVersionBeta(t *testing.T) {
	got := ParseVersion("v1.0.0-beta.1")
	want := [3]int{1, 0, 0}
	if got != want {
		t.Errorf("ParseVersion(v1.0.0-beta.1) = %v，期望 %v", got, want)
	}
	if CompareVersion(got, [3]int{0, 50, 0}) <= 0 {
		t.Error("beta 版本应被判定为比 0.50.0 新（让用户收到提示）")
	}
}
