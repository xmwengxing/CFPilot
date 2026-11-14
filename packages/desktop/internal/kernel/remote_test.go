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
	"crypto/sha256"
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

// checksumsFor 按 sha256sum 格式拼出两个产物的摘要清单。
func checksumsFor(control, data []byte) string {
	return fmt.Sprintf("%x  %s\n%x  %s\n", sha256.Sum256(control), ControlAssetName, sha256.Sum256(data), DataAssetName)
}

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
		// 资产名提取：兼容 /asset/<name> 与官方模板 /releases-web/download/<tag>/<name>
		// （审计 D1/C2 修复后，FetchRemoteInfo 一律构造官方下载路径）。
		var assetName string
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
			return
		case strings.HasPrefix(r.URL.Path, "/asset/"):
			assetName = strings.TrimPrefix(r.URL.Path, "/asset/")
		case strings.Contains(r.URL.Path, "/download/"):
			assetName = r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		default:
			w.WriteHeader(http.StatusNotFound)
			return
		}
		body, ok := assets[assetName]
		if !ok && assetName == ChecksumsAssetName {
			// 没有显式提供清单时，按当前资产内容现场生成一份 sha256sum
			body, ok = []byte(checksumsFor(assets[ControlAssetName], assets[DataAssetName])), true
		}
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		// 清单不计入「产物下载次数」：断言关心的是产物本身有没有重复下载
		if assetName != ChecksumsAssetName {
			atomic.AddInt64(&hits, 1)
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		_, _ = w.Write(body)
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
			},
			map[string]any{
				"name":                 ChecksumsAssetName,
				"browser_download_url": baseURL + "/asset/" + ChecksumsAssetName,
				"size":                 160,
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

	// 内核热更新通道基址同样指向假服务器：
	// assets map 里没有 VERSION 清单 → 404 → 通道按「不可用」处理，
	// 不影响既有用例的语义；通道相关用例自行覆盖这个环境变量。
	t.Setenv(kernelChannelBaseEnv, base+"/asset")
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
		Version:      "0.7.6",
		ControlURL:   srv.URL + "/asset/" + ControlAssetName,
		DataURL:      srv.URL + "/asset/" + DataAssetName,
		ChecksumsURL: srv.URL + "/asset/" + ChecksumsAssetName,
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
		Version:      "0.7.6",
		ControlURL:   srv.URL + "/asset/" + ControlAssetName,
		DataURL:      srv.URL + "/asset/" + DataAssetName,
		ChecksumsURL: srv.URL + "/asset/" + ChecksumsAssetName,
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
		Version:      "0.7.6",
		ControlURL:   srv.URL + "/asset/" + ControlAssetName,
		DataURL:      srv.URL + "/asset/" + DataAssetName,
		ChecksumsURL: srv.URL + "/asset/" + ChecksumsAssetName,
	}
	if _, err := FetchRemoteKernel(context.Background(), info); err == nil {
		t.Error("空产物必须被拒绝")
	}
}

// 摘要不匹配时必须拒绝（镜像 / 中间人篡改产物的形态）。
func TestFetchRemoteKernelRejectsTamperedAsset(t *testing.T) {
	useCacheDir(t)
	withoutMirrors(t)

	srv, _ := fakeGitHub(t, nil, map[string][]byte{
		ControlAssetName: []byte(fakeControlJS),
		DataAssetName:    []byte(fakeDataJS),
		// 清单描述的不是这两个产物
		ChecksumsAssetName: []byte(checksumsFor([]byte("tampered-control"), []byte("tampered-data"))),
	})
	info := &RemoteInfo{
		Version:      "0.7.6",
		ControlURL:   srv.URL + "/asset/" + ControlAssetName,
		DataURL:      srv.URL + "/asset/" + DataAssetName,
		ChecksumsURL: srv.URL + "/asset/" + ChecksumsAssetName,
	}
	if _, err := FetchRemoteKernel(context.Background(), info); err == nil {
		t.Fatal("摘要不匹配时必须拒绝远程内核")
	}
}

// 没有校验清单时也必须拒绝（宁可用旧的内嵌内核，也不部署未知代码）。
func TestFetchRemoteKernelRejectsMissingChecksums(t *testing.T) {
	useCacheDir(t)
	withoutMirrors(t)

	srv, _ := fakeGitHub(t, nil, map[string][]byte{
		ControlAssetName: []byte(fakeControlJS),
		DataAssetName:    []byte(fakeDataJS),
	})
	info := &RemoteInfo{
		Version:    "0.7.6",
		ControlURL: srv.URL + "/asset/" + ControlAssetName,
		DataURL:    srv.URL + "/asset/" + DataAssetName,
	}
	if _, err := FetchRemoteKernel(context.Background(), info); err == nil {
		t.Fatal("缺少校验清单时必须拒绝远程内核")
	}
}

// info 为 nil 时要报错而不是 panic。
func TestFetchRemoteKernelNilInfo(t *testing.T) {
	if _, err := FetchRemoteKernel(context.Background(), nil); err == nil {
		t.Error("info 为 nil 时应报错")
	}
}

// ---------- 供应链官方化（审计 D1/C2/D6/C5，与 CLI 对照）----------

// 镜像 API 返回非官方资产 URL 时，下载地址仍按官方模板构造（审计 D1/C2）。
func TestFetchRemoteInfoIgnoresMirrorAssetURLs(t *testing.T) {
	srv, _ := fakeGitHub(t, func(base string) []map[string]any {
		rel := releaseJSON("v0.7.6", base, true)
		// 篡改资产 URL 指向攻击者服务器（被接管的镜像 API 形态）
		assets := rel["assets"].([]map[string]any)
		for _, a := range assets {
			a["browser_download_url"] = "https://evil.example/attack/" + a["name"].(string)
		}
		return []map[string]any{rel}
	}, map[string][]byte{})
	withGitHubBase(t, srv.URL)

	info, err := FetchRemoteInfo(context.Background())
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if strings.Contains(info.ControlURL, "evil.example") ||
		strings.Contains(info.DataURL, "evil.example") ||
		strings.Contains(info.ChecksumsURL, "evil.example") {
		t.Errorf("下载地址不得取自镜像资产 URL：%+v", info)
	}
	if !strings.HasPrefix(info.ControlURL, update.ReleasesWebBase+"/download/v0.7.6/") {
		t.Errorf("控制面下载地址应按官方模板构造：%q", info.ControlURL)
	}
	if !strings.Contains(info.ChecksumsURL, ChecksumsAssetName) {
		t.Errorf("清单下载地址不对：%q", info.ChecksumsURL)
	}
}

// 携带路径穿越 tag 的发行版要被跳过（审计 D6）。
func TestFetchRemoteInfoSkipsPathTraversalTag(t *testing.T) {
	srv, _ := fakeGitHub(t, func(base string) []map[string]any {
		return []map[string]any{releaseJSON("v9.9.9/../../evil", base, true)}
	}, map[string][]byte{})
	withGitHubBase(t, srv.URL)
	if _, err := FetchRemoteInfo(context.Background()); err == nil {
		t.Error("携带路径穿越 tag 的发行版应被跳过")
	}
}

// cacheDir 拒绝含路径分隔符 / .. 的版本号（审计 D6 防御纵深）。
func TestCacheDirRejectsPathTraversal(t *testing.T) {
	useCacheDir(t)
	for _, v := range []string{"../evil", "0.7.6/../../evil", "a/b", "a\\b", ""} {
		if _, err := cacheDir(v); err == nil {
			t.Errorf("版本号 %q 应被拒绝", v)
		}
	}
	if _, err := cacheDir("0.7.6"); err != nil {
		t.Errorf("合法版本号不应被拒绝：%v", err)
	}
}

// 缓存清单被篡改时仍从官方重取并拒绝恶意缓存（审计 C5）。
func TestFetchRemoteKernelRefetchesChecksumsIgnoringCachedSums(t *testing.T) {
	cacheRoot := useCacheDir(t)
	withoutMirrors(t)

	// 预置缓存：本机攻击者植入的恶意产物 + 配套自洽清单
	malControl := []byte("const BUILD_VERSION = \"evil1111-evil2222\";\n// evil control\n")
	malData := []byte("const BUILD_VERSION = \"evil1111-evil2222\";\n// evil data\n")
	dir := filepath.Join(cacheRoot, "0.7.6")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "control.js"), malControl, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "dataplane.js"), malData, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SHA256SUMS"), []byte(checksumsFor(malControl, malData)), 0o644); err != nil {
		t.Fatal(err)
	}

	// 官方清单对应合法内容（与缓存里的恶意产物不符）
	srv, _ := fakeGitHub(t, nil, map[string][]byte{
		ControlAssetName: []byte(fakeControlJS),
		DataAssetName:    []byte(fakeDataJS),
	})
	info := &RemoteInfo{
		Version:      "0.7.6",
		ControlURL:   srv.URL + "/asset/" + ControlAssetName,
		DataURL:      srv.URL + "/asset/" + DataAssetName,
		ChecksumsURL: srv.URL + "/asset/" + ChecksumsAssetName,
	}
	arts, err := FetchRemoteKernel(context.Background(), info)
	if err != nil {
		t.Fatalf("应官方重取清单并重新下载合法产物：%v", err)
	}
	if string(arts.Control) != fakeControlJS {
		t.Error("缓存清单不作信任锚：恶意缓存产物应被拒，改用官方产物")
	}
}

// ---------- 内核热更新通道（kernel-latest） ----------

// useLocalKernelVersion 在本地内核目录里写入内置 VERSION 清单。
func useLocalKernelVersion(t *testing.T, seq int64, build string) {
	t.Helper()
	dir := os.Getenv("CFPILOT_KERNEL_DIR")
	if dir == "" {
		t.Fatal("useLocalKernelVersion 必须在 useLocalKernel 之后调用")
	}
	manifest := fmt.Sprintf(`{"seq": %d, "build": %q, "minToolVersion": ""}`, seq, build)
	if err := os.WriteFile(filepath.Join(dir, KernelVersionAssetName), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
}

// 通道用例的假服务器：/asset/<name> 提供 VERSION 与内核资产。
func channelAssets(t *testing.T, manifest string, assets map[string][]byte) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/asset/")
		if name == KernelVersionAssetName {
			_, _ = w.Write([]byte(manifest))
			return
		}
		body, ok := assets[name]
		if !ok && name == ChecksumsAssetName {
			body, ok = []byte(checksumsFor(assets[ControlAssetName], assets[DataAssetName])), true
		}
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	t.Setenv(kernelChannelBaseEnv, srv.URL+"/asset")
	return srv.URL
}

func TestParseKernelVersionManifest(t *testing.T) {
	m := parseKernelVersionManifest([]byte(`{"seq": 202611141000, "build": "aaa1111-bbbb2222", "minToolVersion": "0.40.6"}`))
	if m == nil {
		t.Fatal("合法清单不该解析失败")
	}
	if m.Seq != 202611141000 || m.Build != "aaa1111-bbbb2222" || m.MinToolVersion != "0.40.6" {
		t.Errorf("字段不匹配：%+v", m)
	}
	for _, bad := range []string{"{}", `{"seq": 1.5}`, `{"seq": -1}`, "not-json", "[]"} {
		if parseKernelVersionManifest([]byte(bad)) != nil {
			t.Errorf("%q 应解析失败", bad)
		}
	}
}

func TestIsChannelNewer(t *testing.T) {
	m := func(seq int64, build string) *KernelVersionManifest {
		return &KernelVersionManifest{Seq: seq, Build: build}
	}
	if !isChannelNewer(m(2, "b"), m(1, "a")) {
		t.Error("序号更高应视为新")
	}
	if isChannelNewer(m(1, "a"), m(2, "b")) {
		t.Error("序号更低不应视为新")
	}
	if !isChannelNewer(m(5, "b2"), m(5, "b1")) {
		t.Error("同序号不同指纹应视为新（同序号覆盖发布）")
	}
	if isChannelNewer(m(5, "b1"), m(5, "b1")) {
		t.Error("同序号同指纹不应视为新")
	}
	if !isChannelNewer(m(1, "a"), &KernelVersionManifest{}) {
		t.Error("内置没有清单（旧包）时任何通道内核都应视为新")
	}
}

// 分支零（新）：通道序号比内置新 → 用通道内核，来源带序号。
func TestLoadPrefersChannelWhenNewer(t *testing.T) {
	useLocalKernel(t)
	useLocalKernelVersion(t, 202611140000, "aaa1111-bbbb2222")
	useCacheDir(t)

	channelControl := "const BUILD_VERSION = \"ccc3333-dddd4444\";\n// channel control\n"
	channelData := "const BUILD_VERSION = \"ccc3333-dddd4444\";\n// channel data\n"
	channelAssets(t,
		fmt.Sprintf(`{"seq": 202611141000, "build": %q, "minToolVersion": ""}`, "ccc3333-dddd4444"),
		map[string][]byte{ControlAssetName: []byte(channelControl), DataAssetName: []byte(channelData)})

	arts, info, err := LoadPreferred(context.Background(), "0.40.6")
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if info == nil || info.Version != "k202611141000" {
		t.Fatalf("应返回通道内核信息，实际 %+v", info)
	}
	if string(arts.Control) != channelControl {
		t.Errorf("控制面应是通道下载的内容，实际 %q", string(arts.Control)[:40])
	}
	if arts.Build != "ccc3333-dddd4444" {
		t.Errorf("build 指纹应是通道产物的，实际 %q", arts.Build)
	}
}

// 分支零：通道序号不比内置新 → 走包 Release 通道（原有行为）。
func TestLoadPrefersChannelWhenNotNewer(t *testing.T) {
	useLocalKernel(t)
	useLocalKernelVersion(t, 202611150000, "aaa1111-bbbb2222")
	useCacheDir(t)

	// 通道给的序号更旧；Release 通道给 v0.7.4（也比 0.7.5 旧）→ 最终本地
	srv := channelAssets(t, `{"seq": 202611140000, "build": "ccc3333-dddd4444"}`, map[string][]byte{
		ControlAssetName: []byte("const BUILD_VERSION = \"ccc3333-dddd4444\";"),
		DataAssetName:    []byte("const BUILD_VERSION = \"ccc3333-dddd4444\";"),
	})
	withGitHubBase(t, srv)

	arts, _, err := LoadPreferred(context.Background(), "0.7.5")
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if strings.Contains(arts.Source, "远程") {
		t.Errorf("通道与 Release 都不更新，应用本地内核，实际 %q", arts.Source)
	}
}

// 分支零：通道要求更高工具版本 → 明确提示，不用远程内核。
func TestLoadPrefersLocalWhenChannelToolTooOld(t *testing.T) {
	useLocalKernel(t)
	useLocalKernelVersion(t, 202611140000, "aaa1111-bbbb2222")
	useCacheDir(t)

	channelAssets(t, `{"seq": 202611141000, "build": "ccc3333-dddd4444", "minToolVersion": "99.0.0"}`, map[string][]byte{
		ControlAssetName: []byte("const BUILD_VERSION = \"ccc3333-dddd4444\";"),
		DataAssetName:    []byte("const BUILD_VERSION = \"ccc3333-dddd4444\";"),
	})

	arts, _, err := LoadPreferred(context.Background(), "0.40.6")
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if strings.Contains(arts.Source, "远程") {
		t.Errorf("工具版本不足时不应使用远程内核，实际 %q", arts.Source)
	}
}

// 分支零：通道清单不可读（坏 JSON）→ 视为通道不可用，走包 Release 通道。
func TestLoadPrefersReleaseWhenChannelManifestBroken(t *testing.T) {
	useLocalKernel(t)
	useLocalKernelVersion(t, 202611140000, "aaa1111-bbbb2222")
	useCacheDir(t)

	// 同一台假服务器同时服务两个通道：
	// VERSION 资产返回坏 JSON → 通道按「不可用」处理；
	// /releases 提供 v0.7.6 → 包 Release 通道接管。
	srv, _ := fakeGitHub(t, func(base string) []map[string]any {
		return []map[string]any{releaseJSON("v0.7.6", base, true)}
	}, map[string][]byte{
		KernelVersionAssetName: []byte("not-json"),
		ControlAssetName:       []byte(fakeControlJS),
		DataAssetName:          []byte(fakeDataJS),
	})
	withGitHubBase(t, srv.URL)

	arts, info, err := LoadPreferred(context.Background(), "0.7.5")
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if info == nil || info.Version != "0.7.6" {
		t.Fatalf("应回退到包 Release 通道（v0.7.6），实际 %+v", info)
	}
	if string(arts.Control) != fakeControlJS {
		t.Errorf("应使用 Release 下载的内核，实际 build %q", arts.Build)
	}
}
