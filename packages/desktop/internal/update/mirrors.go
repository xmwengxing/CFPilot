package update

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"runtime"
	"strings"
	"time"
)

// ------------------------------------------------------------------
// 镜像回退（国内网络必需）
// ------------------------------------------------------------------
//
// ## 为什么
//
// 直连 `api.github.com` 在国内经常超时（实测 12 秒连不上），
// 直连 `github.com` 也可能被重置。
// 结果就是「检查更新」「拉远程内核」这些本该有兜底的操作直接失败。
//
// ## 三级通道
//
//  1. 直连 `api.github.com`
//  2. 镜像代理的 `api.github.com`（实测多数镜像的 API 通道不通，有的能用）
//  3. **免 API 通道**：只用 `github.com` 的 URL
//     （`releases/latest` 的 302 里带版本号）——
//     这条最可靠，因为**任何下载镜像都能代理 github.com**。
//
// 第 3 条拿不到「全部资产列表」，只能按命名约定构造已知资产名的 URL。
// 本项目的资产命名是稳定的：
//
//	cfpilot-<版本>-<os>-<arch>[.exe]   桌面版三平台
//	cfpilot-kernel-control.js           数据面内核（固定名）
//	cfpilot-kernel-dataplane.js         控制面内核（固定名）
//	CFPilot-control.zip / CFPilot-dataplane.zip
//
// ⚠️ 与 CLI 版 packages/cli/src/shared/github-mirrors.ts 语义一致
// （AGENTS.md §2.2：两端行为必须一致）。

// RepoOwner / RepoName 是 GitHub 仓库坐标。
const (
	RepoOwner = "xmwengxing"
	RepoName  = "CFPilot"
)

// ReleasesWebBase 是 github.com 上的发行版页基址（免 API 通道用）。
var ReleasesWebBase = "https://github.com/" + RepoOwner + "/" + RepoName + "/releases"

// apiTimeout 是 API 查询的超时。
const apiTimeout = 20 * time.Second

// FetchAllReleasesFallback 拉取发行版列表，带镜像回退。
//
// 与 fetchAllReleases 的区别：这里**不会因为直连失败就返回错误**，
// 而是依次尝试镜像，最后再走免 API 通道。
// 全都失败才返回错误（错误信息里带每个源的失败原因）。
func FetchAllReleasesFallback(ctx context.Context) ([]Release, error) {
	var errs []string

	// ---- 通道 1 + 2：API（含镜像）----
	apiURL := APIBase + "?per_page=20"
	sources := []struct {
		Name string
		URL  string
	}{{Name: "GitHub API", URL: apiURL}}
	for _, m := range Mirrors {
		sources = append(sources, struct {
			Name string
			URL  string
		}{Name: m.Name + " API", URL: m.Prefix + apiURL})
	}

	for _, src := range sources {
		releases, err := fetchReleasesFrom(ctx, src.URL)
		if err == nil && len(releases) > 0 {
			if src.Name != "GitHub API" {
				// 用了镜像就要说清楚 —— 用户需要知道「当前走的是代理」
				log.Printf("[cfpilot] 直连 GitHub API 不可用，已改用镜像 %s", src.Name)
			}
			return releases, nil
		}
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", src.Name, err))
		}
	}

	// ---- 通道 3：免 API ----
	if release, err := fetchLatestReleaseWithoutAPI(ctx); err == nil {
		log.Printf("[cfpilot] GitHub API 与镜像均不可用，已改用免 API 通道（版本 %s）", release.Version)
		return []Release{release}, nil
	} else {
		errs = append(errs, fmt.Sprintf("免 API 通道: %v", err))
	}

	return nil, fmt.Errorf("无法获取发行版列表 —— %s", strings.Join(errs, "；"))
}

// fetchReleasesFrom 从一个 URL 拉发行版列表。
func fetchReleasesFrom(ctx context.Context, url string) ([]Release, error) {
	reqCtx, cancel := context.WithTimeout(ctx, apiTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "CFPilot-Desktop")
	req.Header.Set("Accept", "application/vnd.github+json")

	client := &http.Client{Timeout: apiTimeout}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return parseReleases(res.Body)
}

// fetchLatestReleaseWithoutAPI 用「免 API 通道」取最新发行版。
//
// 做法：GET <repo>/releases/latest → 302 → Location 里带 `tag/v0.8.1`。
//
// ⚠️ 必须**禁止自动跟随重定向**：Go 的 http.Client 默认跟随，
// 跟到最终页面就拿不到 Location 了。
func fetchLatestReleaseWithoutAPI(ctx context.Context) (Release, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	var errs []string
	for _, src := range downloadSources(ReleasesWebBase + "/latest") {
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, src.URL, nil)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", src.Name, err))
			continue
		}
		req.Header.Set("User-Agent", "CFPilot-Desktop")

		client := &http.Client{
			Timeout: 15 * time.Second,
			// 禁止自动跟随 —— 否则读不到 Location
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
		res, err := client.Do(req)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", src.Name, err))
			continue
		}
		_ = res.Body.Close()

		location := res.Header.Get("Location")
		version := versionFromReleaseURL(location)
		if version == "" {
			errs = append(errs, fmt.Sprintf("%s: HTTP %d 且 Location 里没有版本号", src.Name, res.StatusCode))
			continue
		}

		tag := "v" + version
		release := Release{
			Tag:     tag,
			Version: version,
			URL:     fmt.Sprintf("%s/download/%s/%s", ReleasesWebBase, tag, DesktopAssetName(version, runtime.GOOS, runtime.GOARCH)),
			Assets:  fixedNameAssets(),
		}
		return release, nil
	}
	return Release{}, fmt.Errorf("%s", strings.Join(errs, "；"))
}

// versionFromReleaseURL 从发行版 URL 里解析版本号。
//
// 支持：
//
//	https://github.com/o/r/releases/tag/v0.8.1          → 0.8.1
//	https://github.com/o/r/releases/download/v0.8.1/x.js → 0.8.1
func versionFromReleaseURL(url string) string {
	if url == "" {
		return ""
	}
	// /releases/tag/v0.8.1 或 /releases/download/v0.8.1/xxx
	idx := strings.Index(url, "/releases/")
	if idx < 0 {
		return ""
	}
	rest := url[idx+len("/releases/"):]
	rest = strings.TrimPrefix(rest, "tag/")
	rest = strings.TrimPrefix(rest, "download/")
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	rest = strings.TrimPrefix(rest, "v")
	// 只留数字与点
	var b strings.Builder
	for _, r := range rest {
		if (r >= '0' && r <= '9') || r == '.' {
			b.WriteRune(r)
		}
	}
	cleaned := strings.Trim(b.String(), ".")
	if cleaned == "" {
		return ""
	}
	// 至少要有 major.minor
	if !strings.Contains(cleaned, ".") {
		return ""
	}
	return cleaned
}

// DesktopAssetName 按平台与版本拼出桌面版安装包名。
//
// 与 CLI 版 shared/github-mirrors.ts 的 desktopAssetName 一致。
func DesktopAssetName(version, goos, goarch string) string {
	ext := ""
	if goos == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf("cfpilot-%s-%s-%s%s", version, goos, goarch, ext)
}

// fixedNameAssets 返回与版本无关的固定名资产。
//
// 这些资产可以直接用 `releases/latest/download/<名字>` 取，
// 不用先知道版本号 —— 免 API 通道就靠它们。
func fixedNameAssets() []Asset {
	base := ReleasesWebBase + "/latest/download/"
	return []Asset{
		{Name: "cfpilot-kernel-control.js", URL: base + "cfpilot-kernel-control.js"},
		{Name: "cfpilot-kernel-dataplane.js", URL: base + "cfpilot-kernel-dataplane.js"},
		{Name: "CFPilot-control.zip", URL: base + "CFPilot-control.zip"},
		{Name: "CFPilot-dataplane.zip", URL: base + "CFPilot-dataplane.zip"},
	}
}

// downloadSources 生成「直连 + 各镜像」的候选源列表。
func downloadSources(url string) []struct {
	Name string
	URL  string
} {
	sources := []struct {
		Name string
		URL  string
	}{{Name: "GitHub", URL: url}}
	for _, m := range Mirrors {
		sources = append(sources, struct {
			Name string
			URL  string
		}{Name: m.Name, URL: m.Prefix + url})
	}
	return sources
}
