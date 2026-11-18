package update

import (
	"strings"
	"testing"
)

// TestParseReleasesBeta 验证 GitHub Releases 里的 beta 版本被正确解析：
//   - tag `v1.0.0-beta.1` 是合法 semver（releaseVersion 保留完整后缀）
//   - 即使 prerelease=false（当前 workflow 未标 prerelease），也要把它当测试版
//     识别出来，界面靠 CheckResult.Prerelease 标注，避免误导用户。
func TestParseReleasesBeta(t *testing.T) {
	jsonBody := `[
		{
			"tag_name": "v1.0.0-beta.1",
			"draft": false,
			"prerelease": false,
			"body": "beta notes",
			"assets": [{"name":"cfpilot-1.0.0-beta.1-windows-amd64.exe","browser_download_url":"https://example.com/beta.exe","size":1}]
		},
		{
			"tag_name": "v0.50.0",
			"draft": false,
			"prerelease": false,
			"body": "stable notes",
			"assets": [{"name":"cfpilot-0.50.0-windows-amd64.exe","browser_download_url":"https://example.com/stable.exe","size":1}]
		}
	]`
	releases, err := parseReleases(strings.NewReader(jsonBody))
	if err != nil {
		t.Fatal(err)
	}
	if len(releases) != 2 {
		t.Fatalf("期望 2 个发行版，实际 %d", len(releases))
	}
	// 降序：beta(1.0.0) 在前
	if releases[0].Version != "1.0.0-beta.1" {
		t.Errorf("最新版本应为 1.0.0-beta.1，实际 %q", releases[0].Version)
	}
	if label := prereleaseLabel(releases[0].Version); label != "beta.1" {
		t.Errorf("beta 标识应为 beta.1，实际 %q", label)
	}
	// 正式版无预发布标识
	if prereleaseLabel(releases[1].Version) != "" {
		t.Errorf("0.50.0 不应有预发布标识，实际 %q", prereleaseLabel(releases[1].Version))
	}
}
