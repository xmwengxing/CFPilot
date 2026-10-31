package server

// 探测线上数据面的真实版本。
//
// ## 为什么优先读 /__version 而不是清单里的 build
//
// 清单里的 `build` 是**上次部署时写进去的**，可能有三种偏差：
//   1. 用户在 Cloudflare 控制台手工重新部署过 → 清单已过期
//   2. 部署成功但写清单失败 → 清单里是旧值
//   3. 旧版本清单里可能是空串（那时的 bug）
//
// 而数据面的 `/__version`（以及 `/__cfp_version`）返回的是**当前实际运行**
// 的构建号，最权威。所以先探端点，探不到才回落清单值。
//
// ## 端点路径
//
// worker-core 的 `version.ts` 定义 `VERSION_PATH = '/__cfp_version'`，
// routes/data.ts 同时挂载了 `/__version` 作为简写别名，两个都试。

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// versionProbePaths 是候选的版本端点路径，按优先级排列。
var versionProbePaths = []string{"/__version", "/__cfp_version"}

// remoteVersion 是线上数据面报告的版本信息。
//
// ## ⚠️ 两个字段的含义**不能混**
//
// 数据面的 `versionResponse()` 返回的是：
//
//	{"build": "<git短hash>-<源码哈希>", "version": "0.12.5"}
//
//   - `Build`   精确到源码内容，用于判断「线上与本地是不是同一份产物」
//   - `Version` 人读的语义版本，用于显示与判断「谁更新」
//
// 早期这里把两者当成了同一个东西（优先取 `version`），于是拿 semver
// 去和本地 build 指纹比对 —— **永远不相等**，状态卡永远显示「建议更新」。
// Pages 上因为 `*.pages.dev` 经常不可达、探测失败回落清单值，反而把 bug 掩盖了；
// Workers 用自定义域名时探测必定成功，问题就暴露出来了。
type remoteVersion struct {
	Build   string
	Version string
}

// probeRemoteVersion 访问数据面的版本端点。
//
// 失败时返回零值（不报错），因为「探测不到」是正常情况
// （域名还没生效、数据面被删、网络不通等），不该阻断状态检查。
func (s *Server) probeRemoteVersion(ctx context.Context, subdomain string) remoteVersion {
	host := strings.TrimSpace(subdomain)
	if host == "" {
		return remoteVersion{}
	}
	// 清单里可能存的是完整 URL，也可能是裸域名
	host = strings.TrimPrefix(host, "https://")
	host = strings.TrimPrefix(host, "http://")
	host = strings.TrimSuffix(host, "/")
	if host == "" {
		return remoteVersion{}
	}

	client := &http.Client{Timeout: 6 * time.Second}

	for _, path := range versionProbePaths {
		// 加个超时上下文，避免某个路径卡住拖累整体
		reqCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, "https://"+host+path, nil)
		if err != nil {
			cancel()
			continue
		}
		// 禁用缓存：要的是当前运行版本
		req.Header.Set("Cache-Control", "no-cache")
		req.Header.Set("User-Agent", "CFPilot-Desktop")

		res, err := client.Do(req)
		if err != nil {
			cancel()
			continue
		}

		body, readErr := io.ReadAll(io.LimitReader(res.Body, 4096))
		_ = res.Body.Close()
		cancel()

		if readErr != nil || res.StatusCode != http.StatusOK {
			continue
		}

		if v := parseVersionBody(body); v.Build != "" || v.Version != "" {
			return v
		}
	}
	return remoteVersion{}
}

// parseVersionBody 从端点响应里解出版本信息。
//
// 兼容两种形态：
//   - JSON：`{"build":"a946dfa-1f2e3d4c","version":"0.12.5"}`
//   - 纯文本：`a946dfa-1f2e3d4c`（当作 build 指纹）
func parseVersionBody(body []byte) remoteVersion {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return remoteVersion{}
	}

	// 先试 JSON
	if strings.HasPrefix(text, "{") {
		var obj struct {
			Version string `json:"version"`
			Build   string `json:"build"`
		}
		if err := json.Unmarshal(body, &obj); err == nil {
			return remoteVersion{
				Build:   strings.TrimSpace(obj.Build),
				Version: strings.TrimSpace(obj.Version),
			}
		}
		return remoteVersion{}
	}

	// 纯文本：只取第一行，且长度合理（防止把整页 HTML 当版本号）
	line := text
	if idx := strings.IndexAny(line, "\r\n"); idx >= 0 {
		line = line[:idx]
	}
	line = strings.TrimSpace(line)
	if line == "" || len(line) > 64 {
		return remoteVersion{}
	}
	// 版本号里不该有尖括号或空格（排除 HTML 片段）
	if strings.ContainsAny(line, "<> ") {
		return remoteVersion{}
	}
	return remoteVersion{Build: line}
}
