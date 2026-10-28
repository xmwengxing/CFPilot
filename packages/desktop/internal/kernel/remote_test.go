package kernel

// 远程内核获取的单元测试。
//
// 用 httptest 起一个假的 GitHub Releases API（写法参考
// internal/update/update_test.go 的 fakeGitHub），验证：
//
//   - FetchRemoteInfo 能从发行版里找到两个内核资产
//   - LoadPreferred 的三个分支：远程更新 / 远程不更新 / 远程不可用
//   - 下载结果会落缓存，第二次直接读缓存（不再下载）
//   - 超大文件会被拒（防止下到垃圾数据）

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/update"
)

// 假内核产物（带 BUILD_VERSION，好让 extractBuild 能提取到指纹）。
const (
	fakeControlJS = "const BUILD_VERSION = \"aaa1111-bbbb2222\";\n// fake control\n"
	fakeDataJS    = "const BUILD_VERSION = \"aaa1111-bbbb2222\";\n// fake data\n"
)

// fakeGitHub 起一个假的 GitHub：
//
//   - `<前缀>/releases` → 发行版列表（由 build 回调按 baseURL 现场生成）
//   - `<前缀>/asset/<名字>` → 资产内容
//
// 返回的第二个值是资产下载次数（用于验证「有没有重复下载」）。
func fakeGitHub(t *testing.T, build func(baseURL string) []map[string]any, assets map[string][]byte) (*httptest.Server, *int64) {
	t.Helper()
	var hits int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := "http://" + r.Host
		switch {
		case strings.HasSuffix(r.URL.Path, "/releases"):
			w.Header().Set("Content-Type", "application/json")
			var list []map[string]any
			if build != nil {
				list = build(base)
			}
			if list == nil {
				list = []map[string]any{}
			}
			_ = json.NewEncoder(w).Encode(list)
		case strings.HasPrefix(r.URL.Path, "/asset/"):
			name := strings.TrimPrefix(r.URL.Path, "/asset/")
			body, ok := assets[name]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			atomic.AddInt64(&hits, 1)
			w.Header().Set("Content-Length", fmt.Sprint(len(body)))
			_, _ = w.Write(body)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

// releaseJSON 造一条发行版记录。
//
// withKernel 为 true 时附带两个内核资产。
func releaseJSON(tag, baseURL string, withKernel bool) map[string]any {
	assets := []map[string]any{
		{
			"name":                 "cfpilot-0.7.6-windows-amd64.exe",
			"browser_download_url": baseURL + "/asset/cfpilot.exe",
			"size":                 1024,
		},
	}
	if withKernel {
		assets = append(assets,
			map[string]any{
				"name":                 ControlAssetName,
				"browser_download_url": baseURL + "/asset/" + ControlAssetName,
				"size":                 len(fakeControlJS),
			},
			map[string]any{
				"name":                 DataAssetName,
				"browser_download_url": baseURL + "/asset/" + DataAssetName,
				"size":                 len(fakeDataJS),
			})
	}
	return map[string]any{
		"tag_name":   tag,
		"draft":      false,
		"prerelease": false,
		"body":       "notes for " + tag,
		"assets":     assets,
	}
}

// withGitHubBase 把 update 包的 API 地址指向假服务器。
func withGitHubBase(t *testing.T, base string) {
	t.Helper()
	old := update.APIBase
	update.APIBase = base + "/releases"
	t.Cleanup(func() { update.APIBase = old })

	// ⚠️ **单元测试必须与网络隔离**。
	//
	// 真实运行时有「镜像回退」与「免 API 通道」两级兜底
	// （国内直连 GitHub 不通时的救命稻草）。
	// 但那些兜底会打到**真实的镜像站** —— 单元测试里如果还开着，
	// 一旦网络可用，测试就会去下载真的内核（慢、且结果随网络变化）。
	//
	// 所以这里把镜像列表清空，并把免 API 通道的基址也指向本地假服务器。
	oldMirrors := update.Mirrors
	update.Mirrors = nil
	t.Cleanup(func() { update.Mirrors = oldMirrors })

	oldWeb := update.ReleasesWebBase
	update.ReleasesWebBase = base + "/releases-web"
	t.Cleanup(func() { update.ReleasesWebBase = oldWeb })
}

// useLocalKernel 让 Load() 优先读临时目录里的「本地内核」。
func useLocalKernel(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "control.js"), []byte(fakeControlJS), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "dataplane.js"), []byte(fakeDataJS), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CFPILOT_KERNEL_DIR", dir)
}

// withoutMirrors 关掉下载镜像回退。
//
// 单元测试必须与网络隔离：真实运行时有镜像兜底
// （国内直连 GitHub 不通时的救命稻草），
// 但开着的话测试会真的去连镜像站 —— 慢，且结果随网络变化。
func withoutMirrors(t *testing.T) {
	t.Helper()
	old := update.Mirrors
	update.Mirrors = nil
	t.Cleanup(func() { update.Mirrors = old })
}

// useCacheDir 把内核缓存指向临时目录。
func useCacheDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CFPILOT_KERNEL_CACHE_DIR", dir)
	return dir
}

// ---------- FetchRemoteInfo ----------

// 能从发行版里找到两个内核资产，并且取版本号最高的那个。
func TestFetchRemoteInfo(t *testing.T) {
	srv, _ := fakeGitHub(t, func(base string) []map[string]any {
		return []map[string]any{
			releaseJSON("v0.7.4", base, true),
			releaseJSON("v0.7.6", base, true),
		}
	}, map[string][]byte{})
	withGitHubBase(t, srv.URL)

	info, err := FetchRemoteInfo(context.Background())
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if info.Version != "0.7.6" {
		t.Errorf("应取版本号最高的发行版，实际 %q", info.Version)
	}
	if !strings.Contains(info.ControlURL, ControlAssetName) {
		t.Errorf("控制面下载地址不对：%q", info.ControlURL)
	}
	if !strings.Contains(info.DataURL, DataAssetName) {
		t.Errorf("数据面下载地址不对：%q", info.DataURL)
	}
}

// 没有内核资产的发行版要被跳过。
func TestFetchRemoteInfoSkipsReleaseWithoutKernel(t *testing.T) {
	srv, _ := fakeGitHub(t, func(base string) []map[string]any {
		return []map[string]any{
			releaseJSON("v0.7.6", base, false), // 没有内核资产
		}
	}, map[string][]byte{})
	withGitHubBase(t, srv.URL)

	if _, err := FetchRemoteInfo(context.Background()); err == nil {
		t.Error("没有内核资产时应报错")
	}
}

// GitHub 不可达时返回错误（不 panic）。
func TestFetchRemoteInfoAPIFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	withGitHubBase(t, srv.URL)

	info, err := FetchRemoteInfo(context.Background())
	if err == nil {
		t.Error("GitHub 出错时应返回 error")
	}
	if info != nil {
		t.Error("出错时不该返回 info")
	}
}

// 免 API 通道：GitHub API 全挂时，仍能通过 `releases/latest` 的 302 拿到版本。
//
// 这是国内无科学上网环境下的救命稻草 ——
// 它只用 github.com 的 URL，任何下载镜像都能代理。
func TestFetchRemoteInfoFallsBackToNoAPIChannel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/releases-web/latest") {
			w.Header().Set("Location", "https://example.com/releases/tag/v0.9.9")
			w.WriteHeader(http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	old := update.APIBase
	update.APIBase = srv.URL + "/releases"
	t.Cleanup(func() { update.APIBase = old })

	oldMirrors := update.Mirrors
	update.Mirrors = nil
	t.Cleanup(func() { update.Mirrors = oldMirrors })

	oldWeb := update.ReleasesWebBase
	update.ReleasesWebBase = srv.URL + "/releases-web"
	t.Cleanup(func() { update.ReleasesWebBase = oldWeb })

	info, err := FetchRemoteInfo(context.Background())
	if err != nil {
		t.Fatalf("免 API 通道应成功：%v", err)
	}
	if info.Version != "0.9.9" {
		t.Errorf("版本应为 0.9.9，实际 %q", info.Version)
	}
	if !strings.Contains(info.ControlURL, ControlAssetName) {
		t.Errorf("控制面下载地址应含 %s，实际 %q", ControlAssetName, info.ControlURL)
	}
	if !strings.Contains(info.DataURL, DataAssetName) {
		t.Errorf("数据面下载地址应含 %s，实际 %q", DataAssetName, info.DataURL)
	}
}

// ---------- LoadPreferred ----------

// 分支一：远程版本更新 → 用远程内核。
func TestLoadPrefersRemoteWhenNewer(t *testing.T) {
	useLocalKernel(t)
	useCacheDir(t)

	srv, hits := fakeGitHub(t, func(base string) []map[string]any {
		return []map[string]any{
			releaseJSON("v0.7.6", base, true),
		}
	}, map[string][]byte{
		ControlAssetName: []byte(fakeControlJS),
		DataAssetName:    []byte(fakeDataJS),
	})
	withGitHubBase(t, srv.URL)

	arts, info, err := LoadPreferred(context.Background(), "0.7.5")
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if info == nil || info.Version != "0.7.6" {
		t.Fatalf("应返回远程信息，实际 %+v", info)
	}
	if arts.Version != "0.7.6" {
		t.Errorf("内核版本应是 0.7.6，实际 %q", arts.Version)
	}
	if !strings.Contains(arts.Source, "远程") {
		t.Errorf("来源应标明是远程，实际 %q", arts.Source)
	}
	if string(arts.Control) != fakeControlJS {
		t.Error("控制面内容应是远程下载的")
	}
	if arts.Build != "aaa1111-bbbb2222" {
		t.Errorf("build 指纹应从源码提取，实际 %q", arts.Build)
	}
	if atomic.LoadInt64(hits) != 2 {
		t.Errorf("应下载 2 个产物，实际 %d", atomic.LoadInt64(hits))
	}
}

// 分支二：远程版本不比本地新 → 用内嵌内核。
func TestLoadPrefersLocalWhenRemoteNotNewer(t *testing.T) {
	useLocalKernel(t)
	useCacheDir(t)

	srv, hits := fakeGitHub(t, func(base string) []map[string]any {
		return []map[string]any{
			releaseJSON("v0.7.4", base, true), // 比本地旧
		}
	}, map[string][]byte{
		ControlAssetName: []byte(fakeControlJS),
		DataAssetName:    []byte(fakeDataJS),
	})
	withGitHubBase(t, srv.URL)

	arts, info, err := LoadPreferred(context.Background(), "0.7.5")
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if info == nil || info.Version != "0.7.4" {
		t.Fatalf("仍应返回远程信息，实际 %+v", info)
	}
	if arts.Version != "0.7.5" {
		t.Errorf("内核版本应是本地应用版本 0.7.5，实际 %q", arts.Version)
	}
	if strings.Contains(arts.Source, "远程") {
		t.Errorf("不该用远程内核，实际来源 %q", arts.Source)
	}
	if atomic.LoadInt64(hits) != 0 {
		t.Errorf("不该下载任何产物，实际 %d", atomic.LoadInt64(hits))
	}
}

// 远程与本地同版本 → 也用本地（不重复下载）。
func TestLoadPrefersLocalWhenSameVersion(t *testing.T) {
	useLocalKernel(t)
	useCacheDir(t)

	srv, hits := fakeGitHub(t, func(base string) []map[string]any {
		return []map[string]any{
			releaseJSON("v0.7.5", base, true),
		}
	}, map[string][]byte{
		ControlAssetName: []byte(fakeControlJS),
		DataAssetName:    []byte(fakeDataJS),
	})
	withGitHubBase(t, srv.URL)

	arts, _, err := LoadPreferred(context.Background(), "0.7.5")
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if arts.Version != "0.7.5" {
		t.Errorf("内核版本应是 0.7.5，实际 %q", arts.Version)
	}
	if atomic.LoadInt64(hits) != 0 {
		t.Errorf("同版本不该下载，实际 %d", atomic.LoadInt64(hits))
	}
}

// 分支三：远程不可用（离线）→ 回退到内嵌内核，**不算错误**。
func TestLoadFallsBackToLocalWhenRemoteUnavailable(t *testing.T) {
	useLocalKernel(t)
	useCacheDir(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	withGitHubBase(t, srv.URL)

	arts, info, err := LoadPreferred(context.Background(), "0.7.5")
	if err != nil {
		t.Fatalf("远程不可用不该报错（应静默回退）：%v", err)
	}
	if info != nil {
		t.Errorf("查不到远程版本时 info 应为 nil，实际 %+v", info)
	}
	if arts == nil {
		t.Fatal("应回退到内嵌内核")
	}
	if arts.Version != "0.7.5" {
		t.Errorf("内核版本应是本地应用版本 0.7.5，实际 %q", arts.Version)
	}
	if string(arts.Control) != fakeControlJS {
		t.Error("应使用本地内核产物")
	}
}

// ---------- 缓存 ----------

// 第二次取同一版本时直接读缓存，不再下载。
func TestFetchRemoteKernelUsesCache(t *testing.T) {
	cacheRoot := useCacheDir(t)

	srv, hits := fakeGitHub(t, nil, map[string][]byte{
		ControlAssetName: []byte(fakeControlJS),
		DataAssetName:    []byte(fakeDataJS),
	})

	info := &RemoteInfo{
		Version:    "0.7.6",
		ControlURL: srv.URL + "/asset/" + ControlAssetName,
		DataURL:    srv.URL + "/asset/" + DataAssetName,
	}

	arts, err := FetchRemoteKernel(context.Background(), info)
	if err != nil {
		t.Fatalf("首次下载应成功：%v", err)
	}
	if arts.Version != "0.7.6" {
		t.Errorf("版本应是 0.7.6，实际 %q", arts.Version)
	}
	if atomic.LoadInt64(hits) != 2 {
		t.Errorf("首次应下载 2 个产物，实际 %d", atomic.LoadInt64(hits))
	}

	// 缓存文件应落在 <缓存根>/0.7.6/ 下
	for _, name := range []string{"control.js", "dataplane.js"} {
		p := filepath.Join(cacheRoot, "0.7.6", name)
		if _, err := os.Stat(p); err != nil {
			t.Errorf("缓存文件应存在：%s", p)
		}
	}

	// 再取一次：不该再下载
	arts2, err := FetchRemoteKernel(context.Background(), info)
	if err != nil {
		t.Fatalf("读缓存应成功：%v", err)
	}
	if atomic.LoadInt64(hits) != 2 {
		t.Errorf("命中缓存时不该再下载，实际下载 %d 次", atomic.LoadInt64(hits))
	}
	if !strings.Contains(arts2.Source, "缓存") {
		t.Errorf("来源应标明是缓存，实际 %q", arts2.Source)
	}
	if string(arts2.Control) != fakeControlJS {
		t.Error("缓存内容不对")
	}
}

// 超过大小上限的产物要被拒。
func TestFetchRemoteKernelRejectsOversized(t *testing.T) {
	useCacheDir(t)
	withoutMirrors(t)

	big := make([]byte, maxRemoteAssetSize+1)
	for i := range big {
		big[i] = 'x'
	}
	srv, _ := fakeGitHub(t, nil, map[string][]byte{
		ControlAssetName: big,
		DataAssetName:    []byte(fakeDataJS),
	})

	info := &RemoteInfo{
		Version:    "0.7.6",
		ControlURL: srv.URL + "/asset/" + ControlAssetName,
		DataURL:    srv.URL + "/asset/" + DataAssetName,
	}
	if _, err := FetchRemoteKernel(context.Background(), info); err == nil {
		t.Error("超大的产物必须被拒绝")
	}
}

// 空内容要被拒。
func TestFetchRemoteKernelRejectsEmpty(t *testing.T) {
	useCacheDir(t)
	withoutMirrors(t)

	srv, _ := fakeGitHub(t, nil, map[string][]byte{
		ControlAssetName: {},
		DataAssetName:    []byte(fakeDataJS),
	})
	info := &RemoteInfo{
		Version:    "0.7.6",
		ControlURL: srv.URL + "/asset/" + ControlAssetName,
		DataURL:    srv.URL + "/asset/" + DataAssetName,
	}
	if _, err := FetchRemoteKernel(context.Background(), info); err == nil {
		t.Error("空产物必须被拒绝")
	}
}

// info 为 nil 时要报错而不是 panic。
func TestFetchRemoteKernelNilInfo(t *testing.T) {
	if _, err := FetchRemoteKernel(context.Background(), nil); err == nil {
		t.Error("info 为 nil 时应报错")
	}
}
