package scan

// Phase 7 · 外部数据源 Provider 适配层（CLI / 桌面版同语义）。
//
// 当前只注册一家：ripe-stat（零 Key）。
//
// FOFA 曾短暂接入，但真机验证免费账户 remain_api_query=0、查询返回
// [820031] F点余额不足，按用户裁决整体移除，凭据层一并删除。
// Provider 直接产出 ParsedCandidate，绕过通用清单解析器 ParseSourcePayload，
// 避免把异构 API 响应塞进 ParseCandidateList 那条链。

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

type ProviderSpec struct {
	ID                  string
	RequiresKey         bool
	MinIntervalMS       int64
	DefaultQuery        string
	DefaultIntervalHour int
	DefaultMaxResults   int
	Label               string
}

var ProviderSpecs = map[string]ProviderSpec{
	SourceTypeRipeStat: {
		ID: "ripe-stat", RequiresKey: false, MinIntervalMS: 2000,
		DefaultQuery: "AS13335", DefaultIntervalHour: 24, DefaultMaxResults: 200,
		Label: "RIPEstat 宣告前缀（零 Key）",
	},
}

func DefaultProviderQuery(kind string) string {
	if spec, ok := ProviderSpecs[kind]; ok {
		return spec.DefaultQuery
	}
	return ""
}

type ProviderOptions struct {
	TimeoutMS int64 // 0 = 默认 15s
	MaxBytes  int64 // 0 = 默认 2MB
	Client    *http.Client
}

type ProviderResult struct {
	Candidates    []ParsedCandidate
	Note          string // 已脱敏，可安全写进采集记录
	UpstreamCount int
}

var reASN = regexp.MustCompile(`(?i)^AS\d{1,10}$`)

// providerGet 带 SSRF 校验 + 逐跳重定向复检 + 体积截断的 GET JSON。
func providerGet(ctx context.Context, rawURL string, opts ProviderOptions) (map[string]any, error) {
	if _, err := ValidateSourceURL(rawURL, false); err != nil {
		return nil, err
	}
	timeout := time.Duration(opts.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = SourceTimeoutMS * time.Millisecond
	}
	limit := opts.MaxBytes
	if limit <= 0 {
		limit = SourceMaxBytes
	}
	client := opts.Client
	redirects := 0
	if client == nil {
		client = &http.Client{
			Timeout: timeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				redirects++
				if redirects > SourceMaxRedirects {
					return fmt.Errorf("重定向超过 %d 跳上限", SourceMaxRedirects)
				}
				_, err := ValidateSourceURL(req.URL.String(), false)
				return err
			},
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "CFPilot-ExternalSources/1.0")
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%v（%s）", err, SanitizeURL(rawURL))
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d（%s）", res.StatusCode, SanitizeURL(rawURL))
	}
	if res.ContentLength > limit {
		return nil, fmt.Errorf("响应过大（声明 %d 字节）", res.ContentLength)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("响应过大（超过 %d 字节）", limit)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("响应不是合法 JSON（%s）", SanitizeURL(rawURL))
	}
	return out, nil
}

// ------------------------------------------------------------------
// RIPEstat：AS13335 当前宣告前缀 → 代表 IP
// ------------------------------------------------------------------

// RepresentativeIP 从 /24（v4）或 /48（v6）取一个确定性代表 IP。
func RepresentativeIP(prefix string) string {
	parts := strings.Split(strings.TrimSpace(prefix), "/")
	if len(parts) != 2 || parts[1] == "" {
		return ""
	}
	addr, bits := parts[0], parts[1]
	if strings.Contains(addr, ":") {
		if bits != "48" {
			return ""
		}
		var groups []string
		for _, g := range strings.Split(addr, ":") {
			if g != "" {
				groups = append(groups, g)
			}
		}
		if len(groups) < 3 {
			return ""
		}
		return groups[0] + ":" + groups[1] + ":" + groups[2] + "::1"
	}
	if bits != "24" {
		return ""
	}
	octets := strings.Split(addr, ".")
	if len(octets) != 4 {
		return ""
	}
	// 固定 .130：避开网络地址 / 广播地址，同一前缀每次结果一致
	return octets[0] + "." + octets[1] + "." + octets[2] + ".130"
}

// spreadIPs 按父段桶轮转取样，避免一次取样全挤在同一个 /16 或 /32。
func spreadIPs(items []string, bucketOf func(string) string, limit int) []string {
	buckets := map[string][]string{}
	for _, ip := range items {
		k := bucketOf(ip)
		buckets[k] = append(buckets[k], ip)
	}
	keys := make([]string, 0, len(buckets))
	for k := range buckets {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, limit)
	for round := 0; len(out) < limit; round++ {
		progressed := false
		for _, k := range keys {
			if len(out) >= limit {
				break
			}
			if round < len(buckets[k]) {
				out = append(out, buckets[k][round])
				progressed = true
			}
		}
		if !progressed {
			break
		}
	}
	return out
}

func runRipeStat(ctx context.Context, s SourceConfig, opts ProviderOptions) (ProviderResult, error) {
	asn := strings.TrimSpace(s.Query)
	if asn == "" {
		asn = ProviderSpecs[SourceTypeRipeStat].DefaultQuery
	}
	if !reASN.MatchString(asn) {
		return ProviderResult{}, fmt.Errorf("ripe-stat 的 query 必须是 ASN（如 AS13335），收到「%s」", asn)
	}
	rawURL := "https://stat.ripe.net/data/announced-prefixes/data.json?resource=" + url.QueryEscape(asn)
	data, err := providerGet(ctx, rawURL, opts)
	if err != nil {
		return ProviderResult{}, err
	}
	if status, ok := data["status"].(string); ok && status != "ok" {
		return ProviderResult{}, fmt.Errorf("RIPEstat 返回 %s", status)
	}
	inner, _ := data["data"].(map[string]any)
	rawPrefixes, _ := inner["prefixes"].([]any)
	var v4, v6 []string
	for _, item := range rawPrefixes {
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		prefix, _ := obj["prefix"].(string)
		ip := RepresentativeIP(prefix)
		if ip == "" || !IsCloudflareEntryIP(ip) {
			continue
		}
		if strings.Contains(ip, ":") {
			v6 = append(v6, ip)
		} else {
			v4 = append(v4, ip)
		}
	}
	max := s.MaxResults
	if max <= 0 || max > 2000 {
		max = ProviderSpecs[SourceTypeRipeStat].DefaultMaxResults
	}
	v6Limit := max / 4
	picked := append(
		spreadIPs(v4, func(ip string) string {
			p := strings.Split(ip, ".")
			return strings.Join(p[:2], ".")
		}, max-v6Limit),
		spreadIPs(v6, func(ip string) string {
			p := strings.Split(ip, ":")
			return strings.Join(p[:2], ":")
		}, v6Limit)...,
	)
	out := make([]ParsedCandidate, 0, len(picked))
	port := 443
	for _, ip := range picked {
		p := port
		out = append(out, ParsedCandidate{IP: ip, Port: &p})
	}
	return ProviderResult{
		Candidates: out,
		Note: fmt.Sprintf("%s 宣告 %d 个前缀（v4 %d / v6 %d 可用），按父段分散取 %d 个代表 IP",
			asn, len(rawPrefixes), len(v4), len(v6), len(picked)),
		UpstreamCount: len(rawPrefixes),
	}, nil
}

// RunProvider 执行一个 API 型数据源。缺 key / 参数非法 / 上游失败都返回 error。
func RunProvider(ctx context.Context, s SourceConfig, opts ProviderOptions) (ProviderResult, error) {
	switch s.Type {
	case SourceTypeRipeStat:
		return runRipeStat(ctx, s, opts)
	default:
		return ProviderResult{}, fmt.Errorf("未知 Provider：%s（当前只支持 ripe-stat）", s.Type)
	}
}
