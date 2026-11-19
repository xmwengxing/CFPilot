package scan

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// 组网入口候选源（盲中继专用清单）。
//
// 为什么单独一份、不复用「外部数据源池」：
//   - 池按「必须是 Cloudflare 网段」过滤（IsCloudflareEntryIP），而盲中继最需要的
//     恰恰是**第三方反代入口**（例如腾讯云香港 VPS 上的 :8443），它们不在 CF 网段；
//   - 池不保留端口，而反代入口几乎都不是 443。
//
// 实测（2026-11-19）：从 tiancheng/hk.txt 取的反代入口经本机探测落点全是 HKG，
// 而纯 CF 边缘 IP 落在 LAX —— 这是把落点拉到近岸的唯一有效手段，
// 所以这份清单是**候选来源**，不是可信来源：拉取后仍须用 RunMeshEntry 实测。
//
// 第三方清单只保证「有人维护、能访问」，不保证质量与真实性；
// 打房间路径的 101 探测才是唯一判据。

// MeshEntrySource 是一个内置的组网候选源。
type MeshEntrySource struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	URL    string `json:"url"`
	Region string `json:"region"` // 仅用于展示（第三方标注的落点，未经实测）
	Note   string `json:"note,omitempty"`
}

// builtinMeshEntrySources 是随版本内置的组网候选源（2026-11-19 逐个 HTTP 200 验证）。
//
// 选择标准：按地区分文件、包含带端口的反代入口、有较短的更新周期。
var builtinMeshEntrySources = []MeshEntrySource{
	{ID: "tc-hk", Name: "天诚1 香港", URL: "https://bestcf.pages.dev/tiancheng/hk.txt", Region: "HK"},
	{ID: "tc-sg", Name: "天诚1 新加坡", URL: "https://bestcf.pages.dev/tiancheng/sg.txt", Region: "SG"},
	{ID: "tc-jp", Name: "天诚1 日本", URL: "https://bestcf.pages.dev/tiancheng/jp.txt", Region: "JP"},
	{ID: "tc-kr", Name: "天诚1 韩国", URL: "https://bestcf.pages.dev/tiancheng/kr.txt", Region: "KR"},
	{ID: "s5-hk", Name: "S5公益 香港", URL: "https://bestcf.pages.dev/s5gy/hk.txt", Region: "HK"},
	{ID: "tc2-sg", Name: "天诚2 新加坡", URL: "https://bestcf.pages.dev/tiancheng2/sg.txt", Region: "SG"},
	{ID: "gslege-sg", Name: "Gslege 新加坡", URL: "https://bestcf.pages.dev/gslege/SG.txt", Region: "SG"},
	{ID: "uouin-all", Name: "UOUIN 三网带测速", URL: "https://bestcf.pages.dev/uouin/all.txt", Region: "CN"},
}

// BuiltinMeshEntrySources 返回内置的组网候选源清单（副本，调用方可安全修改）。
func BuiltinMeshEntrySources() []MeshEntrySource {
	out := make([]MeshEntrySource, len(builtinMeshEntrySources))
	copy(out, builtinMeshEntrySources)
	return out
}

// FetchMeshEntryCandidates 拉取一份第三方清单并解析成候选（保留端口）。
//
// 只接受 HTTPS，且用 ValidateSourceURL 拒绝内网/回环地址（防 SSRF）。
// 返回 "ip" 或 "ip:port" 形式的字符串，已去重、截断到 max。
func FetchMeshEntryCandidates(ctx context.Context, rawURL string, timeout time.Duration, max int) ([]string, error) {
	u, err := ValidateSourceURL(rawURL, false)
	if err != nil {
		return nil, err
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	if max <= 0 {
		max = 200
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(cctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "CFPilot-Mesh/1.0")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("拉取失败：%w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("拉取失败：HTTP %d", resp.StatusCode)
	}
	// 第三方清单都是纯文本，2MB 足够；超限直接截断，避免被超大响应拖住。
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, fmt.Errorf("读取失败：%w", err)
	}

	parsed := ParseSourcePayload(string(body))
	seen := make(map[string]bool, len(parsed))
	out := make([]string, 0, len(parsed))
	for _, c := range parsed {
		host := strings.TrimSpace(c.IP)
		if host == "" {
			continue
		}
		key := host
		if c.Port != nil && *c.Port > 0 {
			key = host + ":" + strconv.Itoa(*c.Port)
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, key)
		if len(out) >= max {
			break
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("清单里没有解析出候选（格式不受支持）")
	}
	return out, nil
}
