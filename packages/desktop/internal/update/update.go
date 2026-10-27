// Package update 实现应用内检查更新与下载。
//
// ## 为什么不用自动更新框架
//
// Electron 版曾经用 electron-updater，但它依赖代码签名与特定更新服务器配置。
// 这里直接查 GitHub Releases API，下载新版本并替换自己 ——
// 对本项目够用，且没有签名要求（用户手动确认后才执行）。
//
// ## 镜像回退（国内网络必需）
//
// GitHub 的 `objects.githubusercontent.com` 在国内经常连不上或极慢。
// 因此下载按以下顺序尝试，任一个成功即停：
//
//  1. 直连 GitHub（browser_download_url）
//  2. ghproxy 类镜像（前缀代理原 URL）
//
// ⚠️ 第三方镜像**可能失效或篡改内容**，因此：
//   - 只在直连失败时才用；
//   - 用完不做签名校验（本项目没签名），但会在日志里明确提示走的是镜像；
//   - **必须校验 content-length**：镜像截断是常见故障，
//     半截文件如果被当成完整包，用户装上去就是坏的。
package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Repo 是 GitHub 仓库。
const Repo = "xmwengxing/CFPilot"

// APIBase 是 GitHub Releases API（测试可覆盖）。
//
// 生产环境不要改；单元测试用 httptest 假服务器把它指向本地地址。
var APIBase = "https://api.github.com/repos/" + Repo + "/releases"

// Mirror 是一个下载镜像。
type Mirror struct {
	Name string
	// Prefix 是 URL 前缀，用法：Prefix + 原始URL
	Prefix string
}

// Mirrors 是下载镜像列表。
var Mirrors = []Mirror{
	{Name: "ghproxy.net", Prefix: "https://ghproxy.net/"},
	{Name: "gh-proxy.com", Prefix: "https://gh-proxy.com/"},
	{Name: "ghfast.top", Prefix: "https://ghfast.top/"},
}

// CheckResult 是检查更新的结果。
type CheckResult struct {
	// Current 是当前版本
	Current string `json:"current"`
	// Latest 是最新版本（没找到时为 nil）
	Latest string `json:"latest"`
	// HasUpdate 表示是否有新版本
	HasUpdate bool `json:"hasUpdate"`
	// DownloadURL 是新版本下载地址
	DownloadURL string `json:"downloadUrl"`
	// Notes 是发行说明
	Notes string `json:"notes"`
	// Error 是错误信息（成功时为空）
	Error string `json:"error,omitempty"`
}

// Release 是解析后的发行版信息。
type Release struct {
	Tag     string
	Version string
	URL     string
	Notes   string
	Assets  []Asset
}

// Asset 是发行版附件。
type Asset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
	Size int64  `json:"size"`
}

// versionRe 提取语义化版本号的核心三字段。
var versionRe = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

// ParseVersion 解析版本号，返回 [major, minor, patch]。
//
// 找不到合法版本号时返回 [0,0,0]（与 Electron 版一致）。
func ParseVersion(tag string) [3]int {
	m := versionRe.FindStringSubmatch(tag)
	if len(m) < 4 {
		return [3]int{0, 0, 0}
	}
	a, _ := strconv.Atoi(m[1])
	b, _ := strconv.Atoi(m[2])
	c, _ := strconv.Atoi(m[3])
	return [3]int{a, b, c}
}

// CompareVersion 比较两个版本号：a > b 返回正数，a < b 返回负数。
func CompareVersion(a, b [3]int) int {
	for i := 0; i < 3; i++ {
		if d := a[i] - b[i]; d != 0 {
			return d
		}
	}
	return 0
}

// Check 检查是否有新版本。
//
// 只看非 draft、非 prerelease 的发行版。
func Check(ctx context.Context, current string) *CheckResult {
	res := &CheckResult{Current: current}

	releases, err := fetchReleases(ctx)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	if len(releases) == 0 {
		res.Error = "没有找到发行版"
		return res
	}

	latest := releases[0]
	res.Latest = latest.Version
	res.DownloadURL = latest.URL
	if len(latest.Notes) > 2000 {
		res.Notes = latest.Notes[:2000]
	} else {
		res.Notes = latest.Notes
	}
	res.HasUpdate = CompareVersion(ParseVersion(latest.Tag), ParseVersion(current)) > 0
	return res
}

// fetchReleases 拉取并按版本降序排列的发行版列表。
//
// 按平台筛选资产：
//   - Windows 用 `windows-amd64.exe`
//   - Linux 用 `linux-<arch>`
//
// tag 前缀同时兼容 `desktop-v*` 与旧的 `gui-v*`。
func fetchReleases(ctx context.Context) ([]Release, error) {
	all, err := fetchAllReleases(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Release, 0, len(all))
	for _, r := range all {
		asset := pickAsset(r.Assets)
		if asset == nil {
			continue // 这个发行版没有本平台的包，跳过
		}
		r.URL = asset.URL
		out = append(out, r)
	}
	return out, nil
}

// FetchReleases 查询全部有效发行版（按版本降序）。
//
// ## 与包内私有 fetchReleases 的区别
//
//   - fetchReleases：只保留**带本平台安装包**的发行版（检查更新用）
//   - FetchReleases：保留全部有效发行版，并带上它们的**全部附件**
//
// kernel 包用它找「远程可用的内核产物」——
// 内核产物（cfpilot-kernel-*.js）与平台无关，
// 不能按平台过滤，否则会漏掉只发内核不发安装包的发行版。
func FetchReleases(ctx context.Context) ([]Release, error) {
	return fetchAllReleases(ctx)
}

// fetchAllReleases 拉取发行版列表，只做「tag 合法 + 非草稿 + 非预发布」的过滤。
//
// 不按平台过滤资产 —— 平台过滤留给调用方（见 fetchReleases）。
func fetchAllReleases(ctx context.Context) ([]Release, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, APIBase+"?per_page=20", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "CFPilot-Desktop")
	req.Header.Set("Accept", "application/vnd.github+json")

	client := &http.Client{Timeout: 20 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接 GitHub：%w", err)
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API 返回 %d", res.StatusCode)
	}

	var raw []struct {
		Tag        string  `json:"tag_name"`
		Draft      bool    `json:"draft"`
		Prerelease bool    `json:"prerelease"`
		Body       string  `json:"body"`
		Assets     []Asset `json:"assets"`
	}
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("GitHub API 返回格式异常：%w", err)
	}

	out := make([]Release, 0, len(raw))
	for _, r := range raw {
		// 只认 v* / desktop-v* / gui-v*
		//
		// ⚠️ **`v*` 是当前的正式 tag**（2026-10-27 起 release-desktop.yml 用
		// `tag_name: v<版本>`，与 npm 发布共用同一个 tag）。
		// 早期这里只认 `desktop-v*` / `gui-v*`，于是**一个发行版都找不到** ——
		// 界面的「检查更新」按钮永远显示「检查失败」。
		//
		// `desktop-v*` 是触发工作流的 git tag（不产生 Release），
		// `gui-v*` 是 Electron 时代的过渡 tag，都保留兼容。
		if !isReleaseTag(r.Tag) {
			continue
		}
		if r.Draft || r.Prerelease {
			continue
		}

		rel := Release{
			Tag:     r.Tag,
			Version: releaseVersion(r.Tag),
			Notes:   r.Body,
			Assets:  r.Assets,
		}
		// URL 尽力填成本平台安装包（没有就留空，调用方按需自己找资产）
		if asset := pickAsset(r.Assets); asset != nil {
			rel.URL = asset.URL
		}
		out = append(out, rel)
	}

	sort.Slice(out, func(i, j int) bool {
		return CompareVersion(ParseVersion(out[i].Tag), ParseVersion(out[j].Tag)) > 0
	})
	return out, nil
}

// pickAsset 按当前平台挑合适的附件。
func pickAsset(assets []Asset) *Asset {
	wantOS := runtime.GOOS
	wantArch := runtime.GOARCH

	for i := range assets {
		name := strings.ToLower(assets[i].Name)
		if !strings.Contains(name, wantOS) {
			continue
		}
		// 架构匹配（amd64 / arm64）
		if strings.Contains(name, wantArch) {
			return &assets[i]
		}
	}
	// 回落：只要 OS 匹配就行（例如 windows 包名里可能没写 amd64）
	for i := range assets {
		if strings.Contains(strings.ToLower(assets[i].Name), wantOS) {
			return &assets[i]
		}
	}
	return nil
}

// ------------------------------------------------------------------
// 下载
// ------------------------------------------------------------------

// Progress 是下载进度。
type Progress struct {
	Received int64  `json:"received"`
	Total    int64  `json:"total"`
	Source   string `json:"source"`
	Attempt  int    `json:"attempt"`
}

// Download 下载新版本，按「直连 → 镜像」顺序尝试。
//
// 返回下载后的本地路径。
//
// ## 关键约束
//
//  1. **失败要删掉半截文件**：否则下次会被误判成「已下载」。
//  2. **必须校验 content-length**：镜像截断是常见故障。
//  3. 每个源的失败原因都要回传，用户能看到「卡在哪个源」。
func Download(
	ctx context.Context,
	url string,
	targetPath string,
	onProgress func(Progress),
	onLog func(string, string),
) (string, error) {
	if onLog == nil {
		onLog = func(string, string) {}
	}
	if onProgress == nil {
		onProgress = func(Progress) {}
	}

	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return "", fmt.Errorf("无法创建下载目录：%w", err)
	}

	// 候选源：直连 + 各镜像
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

	var errors []string
	for i, src := range sources {
		attempt := i + 1
		onLog(fmt.Sprintf("尝试从 %s 下载（第 %d 次）…", src.Name, attempt), "info")

		err := downloadOne(ctx, src.URL, targetPath, src.Name, attempt, onProgress)
		if err == nil {
			onLog(fmt.Sprintf("下载完成（%s）", src.Name), "ok")
			return targetPath, nil
		}
		errors = append(errors, fmt.Sprintf("%s: %v", src.Name, err))
		onLog(fmt.Sprintf("%s 下载失败：%v", src.Name, err), "warn")
	}

	return "", fmt.Errorf("所有下载源均失败 —— %s", strings.Join(errors, "；"))
}

// downloadOne 从单个 URL 下载。
func downloadOne(
	ctx context.Context,
	url, targetPath, sourceName string,
	attempt int,
	onProgress func(Progress),
) error {
	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "CFPilot-Desktop")

	client := &http.Client{Timeout: 10 * time.Minute}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}

	total := res.ContentLength
	out, err := os.Create(targetPath)
	if err != nil {
		return err
	}

	received := int64(0)
	buf := make([]byte, 64*1024)
	for {
		n, readErr := res.Body.Read(buf)
		if n > 0 {
			if _, wErr := out.Write(buf[:n]); wErr != nil {
				_ = out.Close()
				cleanup(targetPath)
				return wErr
			}
			received += int64(n)
			onProgress(Progress{Received: received, Total: total, Source: sourceName, Attempt: attempt})
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			_ = out.Close()
			cleanup(targetPath)
			return readErr
		}
	}
	if err := out.Close(); err != nil {
		cleanup(targetPath)
		return err
	}

	// 校验完整性（镜像截断是常见故障）
	if total > 0 && received != total {
		cleanup(targetPath)
		return fmt.Errorf("下载不完整：%d/%d 字节", received, total)
	}
	if received == 0 {
		cleanup(targetPath)
		return fmt.Errorf("下载内容为空")
	}
	return nil
}

// cleanup 删掉半截文件。
func cleanup(path string) {
	_ = os.Remove(path)
}

// DefaultDownloadPath 返回新版本的落盘位置（配置目录下的 updates/）。
func DefaultDownloadPath(version string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	dir := filepath.Join(home, ".cfpilot-gui", "updates")
	name := "cfpilot-" + version
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(dir, name)
}

/**
 * isReleaseTag 判断 tag 是否是有效的发行版 tag。
 *
 * 接受的���缀（去掉前缀后须是合法 semver）：
 *   v         —— 当前正式（release-desktop.yml 的 tag_name）
 *   desktop-v —— Go 版工作流触发用
 *   gui-v     —— Electron 时代过渡
 */
func isReleaseTag(tag string) bool {
	return releaseVersion(tag) != ""
}

/**
 * releaseVersion 从 tag 里提取版本号（不含前缀）。
 *
 * 不是合法 semver 时返回空串。
 */
func releaseVersion(tag string) string {
	t := strings.TrimSpace(tag)
	for _, prefix := range []string{"desktop-v", "gui-v", "v"} {
		if strings.HasPrefix(t, prefix) {
			v := strings.TrimPrefix(t, prefix)
			if semverRe.MatchString(v) {
				return v
			}
			return ""
		}
	}
	return ""
}

// semverRe 匹配 x.y.z 形式的版本号。
var semverRe = regexp.MustCompile(`^\d+\.\d+\.\d+`)
