package update

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestVersionFromReleaseURL 覆盖免 API 通道的版本解析。
func TestVersionFromReleaseURL(t *testing.T) {
	cases := map[string]string{
		"https://github.com/o/r/releases/tag/v0.8.1":                  "0.8.1",
		"https://github.com/o/r/releases/tag/v1.2.3":                  "1.2.3",
		"https://github.com/o/r/releases/download/v0.8.1/file.zip":    "0.8.1",
		"https://github.com/o/r/releases/download/v0.9.0/cfpilot.exe": "0.9.0",
		"https://github.com/o/r":                                      "",
		"":                                                            "",
		"https://example.com/releases/tag/abc":                        "",
	}
	for url, want := range cases {
		if got := versionFromReleaseURL(url); got != want {
			t.Errorf("versionFromReleaseURL(%q) = %q，期望 %q", url, got, want)
		}
	}
}

// TestDesktopAssetName 保证与 CLI 版的命名一致。
func TestDesktopAssetName(t *testing.T) {
	cases := []struct {
		version, goos, goarch, want string
	}{
		{"0.8.1", "windows", "amd64", "cfpilot-0.8.1-windows-amd64.exe"},
		{"0.8.1", "linux", "amd64", "cfpilot-0.8.1-linux-amd64"},
		{"0.8.1", "linux", "arm64", "cfpilot-0.8.1-linux-arm64"},
	}
	for _, c := range cases {
		if got := DesktopAssetName(c.version, c.goos, c.goarch); got != c.want {
			t.Errorf("DesktopAssetName(%s,%s,%s) = %q，期望 %q", c.version, c.goos, c.goarch, got, c.want)
		}
	}
}

// TestFetchLatestReleaseWithoutAPI 验证「免 API 通道」能从 302 的 Location 读出版本。
func TestFetchLatestReleaseWithoutAPI(t *testing.T) {
	old := ReleasesWebBase
	defer func() { ReleasesWebBase = old }()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "http://"+r.Host+"/releases/tag/v0.9.3")
		w.WriteHeader(http.StatusFound)
	}))
	defer srv.Close()

	// ReleasesWebBase 指向测试服务器；镜像前缀指向同一个服务器
	ReleasesWebBase = srv.URL + "/releases"
	oldMirrors := Mirrors
	Mirrors = []Mirror{{Name: "test", Prefix: srv.URL + "/m/"}}
	defer func() { Mirrors = oldMirrors }()

	release, err := fetchLatestReleaseWithoutAPI(context.Background())
	if err != nil {
		t.Fatalf("免 API 通道失败：%v", err)
	}
	if release.Version != "0.9.3" {
		t.Errorf("版本应为 0.9.3，实际 %q", release.Version)
	}
	if release.Tag != "v0.9.3" {
		t.Errorf("tag 应为 v0.9.3，实际 %q", release.Tag)
	}
	if len(release.Assets) == 0 {
		t.Error("免 API 通道应带上固定名资产")
	}
	// 桌面版安装包 URL 里应含版本号与平台
	if !strings.Contains(release.URL, "0.9.3") {
		t.Errorf("安装包 URL 应含版本号，实际 %q", release.URL)
	}
}

// TestFetchLatestReleaseWithoutAPIFails 确认全失败时返回错误而不是假数据。
func TestFetchLatestReleaseWithoutAPIFails(t *testing.T) {
	old := ReleasesWebBase
	defer func() { ReleasesWebBase = old }()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 返回 200 且没有 Location —— 代理没把重定向透出来
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	ReleasesWebBase = srv.URL + "/releases"
	oldMirrors := Mirrors
	Mirrors = nil
	defer func() { Mirrors = oldMirrors }()

	if _, err := fetchLatestReleaseWithoutAPI(context.Background()); err == nil {
		t.Error("全部源失败时应返回错误")
	}
}

// TestFetchAllReleasesFallbackDirect 确认直连 API 正常时不会退化。
func TestFetchAllReleasesFallbackDirect(t *testing.T) {
	old := APIBase
	defer func() { APIBase = old }()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"tag_name":"v1.2.3","draft":false,"prerelease":false,"body":"notes",
			"assets":[{"name":"cfpilot-1.2.3-windows-amd64.exe","browser_download_url":"http://x/y.exe"}]}]`))
	}))
	defer srv.Close()

	APIBase = srv.URL + "/releases"
	oldMirrors := Mirrors
	Mirrors = nil
	defer func() { Mirrors = oldMirrors }()

	releases, err := FetchAllReleasesFallback(context.Background())
	if err != nil {
		t.Fatalf("直连 API 应成功：%v", err)
	}
	if len(releases) != 1 {
		t.Fatalf("应有 1 个发行版，实际 %d", len(releases))
	}
	if releases[0].Version != "1.2.3" {
		t.Errorf("版本应为 1.2.3，实际 %q", releases[0].Version)
	}
}

// TestFetchAllReleasesFallbackToMirror 确认直连失败后走镜像。
func TestFetchAllReleasesFallbackToMirror(t *testing.T) {
	old := APIBase
	defer func() { APIBase = old }()

	// 直连地址指向一个不存在的端口（必然连不上）
	APIBase = "http://127.0.0.1:1/releases"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"tag_name":"v2.0.0","draft":false,"prerelease":false,"body":"n",
			"assets":[{"name":"cfpilot-2.0.0-windows-amd64.exe","browser_download_url":"http://x/y.exe"}]}]`))
	}))
	defer srv.Close()

	oldMirrors := Mirrors
	Mirrors = []Mirror{{Name: "test", Prefix: srv.URL + "/m/"}}
	defer func() { Mirrors = oldMirrors }()

	releases, err := FetchAllReleasesFallback(context.Background())
	if err != nil {
		t.Fatalf("镜像回退应成功：%v", err)
	}
	if len(releases) != 1 || releases[0].Version != "2.0.0" {
		t.Errorf("镜像回退结果不对：%+v", releases)
	}
}

// TestDownloadSourcesOrder 确认候选源以直连开头、镜像在后。
func TestDownloadSourcesOrder(t *testing.T) {
	sources := downloadSources("https://github.com/a/b")
	if sources[0].Name != "GitHub" {
		t.Errorf("第一项应为直连 GitHub，实际 %q", sources[0].Name)
	}
	if sources[0].URL != "https://github.com/a/b" {
		t.Errorf("直连 URL 不应被改写，实际 %q", sources[0].URL)
	}
	if len(sources) != len(Mirrors)+1 {
		t.Errorf("候选源数量应为 1+%d，实际 %d", len(Mirrors), len(sources))
	}
	for _, s := range sources[1:] {
		if !strings.HasSuffix(s.URL, "https://github.com/a/b") {
			t.Errorf("镜像 URL 应以原始 URL 结尾，实际 %q", s.URL)
		}
	}
}
