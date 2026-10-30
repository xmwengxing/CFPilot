package update

// 桌面版安装包的完整性校验。
//
// ## 为什么必须做
//
// 下载的不是普通文件，而是**要被用户双击运行的 exe**。
// 镜像只用于搬运，如果镜像可以同时替换「文件」和「校验依据」，
// 校验就是摆设。因此：
//
//  1. 摘要清单只从**官方 GitHub 地址**取（`ReleasesWebBase`，不走镜像）；
//  2. 清单缺失 / 解析不出目标文件名 → 直接拒绝下载，不回退「不校验也装」；
//  3. 摘要不符 → 删除已下载文件并报错，换下一个源重试。
//
// ## 与内核校验的区别
//
// 内核校验在 `internal/kernel/remote.go`（部署到 Cloudflare 的代码），
// 这里是应用自身更新（本机执行的二进制）。两者都 fail-closed，
// 但清单资产名不同：内核是 `cfpilot-kernel-SHA256SUMS`，
// 桌面版是 `cfpilot-desktop-SHA256SUMS`。
//
// ⚠️ 仍**不等于** Authenticode 签名：摘要只能证明「与官方 Release 一致」，
// 不能证明发布者身份。真正的签名需要代码签名证书，见 README「安全说明」。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"
)

// DesktopChecksumsAssetName 是桌面版摘要清单在 Release 里的附件名（sha256sum 格式）。
const DesktopChecksumsAssetName = "cfpilot-desktop-SHA256SUMS"

// maxChecksumsBytes 是清单大小上限：正常只有几百字节，防止被塞大文件。
const maxChecksumsBytes = 64 * 1024

// assetNameFromURL 取下载地址里的文件名（即 Release 资产名）。
//
// ⚠️ 不能用本地保存路径的文件名：`DefaultDownloadPath` 存成 `cfpilot-<版本>.exe`，
// 与资产名 `cfpilot-<版本>-<os>-<arch>.exe` 不同，拿本地名去查清单必然查不到。
func assetNameFromURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return path.Base(u.Path)
}

// releaseTagFromURL 从发行版下载地址里解析 tag。
//
//	https://github.com/o/r/releases/download/v0.10.1/cfpilot-...  → v0.10.1
//
// 解析不出来返回空串 —— 调用方必须据此拒绝，而不是跳过校验。
func releaseTagFromURL(rawURL string) string {
	const marker = "/releases/download/"
	idx := strings.Index(rawURL, marker)
	if idx < 0 {
		return ""
	}
	rest := rawURL[idx+len(marker):]
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	// 拒绝相对路径片段：`..` 能改写后面拼出来的清单 URL
	if rest == "" || strings.Contains(rest, "..") {
		return ""
	}
	// tag 需要是安全字符，避免把奇怪的东西拼进 URL
	for _, r := range rest {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '.' || r == '-' || r == '_'
		if !ok {
			return ""
		}
	}
	return rest
}

// parseChecksums 解析 sha256sum 格式（`<hex>  <文件名>`，也兼容 `*文件名`）。
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
		if name == "" {
			continue
		}
		out[name] = digest
	}
	return out
}

// fetchDesktopChecksums 从**官方地址**取指定 tag 的摘要清单。
//
// 不走镜像：镜像能替换安装包就能一并替换清单，校验失去意义。
func fetchDesktopChecksums(ctx context.Context, tag string) (map[string]string, error) {
	if tag == "" {
		return nil, fmt.Errorf("无法从下载地址解析发行版版本号，已拒绝下载未校验的安装包")
	}
	rawURL := ReleasesWebBase + "/download/" + tag + "/" + DesktopChecksumsAssetName

	reqCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("无法构造摘要清单请求：%w", err)
	}
	req.Header.Set("User-Agent", "CFPilot-Desktop")

	client := &http.Client{Timeout: 20 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法获取 %s：%w", DesktopChecksumsAssetName, err)
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("该发行版未发布 %s（HTTP %d），已拒绝下载未校验的安装包",
			DesktopChecksumsAssetName, res.StatusCode)
	}

	raw, err := io.ReadAll(io.LimitReader(res.Body, maxChecksumsBytes))
	if err != nil {
		return nil, fmt.Errorf("读取摘要清单失败：%w", err)
	}
	sums := parseChecksums(string(raw))
	if len(sums) == 0 {
		return nil, fmt.Errorf("%s 内容为空或格式无法解析，已拒绝下载", DesktopChecksumsAssetName)
	}
	return sums, nil
}

// verifyFileSHA256 校验本地文件的 SHA-256（流式读取，不整份进内存）。
func verifyFileSHA256(filePath, expected string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("无法读取已下载文件：%w", err)
	}
	defer func() { _ = f.Close() }()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return fmt.Errorf("计算文件摘要失败：%w", err)
	}
	actual := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(actual, expected) {
		return fmt.Errorf("文件摘要不符（期望 %s…，实际 %s…），已丢弃",
			shortHex(expected), shortHex(actual))
	}
	return nil
}

// shortHex 只保留摘要前 12 位，便于排查又不至于把日志刷满。
func shortHex(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}
