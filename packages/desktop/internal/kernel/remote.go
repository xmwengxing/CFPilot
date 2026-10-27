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
// ⚠️ 目录选择遵循项目既有约定：桌面版的本地数据统一放在
// `~/.cfpilot-gui/` 下（见 internal/config.Dir() 与
// internal/update.DefaultDownloadPath），所以内核缓存也放在那里，
// 而不是另起一个 `~/.cfpilot/`。
//
// 测试可用环境变量 `CFPILOT_KERNEL_CACHE_DIR` 覆盖缓存根目录。

import (
	"context"
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

const (
	// ControlAssetName 是控制面内核产物在 Release 里的附件名。
	ControlAssetName = "cfpilot-kernel-control.js"
	// DataAssetName 是数据面内核产物在 Release 里的附件名。
	DataAssetName = "cfpilot-kernel-dataplane.js"
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
		controlURL, dataURL := findKernelAssets(rel.Assets)
		if controlURL == "" || dataURL == "" {
			// 这个发行版没带完整的内核资产，跳过
			continue
		}
		return &RemoteInfo{
			Version:    rel.Version,
			ControlURL: controlURL,
			DataURL:    dataURL,
		}, nil
	}
	return nil, fmt.Errorf("没有找到带内核产物的发行版")
}

// findKernelAssets 在附件列表里找两个内核产物。
//
// 返回空串表示没找到。
func findKernelAssets(assets []update.Asset) (controlURL, dataURL string) {
	for _, a := range assets {
		switch strings.ToLower(strings.TrimSpace(a.Name)) {
		case ControlAssetName:
			controlURL = a.URL
		case DataAssetName:
			dataURL = a.URL
		}
	}
	return controlURL, dataURL
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

	// ---- 1. 命中缓存就不下载 ----
	control := readCached(controlPath)
	data := readCached(dataPath)
	if control != nil && data != nil {
		return &Artifacts{
			Control: control,
			Data:    data,
			Build:   extractBuild(string(control)),
			Version: version,
			Source:  fmt.Sprintf("远程 %s（GitHub Release 缓存）", version),
		}, nil
	}

	// ---- 2. 下载 ----
	control, err = downloadAsset(ctx, info.ControlURL, "control.js")
	if err != nil {
		return nil, err
	}
	data, err = downloadAsset(ctx, info.DataURL, "dataplane.js")
	if err != nil {
		return nil, err
	}

	// ---- 3. 落缓存（失败不影响本次使用，只是下次要重新下载）----
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
		Source:  fmt.Sprintf("远程 %s（GitHub Release）", version),
	}, nil
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

	reqCtx, cancel := context.WithTimeout(ctx, remoteTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("下载 %s 失败：%w", name, err)
	}
	req.Header.Set("User-Agent", "CFPilot-Desktop")

	client := &http.Client{Timeout: remoteTimeout}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("下载 %s 失败：%w", name, err)
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载 %s 失败：HTTP %d", name, res.StatusCode)
	}

	// 多读 1 字节用于判断是否超限
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxRemoteAssetSize+1))
	if err != nil {
		return nil, fmt.Errorf("读取 %s 失败：%w", name, err)
	}
	if len(raw) > maxRemoteAssetSize {
		return nil, fmt.Errorf("%s 超过 %d 字节上限，疑似异常内容", name, maxRemoteAssetSize)
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("%s 内容为空", name)
	}
	return raw, nil
}
