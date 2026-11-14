package kernel

// 内核热更新通道：固定滚动 Release（kernel-latest），与包版本解耦。
//
// ## 为什么需要独立通道
//
// 包 Release 的内核资产以 tag 的包版本号参与「最新」判定 ——
// 只改内核时不发新包，那条通道就永远看不到新内核。
// 固定 tag `kernel-latest` 由内核发布工作流单独维护（覆盖上传），
// 内核序号只随内核变动递增，与包版本完全无关。
//
// ## 版本序号
//
// BUILD_VERSION 是内容哈希、比不了先后；通道清单里另带一个
// 单调递增的纯数字序号（UTC yyyymmddHHMM）作为「谁更新」的判据。
// 内嵌内核的序号锚点在 `assets/cfpilot-kernel-VERSION`
// （构建时生成；包发布时间 ≥ 任何已有内核发布 → 内置序号天然不落后）。
//
// ## 与 CLI 版的对照
//
// 语义与 `packages/cli/src/deploy/kernel-remote.ts` 的内核通道一致：
// 清单只影响「要不要拉新」，最终产物仍要过官方 SHA256SUMS 校验
// （清单走 downloadAsset 的镜像回退是安全的 —— 被篡改的清单最多
// 引发一次注定失败的下载）。

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/update"
)

const (
	// KernelChannelTag 固定滚动 tag：内核热更新通道。
	KernelChannelTag = "kernel-latest"
	// KernelVersionAssetName 通道版本清单的资产名。
	KernelVersionAssetName = "cfpilot-kernel-VERSION"
)

// kernelChannelBaseEnv 覆盖通道基址（测试用）。
const kernelChannelBaseEnv = "CFPILOT_KERNEL_CHANNEL_BASE"

// KernelVersionManifest 是通道版本清单。
type KernelVersionManifest struct {
	// Seq 内核序号（UTC yyyymmddHHMM，纯数字单调递增）
	Seq int64 `json:"seq"`
	// Build 构建指纹（BUILD_VERSION）；同序号时识别内容变化
	Build string `json:"build"`
	// MinToolVersion 最低工具版本（空串 = 未声明）
	MinToolVersion string `json:"minToolVersion"`
}

// parseKernelVersionManifest 解析通道清单；格式不对返回 nil。
func parseKernelVersionManifest(raw []byte) *KernelVersionManifest {
	var m KernelVersionManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	if m.Seq <= 0 {
		return nil
	}
	return &m
}

// channelAssetURL 构造通道资产地址（测试基址可覆盖）。
func channelAssetURL(asset string) string {
	if base := strings.TrimSpace(os.Getenv(kernelChannelBaseEnv)); base != "" {
		return strings.TrimRight(base, "/") + "/" + asset
	}
	return update.ReleasesWebBase + "/download/" + KernelChannelTag + "/" + asset
}

// fetchChannelVersion 查询通道最新内核清单。
//
// 失败（离线 / 通道尚未发布 / 清单格式不对）返回 nil —— 都是正常情况，
// 调用方按「通道不可用」继续走包 Release 通道。
func fetchChannelVersion(ctx context.Context) *KernelVersionManifest {
	qctx, cancel := context.WithTimeout(ctx, remoteQueryTimeout)
	defer cancel()
	raw, err := downloadAssetFrom(qctx, channelAssetURL(KernelVersionAssetName), KernelVersionAssetName)
	if err != nil {
		return nil
	}
	return parseKernelVersionManifest(raw)
}

// loadBuiltinKernelVersion 读取内嵌内核的序号锚点。
//
// 与 Load() 同序：环境变量目录 → 内嵌 assets。
// 读不到（旧版 exe 没有该文件）返回 seq=0 —— 任何通道内核都视为更新。
func loadBuiltinKernelVersion() *KernelVersionManifest {
	if dir := strings.TrimSpace(os.Getenv("CFPILOT_KERNEL_DIR")); dir != "" {
		if raw, err := os.ReadFile(filepath.Join(dir, KernelVersionAssetName)); err == nil {
			if m := parseKernelVersionManifest(raw); m != nil {
				return m
			}
		}
	}
	if raw, err := embedded.ReadFile("assets/" + KernelVersionAssetName); err == nil {
		if m := parseKernelVersionManifest(raw); m != nil {
			return m
		}
	}
	return &KernelVersionManifest{}
}

// isChannelNewer 判断通道内核是否比内置新：
// 序号更高；同序号但构建指纹不同也算新（同序号覆盖发布时，
// 内容哈希是唯一的内容变化证据）。
func isChannelNewer(channel, builtin *KernelVersionManifest) bool {
	if channel == nil || builtin == nil {
		return false
	}
	if channel.Seq > builtin.Seq {
		return true
	}
	return channel.Seq == builtin.Seq &&
		channel.Build != "" && builtin.Build != "" &&
		channel.Build != builtin.Build
}

// channelRemoteInfo 把通道清单包装成 RemoteInfo，
// 复用 FetchRemoteKernel 的下载 / 校验 / 缓存链路。
func channelRemoteInfo(channel *KernelVersionManifest) *RemoteInfo {
	version := fmt.Sprintf("k%d", channel.Seq)
	return &RemoteInfo{
		Version:      version,
		Tag:          KernelChannelTag,
		ControlURL:   channelAssetURL(ControlAssetName),
		DataURL:      channelAssetURL(DataAssetName),
		ChecksumsURL: channelAssetURL(ChecksumsAssetName),
	}
}

// CheckChannelUpdate 轻量检查内核热更新通道是否有比内置锚点更新的内核。
//
// 供托盘后台检查使用：只拉版本清单（几 KB），不下载内核产物。
// currentVersion 是当前工具版本（兼容护栏用；空串 = 跳过护栏判断）。
// 返回值 hasUpdate 为 false 的两种情况语义不同：
//   - 通道不可用（离线 / kernel-latest 还没发布）→ info 为 nil；
//     调用方按「通道没消息」继续走包 Release 通道的检查。
//   - 通道可用但没有比内置新的内核 → info 非 nil（版本号形如 k202611141800）。
func CheckChannelUpdate(ctx context.Context, currentVersion string) (info *RemoteInfo, hasUpdate bool) {
	channel := fetchChannelVersion(ctx)
	if channel == nil {
		return nil, false
	}
	if channel.MinToolVersion != "" &&
		strings.TrimSpace(currentVersion) != "" &&
		CompareSemver(currentVersion, channel.MinToolVersion) < 0 {
		// 兼容护栏：通道内核要求更新的工具版本。不当作「有更新」提示，
		// 否则用户点开部署页只会看到一句「先升级工具」。
		return channelRemoteInfo(channel), false
	}
	if !isChannelNewer(channel, loadBuiltinKernelVersion()) {
		return channelRemoteInfo(channel), false
	}
	return channelRemoteInfo(channel), true
}
