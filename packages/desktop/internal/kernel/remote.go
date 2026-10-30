package kernel

// 远程内核产物的获取与缓存。
//
// ## 为什么需要远程内核
//
// 内核产物（control.js / dataplane.js）原先用 `go:embed` 内嵌进 exe，
// 于是**部署用的代码被应用版本绑死**：用户没升级应用，就只能部署旧内核。
//
// 现在 Release 会同时发布两个内核资产：
//
//	cfpilot-kernel-control.js
//	cfpilot-kernel-dataplane.js
//
// 桌面版可以在运行时把**更新的内核**拉下来用于部署 ——
// 应用版本与内核版本从此解耦。
//
// ## 缓存
//
// 下载过的内核缓存在 `~/.cfpilot-gui/kernel/<版本>/`：
//
//	control.js
//	dataplane.js
//
// 命中缓存就不重复下载（离线时也能部署）。
//
// ## 完整性校验
//
// 远程产物会被上传到**用户的 Cloudflare 账号**里运行，所以「下载成功」
// 不能当成「可以部署」：Release 同时发布 `cfpilot-kernel-SHA256SUMS`，
// 本包从**官方 GitHub 地址**（不走镜像）取清单，
// 再逐个比对下载到的产物与缓存文件。
//
// 清单取不到 / 摘要不匹配 → 返回错误，由 LoadPreferred 回退到内嵌内核。
// ⚠️ 不从镜像取清单：镜像若能替换产物，就能一并替换清单。
//
// ⚠️ 目录选择遵循项目既有约定：桌面版的本地数据统一放在
// `~/.cfpilot-gui/` 下（见 internal/config.Dir() 与
// internal/update.DefaultDownloadPath），所以内核缓存也放在那里，
// 而不是另起一个 `~/.cfpilot/`。
//
// 测试可用环境变量 `CFPILOT_KERNEL_CACHE_DIR` 覆盖缓存根目录。

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/update"
)

// downloadSources 生成「直连 + 各镜像」的候选源列表。
//
// 与 update 包的镜像表保持一致（update.Mirrors 是唯一真相）。
func downloadSources(url string) []struct {
	Name string
	URL  string
} {
	sources := []struct {
		Name string
		URL  string
	}{{Name: "GitHub", URL: url}}
	for _, m := range update.Mirrors {
		sources = append(sources, struct {
			Name string
			URL  string
		}{Name: m.Name, URL: m.Prefix + url})
	}
	return sources
}

const (
	// ControlAssetName 是控制面内核产物在 Release 里的附件名。
	ControlAssetName = "cfpilot-kernel-control.js"
	// DataAssetName 是数据面内核产物在 Release 里的附件名。
	DataAssetName = "cfpilot-kernel-dataplane.js"
	// ChecksumsAssetName 是内核摘要清单的附件名（sha256sum 格式）。
	ChecksumsAssetName = "cfpilot-kernel-SHA256SUMS"
)

// cacheDirEnv 覆盖缓存根目录（测试用）。
const cacheDirEnv = "CFPILOT_KERNEL_CACHE_DIR"

// maxRemoteAssetSize 是单个远程内核产物的字节数上限（10MB）。
//
// 内核产物正常只有几十 KB，10MB 足够；上限的作用是
// 防止下到 HTML 错误页或垃圾数据把磁盘塞满。
const maxRemoteAssetSize = 10 << 20

// remoteTimeout 是远程查询 / 下载的超时时间。
const remoteTimeout = 20 * time.Second

// remoteQueryTimeout 是「查询远程版本」的超时时间。
//
// 比下载短：版本查询只是一次 GitHub API 调用，
// 网络不通时用户不该干等（部署要立刻开始）。
const remoteQueryTimeout = 6 * time.Second

// RemoteInfo 是远程可用内核的信息。
type RemoteInfo struct {
	// Version 是远程内核版本（semver，如 "0.7.6"）
	Version string
	// ControlURL / DataURL 是两个内核产物的下载地址
	ControlURL string
	DataURL    string
	// ChecksumsURL 是摘要清单的下载地址（空串 = 该发行版没有清单）
	ChecksumsURL string
}

// FetchRemoteInfo 查询最新 Release 里的内核资产。
//
// 找不到 / 网络失败时返回 (nil, err)。
//
// 「最新」的定义：**版本号最高的、且同时带两个内核资产的发行版**。
// 发行版列表已按版本降序排列，所以第一个满足条件的就是最新的。
func FetchRemoteInfo(ctx context.Context) (*RemoteInfo, error) {
	releases, err := update.FetchReleases(ctx)
	if err != nil {
		return nil, err
	}
	for _, rel := range releases {
		controlURL, dataURL, checksumsURL := findKernelAssets(rel.Assets)
		if controlURL == "" || dataURL == "" {
			// 这个发行版没带完整的内核资产，跳过
			continue
		}
		return &RemoteInfo{
			Version:      rel.Version,
			ControlURL:   controlURL,
			DataURL:      dataURL,
			ChecksumsURL: checksumsURL,
		}, nil
	}
	return nil, fmt.Errorf("没有找到带内核产物的发行版")
}

// findKernelAssets 在附件列表里找内核产物与摘要清单。
//
// 返回空串表示没找到。
func findKernelAssets(assets []update.Asset) (controlURL, dataURL, checksumsURL string) {
	for _, a := range assets {
		switch strings.ToLower(strings.TrimSpace(a.Name)) {
		case ControlAssetName:
			controlURL = a.URL
		case DataAssetName:
			dataURL = a.URL
		case strings.ToLower(ChecksumsAssetName):
			checksumsURL = a.URL
		}
	}
	return controlURL, dataURL, checksumsURL
}

// FetchRemoteKernel 下载指定版本的内核产物，缓存到 ~/.cfpilot-gui/kernel/<version>/。
//
// 已缓存则直接读缓存（不重复下载）。
//
// 产物的 Build 指纹仍从源码里提取（extractBuild）—— 那是精确指纹；
// Version 直接取 Release 的版本号。
func FetchRemoteKernel(ctx context.Context, info *RemoteInfo) (*Artifacts, error) {
	if info == nil {
		return nil, fmt.Errorf("远程内核信息为空")
	}
	version := strings.TrimSpace(info.Version)
	if version == "" {
		return nil, fmt.Errorf("远程内核版本号为空")
	}

	dir, err := cacheDir(version)
	if err != nil {
		return nil, err
	}
	controlPath := filepath.Join(dir, "control.js")
	dataPath := filepath.Join(dir, "dataplane.js")
	sumsPath := filepath.Join(dir, "SHA256SUMS")

	// ---- 1. 先取（或复用）校验清单 ----
	sumsText := readCached(sumsPath)
	sums := parseChecksums(string(sumsText))
	if !hasBothDigests(sums) {
		fetched, fetchedSums, fetchErr := downloadChecksums(ctx, info)
		if fetchErr != nil {
			return nil, fetchErr
		}
		sumsText = []byte(fetched)
		sums = fetchedSums
	}

	// ---- 2. 缓存命中也要校验（缓存文件同样会被篡改或写坏）----
	control := readCached(controlPath)
	if control != nil {
		if err := verifyAsset(ControlAssetName, control, sums); err != nil {
			log.Printf("[cfpilot] 缓存的控制面内核校验失败，已丢弃：%v", err)
			_ = os.Remove(controlPath)
			control = nil
		}
	}
	data := readCached(dataPath)
	if data != nil {
		if err := verifyAsset(DataAssetName, data, sums); err != nil {
			log.Printf("[cfpilot] 缓存的数据面内核校验失败，已丢弃：%v", err)
			_ = os.Remove(dataPath)
			data = nil
		}
	}
	if control != nil && data != nil {
		return &Artifacts{
			Control: control,
			Data:    data,
			Build:   extractBuild(string(control)),
			Version: version,
			Source:  fmt.Sprintf("远程 %s（GitHub Release 缓存，已校验）", version),
		}, nil
	}

	// ---- 3. 下载（允许镜像）并逐个校验 ----
	if control == nil {
		control, err = downloadAsset(ctx, info.ControlURL, "control.js")
		if err != nil {
			return nil, err
		}
		if err := verifyAsset(ControlAssetName, control, sums); err != nil {
			return nil, err
		}
	}
	if data == nil {
		data, err = downloadAsset(ctx, info.DataURL, "dataplane.js")
		if err != nil {
			return nil, err
		}
		if err := verifyAsset(DataAssetName, data, sums); err != nil {
			return nil, err
		}
	}

	// ---- 4. 落缓存（失败不影响本次使用，只是下次要重新下载）----
	if err := writeCached(sumsPath, sumsText); err != nil {
		log.Printf("[cfpilot] 写入内核缓存失败：%v", err)
	}
	if err := writeCached(controlPath, control); err != nil {
		log.Printf("[cfpilot] 写入内核缓存失败：%v", err)
	}
	if err := writeCached(dataPath, data); err != nil {
		log.Printf("[cfpilot] 写入内核缓存失败：%v", err)
	}

	return &Artifacts{
		Control: control,
		Data:    data,
		Build:   extractBuild(string(control)),
		Version: version,
		Source:  fmt.Sprintf("远程 %s（GitHub Release，已校验）", version),
	}, nil
}

// parseChecksums 解析 sha256sum 格式的清单（文件名 → 小写十六进制摘要）。
//
// 接受 `\t` 或空格分隔、以及二进制模式标记 `*` 前缀；其他行忽略。
func parseChecksums(text string) map[string]string {
	out := make(map[string]string)
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		digest := strings.ToLower(fields[0])
		if len(digest) != 64 {
			continue
		}
		name := strings.ToLower(strings.TrimPrefix(fields[1], "*"))
		out[name] = digest
	}
	return out
}

// hasBothDigests 判断清单是否包含两个内核产物的摘要。
func hasBothDigests(sums map[string]string) bool {
	if len(sums) == 0 {
		return false
	}
	_, hasControl := sums[strings.ToLower(ControlAssetName)]
	_, hasData := sums[strings.ToLower(DataAssetName)]
	return hasControl && hasData
}

// downloadChecksums 从**官方地址**（不走镜像）取内核摘要清单。
func downloadChecksums(ctx context.Context, info *RemoteInfo) (string, map[string]string, error) {
	if strings.TrimSpace(info.ChecksumsURL) == "" {
		return "", nil, fmt.Errorf(
			"Release %s 未发布 %s，无法校验内核完整性", info.Version, ChecksumsAssetName)
	}
	raw, err := downloadAssetFrom(ctx, info.ChecksumsURL, ChecksumsAssetName)
	if err != nil {
		return "", nil, fmt.Errorf("获取内核校验清单失败：%w", err)
	}
	text := string(raw)
	sums := parseChecksums(text)
	if !hasBothDigests(sums) {
		return "", nil, fmt.Errorf("内核校验清单缺少完整摘要，拒绝使用未校验的远程内核")
	}
	return text, sums, nil
}

// verifyAsset 校验一份内核产物；不匹配时返回错误。
func verifyAsset(assetName string, content []byte, sums map[string]string) error {
	expected, ok := sums[strings.ToLower(assetName)]
	if !ok {
		return fmt.Errorf("校验清单缺少 %s 的摘要", assetName)
	}
	actual := fmt.Sprintf("%x", sha256.Sum256(content))
	if actual != expected {
		return fmt.Errorf(
			"内核产物 %s 摘要不匹配（期望 %s…，实际 %s…）—— 已拒绝使用",
			assetName, expected[:12], actual[:12])
	}
	return nil
}

// LoadPreferred 返回「应该用于部署」的内核。
//
// 语义：远程版本比 currentVersion 新 → 用远程；否则用内嵌。
// 返回的第二个值是远程信息（可能为 nil，表示没查到远程版本）。
//
// ## 返回值约定
//
//   - artifacts：实际可用于部署的内核。**只有连内嵌内核都拿不到时**才会是 nil。
//   - info：查到的远程内核信息；没查到（离线 / 没有带内核的发行版）时为 nil。
//   - err：非空表示「发生了降级」或「彻底失败」：
//   - 远程查询失败（离线）→ **不算错误**，直接用内嵌内核，err 为 nil
//   - 远程版本更新但下载失败 → err 非空，artifacts 是**内嵌内核**（调用方应给警告而不是直接失败）
//   - 内嵌内核也拿不到 → err 非空且 artifacts 为 nil
func LoadPreferred(ctx context.Context, currentVersion string) (*Artifacts, *RemoteInfo, error) {
	current := strings.TrimSpace(currentVersion)

	// ---- 1. 查远程版本 ----
	//
	// 离线 / GitHub 不可达是**正常情况**，不算错误：
	// 直接用内嵌内核继续。
	//
	// ⚠️ 查询超时压到 6 秒：网络不通时不能让用户干等，
	// 部署必须立刻开始。
	queryCtx, cancelQuery := context.WithTimeout(ctx, remoteQueryTimeout)
	info, err := FetchRemoteInfo(queryCtx)
	cancelQuery()
	if err != nil {
		info = nil
	}

	// ---- 2. 远程比本地新 → 用远程 ----
	if info != nil && CompareSemver(info.Version, current) > 0 {
		remote, rErr := FetchRemoteKernel(ctx, info)
		if rErr == nil {
			return remote, info, nil
		}
		// 下载失败 → 降级到内嵌
		local, lErr := loadLocal(current)
		if lErr != nil {
			return nil, info, fmt.Errorf(
				"远程内核 %s 下载失败：%v；且本地内核不可用：%w", info.Version, rErr, lErr)
		}
		return local, info, fmt.Errorf("远程内核 %s 下载失败，已改用本地内核：%w", info.Version, rErr)
	}

	// ---- 3. 用内嵌内核 ----
	local, err := loadLocal(current)
	if err != nil {
		return nil, info, err
	}
	return local, info, nil
}

// loadLocal 加载本地（内嵌 / 目录）内核，并打上版本号。
func loadLocal(version string) (*Artifacts, error) {
	a, err := Load()
	if err != nil {
		return nil, err
	}
	a.Version = strings.TrimSpace(version)
	return a, nil
}

// cacheDir 返回某个版本的远程内核缓存目录。
//
// 默认在 ~/.cfpilot-gui/kernel/<版本>/（桌面版本地数据的统一位置）。
func cacheDir(version string) (string, error) {
	root := strings.TrimSpace(os.Getenv(cacheDirEnv))
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("无法定位用户主目录：%w", err)
		}
		root = filepath.Join(home, ".cfpilot-gui", "kernel")
	}
	return filepath.Join(root, version), nil
}

// readCached 读缓存文件；没有或为空时返回 nil。
func readCached(path string) []byte {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) == 0 {
		return nil
	}
	return raw
}

// writeCached 原子写缓存文件（先写临时文件再改名）。
func writeCached(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// downloadAsset 下载单个内核产物。
//
// 带 20 秒超时与 10MB 大小上限（防止下到垃圾数据）。
func downloadAsset(ctx context.Context, url, name string) ([]byte, error) {
	if strings.TrimSpace(url) == "" {
		return nil, fmt.Errorf("%s 的下载地址为空", name)
	}

	// 直连 + 各镜像（国内直连 GitHub 经常超时）
	//
	// ⚠️ 与 CLI 版 packages/cli/src/deploy/kernel-remote.ts 的 downloadAsset 一致。
	var errs []string
	for _, src := range downloadSources(url) {
		raw, err := downloadAssetFrom(ctx, src.URL, name)
		if err == nil {
			return raw, nil
		}
		errs = append(errs, fmt.Sprintf("%s: %v", src.Name, err))
	}
	return nil, fmt.Errorf("下载 %s 失败 —— %s", name, strings.Join(errs, "；"))
}

// downloadAssetFrom 从单个 URL 下载一个内核产物。
func downloadAssetFrom(ctx context.Context, url, name string) ([]byte, error) {
	reqCtx, cancel := context.WithTimeout(ctx, remoteTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("%w", err)
	}
	req.Header.Set("User-Agent", "CFPilot-Desktop")

	client := &http.Client{Timeout: remoteTimeout}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w", err)
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}

	// 多读 1 字节用于判断是否超限
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxRemoteAssetSize+1))
	if err != nil {
		return nil, fmt.Errorf("读取失败：%w", err)
	}
	if len(raw) > maxRemoteAssetSize {
		return nil, fmt.Errorf("超过 %d 字节上限，疑似异常内容", maxRemoteAssetSize)
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("内容为空")
	}
	return raw, nil
}
