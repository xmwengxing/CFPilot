package update

// 更新检查与下载的测试。
//
// 重点验证：
//   - 版本比较（含非标准 tag）
//   - 只认 desktop-v*/gui-v* 且排除 draft/prerelease
//   - 按平台挑资产
//   - 镜像回退顺序
//   - 截断检测（镜像最常见的故障）与半截文件清理

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// ---------- 版本比较 ----------

func TestParseVersion(t *testing.T) {
	cases := []struct {
		in   string
		want [3]int
	}{
		{"desktop-v0.5.5", [3]int{0, 5, 5}},
		{"gui-v0.5.4", [3]int{0, 5, 4}},
		{"0.5.5", [3]int{0, 5, 5}},
		{"v1.2.3", [3]int{1, 2, 3}},
		{"1.0.0-beta.2", [3]int{1, 0, 0}},
		{"no-version", [3]int{0, 0, 0}},
		{"", [3]int{0, 0, 0}},
	}
	for _, tc := range cases {
		if got := ParseVersion(tc.in); got != tc.want {
			t.Errorf("ParseVersion(%q) = %v，期望 %v", tc.in, got, tc.want)
		}
	}
}

func TestCompareVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want int // 正数 a>b，负数 a<b，0 相等
	}{
		{"0.5.5", "0.5.4", 1},
		{"0.5.4", "0.5.5", -1},
		{"0.5.5", "0.5.5", 0},
		{"1.0.0", "0.9.9", 1},
		{"0.6.0", "0.5.99", 1},
	}
	for _, tc := range cases {
		got := CompareVersion(ParseVersion(tc.a), ParseVersion(tc.b))
		ok := (tc.want > 0 && got > 0) || (tc.want < 0 && got < 0) || (tc.want == 0 && got == 0)
		if !ok {
			t.Errorf("compare(%s, %s) = %d，期望符号 %d", tc.a, tc.b, got, tc.want)
		}
	}
}

// ---------- 检查更新 ----------

// fakeGitHub 起一个假的 GitHub Releases API。
func fakeGitHub(t *testing.T, payload any) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("User-Agent"), "CFPilot") {
			t.Errorf("应带 CFPilot User-Agent，实际 %q", r.Header.Get("User-Agent"))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(payload)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// withAPIBase 临时替换 API 地址。
func withAPIBase(t *testing.T, base string) {
	t.Helper()
	old := APIBase
	APIBase = base + "/releases"
	t.Cleanup(func() { APIBase = old })

	// ⚠️ **单元测试必须与网络隔离**。
	//
	// 真实运行时有「镜像回退」与「免 API 通道」两级兜底
	// （国内直连 GitHub 不通时的救命稻草）。
	// 但那些兜底会打到**真实的镜像站** —— 开着的话，
	// 「API 出错」这类用例就会去下载真的内核（慢，且结果随网络变化）。
	oldMirrors := Mirrors
	Mirrors = nil
	t.Cleanup(func() { Mirrors = oldMirrors })

	oldWeb := ReleasesWebBase
	ReleasesWebBase = base + "/releases-web"
	t.Cleanup(func() { ReleasesWebBase = oldWeb })
}

// releaseJSON 造一条发行版记录。
func releaseJSON(tag, assetName string, draft, prerelease bool) map[string]any {
	return map[string]any{
		"tag_name":   tag,
		"draft":      draft,
		"prerelease": prerelease,
		"body":       "release notes for " + tag,
		"assets": []map[string]any{
			{"name": assetName, "browser_download_url": "https://example.com/" + assetName, "size": 100},
		},
	}
}

// 发现新版本。
func TestCheckHasUpdate(t *testing.T) {
	// 资产名要匹配当前平台
	assetName := "cfpilot-0.6.0-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		assetName += ".exe"
	}
	srv := fakeGitHub(t, []any{
		releaseJSON("desktop-v0.6.0", assetName, false, false),
		releaseJSON("desktop-v0.5.5", assetName, false, false),
	})
	withAPIBase(t, srv.URL)

	res := Check(context.Background(), "0.5.5")
	if res.Error != "" {
		t.Fatalf("不该报错：%s", res.Error)
	}
	if res.Latest != "0.6.0" {
		t.Errorf("最新版本应为 0.6.0，实际 %q", res.Latest)
	}
	if !res.HasUpdate {
		t.Error("应判定有新版本")
	}
	if res.DownloadURL == "" {
		t.Error("应给出下载地址")
	}
}

// 已是最新版。
func TestCheckNoUpdate(t *testing.T) {
	assetName := "cfpilot-0.5.5-" + runtime.GOOS + "-" + runtime.GOARCH
	srv := fakeGitHub(t, []any{
		releaseJSON("desktop-v0.5.5", assetName, false, false),
	})
	withAPIBase(t, srv.URL)

	res := Check(context.Background(), "0.5.5")
	if res.Error != "" {
		t.Fatalf("不该报错：%s", res.Error)
	}
	if res.HasUpdate {
		t.Error("同版本不该判定为有更新")
	}
}

// draft 与 prerelease 必须跳过。
func TestCheckSkipsDraftAndPrerelease(t *testing.T) {
	assetName := "cfpilot-0.6.0-" + runtime.GOOS + "-" + runtime.GOARCH
	srv := fakeGitHub(t, []any{
		releaseJSON("desktop-v0.9.0", assetName, true, false),  // draft
		releaseJSON("desktop-v0.8.0", assetName, false, true),  // prerelease
		releaseJSON("desktop-v0.6.0", assetName, false, false), // 真正的最新
	})
	withAPIBase(t, srv.URL)

	res := Check(context.Background(), "0.5.5")
	if res.Latest != "0.6.0" {
		t.Errorf("应跳过 draft/prerelease，最新应为 0.6.0，实际 %q", res.Latest)
	}
}

// 正式发行版的 tag 是 `v<版本>`（2026-10-27 起与 npm 发布共用）。
//
// ⚠️ 这条曾经是**真 bug**：早期只认 `desktop-v*` / `gui-v*`，
// 而 release-desktop.yml 产出的是 `v*` → 一个发行版都找不到 →
// 界面「检查更新」按钮永远显示「检查失败」。
func TestCheckAcceptsVPrefix(t *testing.T) {
	assetName := "cfpilot-0.6.0-" + runtime.GOOS + "-" + runtime.GOARCH
	srv := fakeGitHub(t, []any{
		releaseJSON("v0.6.0", assetName, false, false),
	})
	withAPIBase(t, srv.URL)

	res := Check(context.Background(), "0.5.5")
	if res.Error != "" {
		t.Fatalf("不应报错，实际 %q", res.Error)
	}
	if res.Latest != "0.6.0" {
		t.Errorf("应认 v* 前缀，最新应为 0.6.0，实际 %q", res.Latest)
	}
	if !res.HasUpdate {
		t.Error("0.5.5 → 0.6.0 应判定有新版")
	}
}

// 不相关的 tag 前缀要跳过。
func TestCheckIgnoresUnrelatedTags(t *testing.T) {
	assetName := "cfpilot-0.6.0-" + runtime.GOOS + "-" + runtime.GOARCH
	srv := fakeGitHub(t, []any{
		releaseJSON("release-0.6.0", assetName, false, false), // 无关前缀
		releaseJSON("desktop-v0.6.0", assetName, false, false),
	})
	withAPIBase(t, srv.URL)

	res := Check(context.Background(), "0.5.5")
	if res.Latest != "0.6.0" {
		t.Errorf("应只认 v*/desktop-v*/gui-v*，实际 %q", res.Latest)
	}
}

// 兼容 gui-v* 前缀（过渡期）。
func TestCheckAcceptsGuiPrefix(t *testing.T) {
	assetName := "CFPilot-0.6.0-" + runtime.GOOS
	if runtime.GOOS == "windows" {
		assetName += ".exe"
	}
	srv := fakeGitHub(t, []any{
		releaseJSON("gui-v0.6.0", assetName, false, false),
	})
	withAPIBase(t, srv.URL)

	res := Check(context.Background(), "0.5.5")
	if res.Latest != "0.6.0" {
		t.Errorf("应兼容 gui-v 前缀，实际 %q", res.Latest)
	}
}

// FetchReleases 不过滤平台资产 —— 内核产物与平台无关。
//
// kernel 包用它找「远程可用的内核产物」：
// 如果按平台过滤，发在没有 windows 安装包的发行版会被整个丢掉。
func TestFetchReleasesKeepsAssetsWithoutPlatformPackage(t *testing.T) {
	srv := fakeGitHub(t, []any{
		map[string]any{
			"tag_name":   "v0.7.6",
			"draft":      false,
			"prerelease": false,
			"body":       "notes",
			"assets": []map[string]any{
				{
					"name":                 "cfpilot-kernel-control.js",
					"browser_download_url": "https://example.com/control.js",
					"size":                 10,
				},
				{
					"name":                 "cfpilot-kernel-dataplane.js",
					"browser_download_url": "https://example.com/dataplane.js",
					"size":                 20,
				},
			},
		},
	})
	withAPIBase(t, srv.URL)

	releases, err := FetchReleases(context.Background())
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if len(releases) != 1 {
		t.Fatalf("应有 1 个发行版，实际 %d", len(releases))
	}
	if releases[0].Version != "0.7.6" {
		t.Errorf("版本号应是 0.7.6，实际 %q", releases[0].Version)
	}
	if len(releases[0].Assets) != 2 {
		t.Errorf("应保留全部附件，实际 %d", len(releases[0].Assets))
	}
}

// isReleaseTag / releaseVersion 的单元测试。
func TestReleaseVersion(t *testing.T) {
	cases := map[string]string{
		"v0.7.5":         "0.7.5",
		"desktop-v0.7.5": "0.7.5",
		"gui-v0.7.5":     "0.7.5",
		"v0.7":           "",
		"v0.7.5-rc1":     "0.7.5-rc1", // 保留后缀（版本号比较只取数字三段）
		"release-0.7.5":  "",
		"vfoo":           "",
		"":               "",
	}
	for tag, want := range cases {
		if got := releaseVersion(tag); got != want {
			t.Errorf("releaseVersion(%q) = %q，期望 %q", tag, got, want)
		}
	}
}

// 没有本平台资产时跳过该发行版。
func TestCheckSkipsWhenNoPlatformAsset(t *testing.T) {
	srv := fakeGitHub(t, []any{
		releaseJSON("desktop-v0.9.0", "cfpilot-0.9.0-solaris-sparc", false, false),
		releaseJSON("desktop-v0.6.0", "cfpilot-0.6.0-"+runtime.GOOS, false, false),
	})
	withAPIBase(t, srv.URL)

	res := Check(context.Background(), "0.5.5")
	if res.Latest != "0.6.0" {
		t.Errorf("应跳过没有本平台资产的发行版，实际 %q", res.Latest)
	}
}

// API 出错时返回 error 而不是 panic。
func TestCheckAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	withAPIBase(t, srv.URL)

	res := Check(context.Background(), "0.5.5")
	if res.Error == "" {
		t.Error("应报错")
	}
	if res.HasUpdate {
		t.Error("出错时不该判定有更新")
	}
}

// 空发行版列表要给出明确提示。
func TestCheckEmptyReleases(t *testing.T) {
	srv := fakeGitHub(t, []any{})
	withAPIBase(t, srv.URL)

	res := Check(context.Background(), "0.5.5")
	if res.Error == "" {
		t.Error("应报错说明没有发行版")
	}
}

// ---------- 下载 ----------

// 假 Release 的固定坐标。
//
// ⚠️ 下载现在会先从 `ReleasesWebBase` 取 `cfpilot-desktop-SHA256SUMS`
// 并校验产物摘要，所以下载测试不能再拿一个裸 URL 当资产地址 ——
// 必须是 `<base>/releases/download/<tag>/<asset>` 的真实形态。
const (
	fixtureTag   = "v9.9.9"
	fixtureAsset = "cfpilot-9.9.9-windows-amd64.exe"
)

// newReleaseServer 起一台假 Release 服务器：同时提供资产与官方摘要清单。
//
// assetHandler 为 nil 时返回 payload；清单始终按 payload 的 SHA-256 生成。
// `ReleasesWebBase` 会被指向这台服务器，测试结束后自动还原。
func newReleaseServer(t *testing.T, payload []byte, assetHandler http.HandlerFunc) *httptest.Server {
	t.Helper()
	sum := sha256.Sum256(payload)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/download/" + fixtureTag + "/" + DesktopChecksumsAssetName:
			fmt.Fprintf(w, "%x  %s\n", sum, fixtureAsset)
		case "/releases/download/" + fixtureTag + "/" + fixtureAsset:
			if assetHandler != nil {
				assetHandler(w, r)
				return
			}
			w.Header().Set("Content-Length", fmt.Sprint(len(payload)))
			_, _ = w.Write(payload)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	old := ReleasesWebBase
	ReleasesWebBase = srv.URL
	t.Cleanup(func() { ReleasesWebBase = old })
	return srv
}

// releaseAssetURL 拼出该假 Release 的资产地址。
func releaseAssetURL(srv *httptest.Server) string {
	return srv.URL + "/releases/download/" + fixtureTag + "/" + fixtureAsset
}

// 下载成功。
func TestDownloadSuccess(t *testing.T) {
	payload := []byte("fake binary content for testing")
	srv := newReleaseServer(t, payload, nil)

	target := filepath.Join(t.TempDir(), "update.bin")
	got, err := Download(context.Background(), releaseAssetURL(srv), target, nil, nil)
	if err != nil {
		t.Fatalf("下载应成功：%v", err)
	}
	if got != target {
		t.Errorf("返回路径不对：%q", got)
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != string(payload) {
		t.Errorf("内容不一致")
	}
}

// 截断检测：声明 1000 字节只发 100 → 必须报错并删掉半截文件。
//
// 这是镜像最常见的故障。半截文件如果被当成完整包，用户装上去就是坏的。
func TestDownloadDetectsTruncation(t *testing.T) {
	// 清空镜像：否则会去试三个真实镜像站，每个都等到超时（测试白跑 18 秒）
	oldMirrors := Mirrors
	Mirrors = nil
	t.Cleanup(func() { Mirrors = oldMirrors })

	srv := newReleaseServer(t, []byte(strings.Repeat("x", 100)), func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		_, _ = w.Write([]byte(strings.Repeat("x", 100)))
		// 故意少发，连接关闭
	})

	dir := t.TempDir()
	target := filepath.Join(dir, "update.bin")

	// 直连失败会继续试镜像（也会失败），最终报错
	_, err := Download(context.Background(), releaseAssetURL(srv), target, nil, nil)
	if err == nil {
		t.Fatal("截断必须报错")
	}
	if !strings.Contains(err.Error(), "不完整") && !strings.Contains(err.Error(), "失败") {
		t.Errorf("错误信息应说明不完整，实际：%v", err)
	}
	// 半截文件必须被清掉
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Error("半截文件必须删除，否则下次会被误判成已下载")
	}
}

// 空响应要报错。
func TestDownloadEmptyContent(t *testing.T) {
	// 同上：清空镜像避免真实网络超时
	oldMirrors := Mirrors
	Mirrors = nil
	t.Cleanup(func() { Mirrors = oldMirrors })

	srv := newReleaseServer(t, []byte(""), func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "0")
	})

	target := filepath.Join(t.TempDir(), "update.bin")
	_, err := Download(context.Background(), releaseAssetURL(srv), target, nil, nil)
	if err == nil {
		t.Fatal("空内容必须报错")
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Error("空文件应被清理")
	}
}

// 直连失败时必须回退到镜像。
func TestDownloadFallsBackToMirror(t *testing.T) {
	payload := []byte("mirror content")

	// 直连地址故意不可用（但必须是 Release 形态：资产名要从 URL 推）
	direct := "http://127.0.0.1:1/releases/download/" + fixtureTag + "/" + fixtureAsset
	// 官方清单由假 Release 服务器提供（镜像不参与清单）
	newReleaseServer(t, payload, nil)

	// 镜像服务器：任何路径都返回内容
	mirrorSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(len(payload)))
		_, _ = w.Write(payload)
	}))
	defer mirrorSrv.Close()

	// 替换镜像列表指向本地服务器
	oldMirrors := Mirrors
	Mirrors = []Mirror{{Name: "test-mirror", Prefix: mirrorSrv.URL + "/"}}
	t.Cleanup(func() { Mirrors = oldMirrors })

	var logs []string
	target := filepath.Join(t.TempDir(), "update.bin")
	_, err := Download(context.Background(), direct, target,
		nil,
		func(msg, level string) { logs = append(logs, level+":"+msg) })
	if err != nil {
		t.Fatalf("应回退到镜像成功：%v", err)
	}

	// 日志里应能看到「直连失败 → 镜像成功」
	joined := strings.Join(logs, "\n")
	if !strings.Contains(joined, "GitHub") {
		t.Errorf("日志应提到直连尝试，实际：%s", joined)
	}
	if !strings.Contains(joined, "test-mirror") {
		t.Errorf("日志应提到镜像，实际：%s", joined)
	}
	if !strings.Contains(joined, "ok:") {
		t.Errorf("应记录成功，实际：%s", joined)
	}
}

// 全部源都失败时，错误信息要包含每个源的原因。
func TestDownloadAllSourcesFail(t *testing.T) {
	oldMirrors := Mirrors
	Mirrors = []Mirror{
		{Name: "m1", Prefix: "http://127.0.0.1:1/"},
		{Name: "m2", Prefix: "http://127.0.0.1:2/"},
	}
	t.Cleanup(func() { Mirrors = oldMirrors })

	// 清单要能拿到，否则在「所有源」之前就因无法校验而失败
	newReleaseServer(t, []byte("x"), nil)

	target := filepath.Join(t.TempDir(), "update.bin")
	direct := "http://127.0.0.1:3/releases/download/" + fixtureTag + "/" + fixtureAsset
	_, err := Download(context.Background(), direct, target, nil, nil)
	if err == nil {
		t.Fatal("全失败应报错")
	}
	msg := err.Error()
	for _, name := range []string{"GitHub", "m1", "m2"} {
		if !strings.Contains(msg, name) {
			t.Errorf("错误信息应含源 %q，实际：%v", name, err)
		}
	}
}

// 进度回调要被调用且数值递增。
func TestDownloadReportsProgress(t *testing.T) {
	payload := make([]byte, 256*1024)
	srv := newReleaseServer(t, payload, nil)

	var events []Progress
	target := filepath.Join(t.TempDir(), "update.bin")
	if _, err := Download(context.Background(), releaseAssetURL(srv), target,
		func(p Progress) { events = append(events, p) }, nil); err != nil {
		t.Fatal(err)
	}

	if len(events) == 0 {
		t.Fatal("应有进度回调")
	}
	last := events[len(events)-1]
	if last.Received != int64(len(payload)) {
		t.Errorf("最终进度应为 %d，实际 %d", len(payload), last.Received)
	}
	if last.Total != int64(len(payload)) {
		t.Errorf("total 应为 %d，实际 %d", len(payload), last.Total)
	}
	// 递增
	for i := 1; i < len(events); i++ {
		if events[i].Received < events[i-1].Received {
			t.Errorf("进度不该回退：%d -> %d", events[i-1].Received, events[i].Received)
			break
		}
	}
}

// 下载目录不存在时要自动创建。
func TestDownloadCreatesDir(t *testing.T) {
	payload := []byte("data")
	srv := newReleaseServer(t, payload, nil)

	target := filepath.Join(t.TempDir(), "a", "b", "c", "update.bin")
	if _, err := Download(context.Background(), releaseAssetURL(srv), target, nil, nil); err != nil {
		t.Fatalf("应自动创建目录：%v", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Error("文件应存在")
	}
}

func TestDefaultDownloadPath(t *testing.T) {
	p := DefaultDownloadPath("0.6.0")
	if !strings.Contains(p, ".cfpilot-gui") {
		t.Errorf("应在配置目录下，实际 %q", p)
	}
	if !strings.Contains(p, "0.6.0") {
		t.Errorf("应含版本号，实际 %q", p)
	}
	if runtime.GOOS == "windows" && !strings.HasSuffix(p, ".exe") {
		t.Errorf("Windows 上应以 .exe 结尾，实际 %q", p)
	}
}

// 保证 time 被引用（超时相关）
var _ = time.Second
