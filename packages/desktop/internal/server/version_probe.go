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

// probeRemoteBuild 访问数据面的版本端点，返回构建号。
//
// 失败时返回空串（不报错），因为「探测不到」是正常情况
// （域名还没生效、数据面被删、网络不通等），不该阻断状态检查。
func (s *Server) probeRemoteBuild(ctx context.Context, subdomain string) string {
	host := strings.TrimSpace(subdomain)
	if host == "" {
		return ""
	}
	// 清单里可能存的是完整 URL，也可能是裸域名
	host = strings.TrimPrefix(host, "https://")
	host = strings.TrimPrefix(host, "http://")
	host = strings.TrimSuffix(host, "/")
	if host == "" {
		return ""
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

		if v := parseVersionBody(body); v != "" {
			return v
		}
	}
	return ""
}

// parseVersionBody 从端点响应里解出版本号。
//
// 兼容两种形态：
//   - JSON：`{"version":"a946dfa-1f2e3d4c","build":"..."}`
//   - 纯文本：`a946dfa-1f2e3d4c`
func parseVersionBody(body []byte) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return ""
	}

	// 先试 JSON
	if strings.HasPrefix(text, "{") {
		var obj struct {
			Version string `json:"version"`
			Build   string `json:"build"`
		}
		if err := json.Unmarshal(body, &obj); err == nil {
			if v := strings.TrimSpace(obj.Version); v != "" {
				return v
			}
			if v := strings.TrimSpace(obj.Build); v != "" {
				return v
			}
		}
		return ""
	}

	// 纯文本：只取第一行，且长度合理（防止把整页 HTML 当版本号）
	line := text
	if idx := strings.IndexAny(line, "\r\n"); idx >= 0 {
		line = line[:idx]
	}
	line = strings.TrimSpace(line)
	if line == "" || len(line) > 64 {
		return ""
	}
	// 版本号里不该有尖括号或空格（排除 HTML 片段）
	if strings.ContainsAny(line, "<> ") {
		return ""
	}
	return line
}
