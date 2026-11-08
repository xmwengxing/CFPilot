package scan

// 外部 IP 数据源配置与采集编排（CLI / 桌面版共用同一份本地文件）。
//
// 与 packages/cli/src/sources/{config,fetch,normalizer,manager}.ts 逐字段对齐：
//   - 文件 <configDir>/external-sources.json，schema 1，2 空格缩进 + 结尾换行；
//   - 与池共用同一把目录锁（见 pool.go 的 WithConfigDirLock）；
//   - 网络请求一律在锁外并发做完，再一次持锁提交池 + 配置 + 采集记录；
//   - 单源失败只记 lastError / 采集记录，绝不清空已有池。
//
// ⚠️ struct 字段顺序就是落盘顺序，改了会破坏 CLI 的「内容未变不写」。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// SourcesSchemaV1 是 Phase 2 的格式；读到时自动迁移（只补两个字段），不备份丢弃。
	SourcesSchemaV1    = 1
	SourcesSchema      = 2
	SourcesFilename    = "external-sources.json"
	MaxSyncRuns        = 50
	SourceMaxBytes     = 2 * 1024 * 1024
	SourceTimeoutMS    = 15_000
	SourceMaxRedirects = 3
)

const (
	SourceTypeGitHubRaw = "github-raw"
	SourceTypeCustomURL = "custom-url"
	SourceTypeRipeStat  = "ripe-stat"
)

// SourceConfig 字段顺序与 CLI 的 interface 一致（新字段一律追加在末尾）。
type SourceConfig struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Type          string   `json:"type"`
	URL           string   `json:"url"`
	Mirrors       []string `json:"mirrors"`
	Enabled       bool     `json:"enabled"`
	IntervalHours int      `json:"intervalHours"`
	ETag          string   `json:"etag"`
	LastModified  string   `json:"lastModified"`
	LastSyncAt    int64    `json:"lastSyncAt"`
	LastError     string   `json:"lastError"`
	FailCount     int      `json:"failCount"`
	// Query 是 API 型源的查询串：ripe-stat 用 ASN（如 AS13335）
	Query string `json:"query"`
	// MaxResults 是单次同步最多入池的候选数
	MaxResults int `json:"maxResults"`
}

// IsAPISource 判断是否需要走 Provider 适配器（而非 GET 一份清单文本）。
func IsAPISource(s SourceConfig) bool {
	return s.Type == SourceTypeRipeStat
}

// SyncRun 是一次采集的结果，供桌面版「采集记录」表格展示。
type SyncRun struct {
	At          int64  `json:"at"`
	SourceID    string `json:"sourceId"`
	OK          bool   `json:"ok"`
	Added       int    `json:"added"`
	Updated     int    `json:"updated"`
	Rejected    int    `json:"rejected"`
	Error       string `json:"error"`
	DurationMS  int64  `json:"durationMs"`
	NotModified bool   `json:"notModified"`
}

type SourcesFile struct {
	Schema    int            `json:"schema"`
	UpdatedAt int64          `json:"updatedAt"`
	Sources   []SourceConfig `json:"sources"`
	Runs      []SyncRun      `json:"runs"`
}

// 与 CLI shared/github-mirrors.ts 的 MIRRORS 逐项一致。
var githubMirrors = []string{
	"https://ghfast.top/",
	"https://ghproxy.net/",
	"https://gh-proxy.com/",
}

func nowMS() int64 { return time.Now().UnixMilli() }

// ------------------------------------------------------------------
// 路径与读写
// ------------------------------------------------------------------

func SourcesPath() (string, error) {
	dir, err := PoolDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, SourcesFilename), nil
}

// emptySourcesFile 构造不含内置源的空配置，只作为解析已有用户文件的基底。
// 与 EmptySources 的区别是刻意保留的：解析用户文件时若用内置清单作基底，
// 用户删掉的条目每次读文件都会被 append 回来，等于把配置回灌成内置态。
func emptySourcesFile() *SourcesFile {
	return &SourcesFile{
		Schema:  SourcesSchema,
		Sources: make([]SourceConfig, 0),
		Runs:    make([]SyncRun, 0),
	}
}

// EmptySources 只在配置文件不存在 / 为空时作为种子返回：
// 内置清单此时才出现，用户一保存就以用户文件为准；损坏 / 不兼容版本
// 走 backupCorruptSources 返回空配置，不播种，避免把删掉的条目回灌回来。
func EmptySources() *SourcesFile {
	f := emptySourcesFile()
	f.Sources = BuiltinSources()
	return f
}

func ReadSourcesRaw() string {
	path, err := SourcesPath()
	if err != nil {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(raw)
}

func validSource(s SourceConfig) bool {
	if s.ID == "" {
		return false
	}
	switch s.Type {
	case SourceTypeGitHubRaw, SourceTypeCustomURL:
		if s.URL == "" {
			return false
		}
	case SourceTypeRipeStat:
		// API 型的 endpoint 由 Provider 固定，URL 应为空
	default:
		return false
	}
	return s.Mirrors != nil
}

func validRun(r SyncRun) bool { return r.SourceID != "" }

// normalizeSource 固定字段顺序并补齐非 nil 空切片，保证序列化与 CLI 一致。
func normalizeSource(s SourceConfig) SourceConfig {
	if s.Mirrors == nil {
		s.Mirrors = []string{}
	}
	if s.MaxResults <= 0 {
		s.MaxResults = 200 // v1 条目补齐默认值
	}
	out := SourceConfig{
		ID: s.ID, Name: s.Name, Type: s.Type, URL: s.URL,
		Mirrors: append([]string{}, s.Mirrors...),
		Enabled: s.Enabled, IntervalHours: s.IntervalHours,
		ETag: s.ETag, LastModified: s.LastModified, LastSyncAt: s.LastSyncAt,
		LastError: s.LastError, FailCount: s.FailCount,
		Query:      s.Query,
		MaxResults: s.MaxResults,
	}
	return out
}

// ParseSources 解析配置；空文本播种内置清单，schema 1 自动迁移到 2，
// 其它不兼容版本 / 损坏 → 备份 + 空配置。合法用户文件一律以文件自身内容
// 为准（基底是空配置），避免把内置源回灌进去。
func ParseSources(raw string) *SourcesFile {
	if strings.TrimSpace(raw) == "" {
		return EmptySources()
	}
	var env struct {
		Schema    *int            `json:"schema"`
		UpdatedAt *int64          `json:"updatedAt"`
		Sources   json.RawMessage `json:"sources"`
		Runs      json.RawMessage `json:"runs"`
	}
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		return backupCorruptSources()
	}
	if env.Schema == nil || (*env.Schema != SourcesSchema && *env.Schema != SourcesSchemaV1) {
		return backupCorruptSources()
	}
	out := emptySourcesFile()
	if env.UpdatedAt != nil {
		out.UpdatedAt = *env.UpdatedAt
	}
	if bytes.HasPrefix(bytes.TrimSpace(env.Sources), []byte("[")) {
		var items []json.RawMessage
		if err := json.Unmarshal(env.Sources, &items); err == nil {
			for _, item := range items {
				var s SourceConfig
				if json.Unmarshal(item, &s) != nil || !validSource(s) {
					continue
				}
				out.Sources = append(out.Sources, normalizeSource(s))
			}
		}
	}
	if bytes.HasPrefix(bytes.TrimSpace(env.Runs), []byte("[")) {
		var items []json.RawMessage
		if err := json.Unmarshal(env.Runs, &items); err == nil {
			for _, item := range items {
				var r SyncRun
				if json.Unmarshal(item, &r) != nil || !validRun(r) {
					continue
				}
				out.Runs = append(out.Runs, r)
			}
		}
	}
	if len(out.Runs) > MaxSyncRuns {
		out.Runs = out.Runs[len(out.Runs)-MaxSyncRuns:]
	}
	return out
}

// 损坏文件只备份 + 返回空配置，不重新播种内置清单：
// 原文件里可能记录着「用户删掉过哪些内置条目」，此时灌回全量清单等于回灌。
// 与 CLI 的 blankSources() 降级语义一致。真正需要播种的只有「文件不存在 / 为空」。
func backupCorruptSources() *SourcesFile {
	path, err := SourcesPath()
	if err != nil {
		return emptySourcesFile()
	}
	_ = os.Rename(path, fmt.Sprintf("%s.corrupt-%d", path, nowMS()))
	return emptySourcesFile()
}

func SerializeSources(f *SourcesFile) (string, error) {
	if f == nil {
		f = emptySourcesFile()
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(f); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func WriteSourcesAtomic(text string) error {
	dir, err := PoolDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, SourcesFilename)
	tmp := filepath.Join(dir, fmt.Sprintf("%s.%d.%d.tmp", SourcesFilename, os.Getpid(), time.Now().UnixNano()))
	if err := os.WriteFile(tmp, []byte(text), 0o600); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// WithSources 是配置读改写的唯一入口（与 WithPool 共用同一把目录锁）。
// ⚠️ 不要在它的回调里再调 WithPool / WithSources，会死锁。
func WithSources(fn func(*SourcesFile) error) error {
	return WithConfigDirLock(func() error {
		before := ReadSourcesRaw()
		file := ParseSources(before)
		if err := fn(file); err != nil {
			return err
		}
		after, err := SerializeSources(file)
		if err != nil {
			return err
		}
		if after != before {
			return WriteSourcesAtomic(after)
		}
		return nil
	})
}

func LoadSources() *SourcesFile { return ParseSources(ReadSourcesRaw()) }

// SaveSources 供桌面版管理页直接保存整份配置（会走目录锁）。
func SaveSources(f *SourcesFile) error {
	return WithSources(func(current *SourcesFile) error {
		*current = *f
		current.Schema = SourcesSchema
		if current.Sources == nil {
			current.Sources = []SourceConfig{}
		}
		if current.Runs == nil {
			current.Runs = []SyncRun{}
		}
		if len(current.Runs) > MaxSyncRuns {
			current.Runs = current.Runs[len(current.Runs)-MaxSyncRuns:]
		}
		current.UpdatedAt = nowMS()
		return nil
	})
}

func MakeSource(id, name, kind, rawURL string, mirrors []string, enabled bool, intervalHours int) SourceConfig {
	if name == "" {
		name = id
	}
	if mirrors == nil {
		mirrors = []string{}
	}
	if intervalHours <= 0 {
		intervalHours = 24
		if kind == SourceTypeGitHubRaw {
			intervalHours = 12
		}
	}
	return SourceConfig{
		ID: id, Name: name, Type: kind, URL: rawURL, Mirrors: mirrors,
		Enabled: enabled, IntervalHours: intervalHours,
		ETag: "", LastModified: "", LastSyncAt: 0, LastError: "", FailCount: 0,
		Query: "", MaxResults: 200,
	}
}

// MakeAPISource 构造 Provider 型数据源（endpoint 由 Provider 固定，URL 留空）。
func MakeAPISource(id, name, kind, query string, enabled bool, intervalHours, maxResults int) SourceConfig {
	s := MakeSource(id, name, kind, "", []string{}, enabled, intervalHours)
	s.Query = query
	if maxResults > 0 {
		s.MaxResults = maxResults
	}
	if s.Query == "" {
		s.Query = DefaultProviderQuery(kind)
	}
	return s
}

func AppendRun(f *SourcesFile, r SyncRun) {
	f.Runs = append(f.Runs, r)
	if len(f.Runs) > MaxSyncRuns {
		f.Runs = f.Runs[len(f.Runs)-MaxSyncRuns:]
	}
	f.UpdatedAt = r.At
}

// ------------------------------------------------------------------
// SSRF 防护与 URL 脱敏
// ------------------------------------------------------------------

var blockedSourceHosts = map[string]bool{
	"localhost": true, "metadata": true, "metadata.google.internal": true, "instance-data": true,
}

func isPrivateIPv4(ip net.IP) bool {
	v4 := ip.To4()
	if v4 == nil {
		return false
	}
	a, b, c := v4[0], v4[1], v4[2]
	switch {
	case a == 0, a == 10, a == 127:
		return true
	case a == 100 && b >= 64 && b <= 127:
		return true
	case a == 169 && b == 254:
		return true
	case a == 172 && b >= 16 && b <= 31:
		return true
	case a == 192 && b == 168:
		return true
	case a == 192 && b == 0:
		return true
	case a == 198 && (b == 18 || b == 19):
		return true
	case a == 198 && b == 51 && c == 100:
		return true
	case a == 203 && b == 0 && c == 113:
		return true
	case a >= 224:
		return true
	}
	return false
}

func isPrivateIPv6(ip net.IP) bool {
	if ip.Equal(net.IPv6zero) || ip.Equal(net.IPv6loopback) || ip.IsLinkLocalUnicast() || ip.IsPrivate() {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		return isPrivateIPv4(v4)
	}
	return false
}

// ValidateSourceURL 与 CLI 的 validateSourceUrl 同口径：默认只允许 HTTPS，
// 拒绝 userinfo、本机/内网域名与私网/保留 IP 字面量。
//
// ⚠️ 同 CLI：只校验字面量，不预解析 DNS（DNS rebinding 残留风险见验收报告）。
func ValidateSourceURL(raw string, allowHTTP bool) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("不是合法的链接：%s", raw)
	}
	if u.Scheme != "https" && !(allowHTTP && u.Scheme == "http") {
		return nil, fmt.Errorf("外部数据源只支持 HTTPS，实际是 %s:", u.Scheme)
	}
	if u.User != nil {
		return nil, errors.New("外部数据源链接不允许带用户名/密码")
	}
	host := strings.ToLower(strings.Trim(u.Hostname(), "[]"))
	if blockedSourceHosts[host] || strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return nil, fmt.Errorf("外部数据源不允许指向本机或内网域名：%s", host)
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.To4() != nil {
			if isPrivateIPv4(ip) {
				return nil, fmt.Errorf("外部数据源不允许指向私网/保留地址：%s", host)
			}
		} else if isPrivateIPv6(ip) {
			return nil, fmt.Errorf("外部数据源不允许指向私网/保留地址：%s", host)
		}
	}
	return u, nil
}

// SanitizeURL 去掉 query / fragment，避免令牌类参数进日志与采集记录。
func SanitizeURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "<invalid-url>"
	}
	return fmt.Sprintf("%s//%s%s", u.Scheme, u.Host, u.Path)
}

func SourceURLs(s SourceConfig) []string {
	out := []string{s.URL}
	out = append(out, s.Mirrors...)
	if s.Type == SourceTypeGitHubRaw {
		for _, prefix := range githubMirrors {
			out = append(out, prefix+s.URL)
			for _, m := range s.Mirrors {
				out = append(out, prefix+m)
			}
		}
	}
	seen := map[string]bool{}
	uniq := make([]string, 0, len(out))
	for _, u := range out {
		if !seen[u] {
			seen[u] = true
			uniq = append(uniq, u)
		}
	}
	return uniq
}

// ------------------------------------------------------------------
// 拉取
// ------------------------------------------------------------------

type SourceFetchOptions struct {
	TimeoutMS int64 // 0 = 默认 15s
	MaxBytes  int64 // 0 = 默认 2MB
	AllowHTTP bool  // 仅本地自建测试源
	Client    *http.Client
}

type SourceFetchResult struct {
	Text         string
	URL          string
	ETag         string
	LastModified string
	NotModified  bool
}

// FetchSourceText 逐跳校验重定向、带条件请求、按 2MB 双口径截断；
// 主 URL 失败自动试镜像，全失败才返回错误。
func FetchSourceText(ctx context.Context, s SourceConfig, opts SourceFetchOptions) (SourceFetchResult, error) {
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
				// 每一跳都重新做 SSRF 校验
				if _, err := ValidateSourceURL(req.URL.String(), opts.AllowHTTP); err != nil {
					return err
				}
				return nil
			},
		}
	}

	var errs []string
	for _, raw := range SourceURLs(s) {
		parsed, err := ValidateSourceURL(raw, opts.AllowHTTP)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s：%v", SanitizeURL(raw), err))
			continue
		}
		redirects = 0
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s：%v", SanitizeURL(raw), err))
			continue
		}
		req.Header.Set("User-Agent", "CFPilot-ExternalSources/1.0")
		req.Header.Set("Accept", "text/plain, application/json, text/csv, */*")
		if s.ETag != "" {
			req.Header.Set("If-None-Match", s.ETag)
		}
		if s.LastModified != "" {
			req.Header.Set("If-Modified-Since", s.LastModified)
		}
		res, err := client.Do(req)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s：%v", SanitizeURL(raw), err))
			continue
		}
		if res.StatusCode == http.StatusNotModified {
			_ = res.Body.Close()
			return SourceFetchResult{URL: SanitizeURL(raw), ETag: s.ETag, LastModified: s.LastModified, NotModified: true}, nil
		}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			_ = res.Body.Close()
			errs = append(errs, fmt.Sprintf("%s：HTTP %d", SanitizeURL(raw), res.StatusCode))
			continue
		}
		if declared := res.ContentLength; declared > limit {
			_ = res.Body.Close()
			errs = append(errs, fmt.Sprintf("%s：清单过大（声明 %d 字节）", SanitizeURL(raw), declared))
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(res.Body, limit+1))
		_ = res.Body.Close()
		if readErr != nil {
			errs = append(errs, fmt.Sprintf("%s：%v", SanitizeURL(raw), readErr))
			continue
		}
		if int64(len(data)) > limit {
			errs = append(errs, fmt.Sprintf("%s：清单过大（超过 %d 字节）", SanitizeURL(raw), limit))
			continue
		}
		etag := res.Header.Get("ETag")
		if etag == "" {
			etag = s.ETag
		}
		lm := res.Header.Get("Last-Modified")
		if lm == "" {
			lm = s.LastModified
		}
		return SourceFetchResult{
			Text: string(data), URL: SanitizeURL(raw), ETag: etag, LastModified: lm,
		}, nil
	}
	if len(errs) == 0 {
		errs = append(errs, "数据源没有可用链接")
	}
	return SourceFetchResult{}, errors.New(strings.Join(errs, "；"))
}

// ------------------------------------------------------------------
// 内容归一（复用 ParseCandidateList，只补 JSON 与端口）
// ------------------------------------------------------------------

var (
	reHostPort = regexp.MustCompile(`(?:\[([0-9a-fA-F:.]+)\]:|(\d{1,3}(?:\.\d{1,3}){3}):)(\d{1,5})`)
	reIPv4Port = regexp.MustCompile(`^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$`)
	reIPv4     = regexp.MustCompile(`^\d{1,3}(?:\.\d{1,3}){3}$`)
	reDigits   = regexp.MustCompile(`^\d{1,5}$`)
)

type ParsedCandidate struct {
	IP   string
	Port *int
}

func splitHostPort(token string) (ParsedCandidate, bool) {
	t := strings.TrimSpace(token)
	if i := strings.Index(t, "#"); i >= 0 {
		t = strings.TrimSpace(t[:i])
	}
	if t == "" {
		return ParsedCandidate{}, false
	}
	if strings.HasPrefix(t, "[") {
		end := strings.Index(t, "]")
		if end < 0 {
			return ParsedCandidate{}, false
		}
		c := ParsedCandidate{IP: t[1:end]}
		rest := t[end+1:]
		if strings.HasPrefix(rest, ":") && reDigits.MatchString(rest[1:]) {
			if n, err := strconv.Atoi(rest[1:]); err == nil && n >= 1 && n <= 65535 {
				c.Port = &n
			}
		}
		return c, true
	}
	if m := reIPv4Port.FindStringSubmatch(t); m != nil {
		c := ParsedCandidate{IP: m[1]}
		if n, err := strconv.Atoi(m[2]); err == nil && n >= 1 && n <= 65535 {
			c.Port = &n
		}
		return c, true
	}
	return ParsedCandidate{IP: t}, true
}

func collectPorts(text string) map[string]int {
	ports := map[string]int{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		for _, m := range reHostPort.FindAllStringSubmatch(line, -1) {
			host := m[1]
			if host == "" {
				host = m[2]
			}
			n, err := strconv.Atoi(m[3])
			if err == nil && n >= 1 && n <= 65535 {
				if _, ok := ports[host]; !ok {
					ports[host] = n
				}
			}
		}
		if strings.Contains(line, ",") {
			cols := strings.FieldsFunc(line, func(r rune) bool { return r == ',' })
			for i := 0; i < len(cols)-1; i++ {
				host := strings.Trim(strings.TrimSpace(cols[i]), `"`)
				if i2 := strings.Index(host, "#"); i2 >= 0 {
					host = strings.TrimSpace(host[:i2])
				}
				portText := strings.TrimSpace(cols[i+1])
				if !reIPv4.MatchString(host) || !reDigits.MatchString(portText) {
					continue
				}
				n, err := strconv.Atoi(portText)
				if err == nil && n >= 1 && n <= 65535 {
					if _, ok := ports[host]; !ok {
						ports[host] = n
					}
				}
			}
		}
	}
	return ports
}

func parseJSONPayload(text string) ([]ParsedCandidate, bool) {
	var data any
	if err := json.Unmarshal([]byte(text), &data); err != nil {
		return nil, false
	}
	var list []any
	if arr, ok := data.([]any); ok {
		list = arr
	} else if obj, ok := data.(map[string]any); ok {
		for _, key := range []string{"ips", "data", "list", "candidates", "result", "items", "records"} {
			if arr, ok := obj[key].([]any); ok {
				list = arr
				break
			}
		}
	}
	if list == nil {
		return nil, false
	}
	out := make([]ParsedCandidate, 0, len(list))
	ipKeys := []string{"ip", "address", "addr", "host", "target", "value"}
	for _, item := range list {
		switch v := item.(type) {
		case string:
			if c, ok := splitHostPort(v); ok {
				out = append(out, c)
			}
		case map[string]any:
			var host string
			for _, k := range ipKeys {
				if s, ok := v[k].(string); ok && strings.TrimSpace(s) != "" {
					host = strings.TrimSpace(s)
					break
				}
			}
			if host == "" {
				continue
			}
			c, ok := splitHostPort(host)
			if !ok {
				continue
			}
			if raw, ok := v["port"]; ok {
				var n int
				switch p := raw.(type) {
				case float64:
					n = int(p)
				case string:
					n, _ = strconv.Atoi(p)
				}
				if n >= 1 && n <= 65535 {
					c.Port = &n
				}
			}
			out = append(out, c)
		}
	}
	return out, true
}

// ParseSourcePayload 优先按 JSON 试，否则走 ParseCandidateList 的清洗再补端口。
func ParseSourcePayload(text string) []ParsedCandidate {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return []ParsedCandidate{}
	}
	if strings.HasPrefix(trimmed, "[") || strings.HasPrefix(trimmed, "{") {
		if out, ok := parseJSONPayload(trimmed); ok {
			return out
		}
	}
	hosts := ParseCandidateList(text)
	ports := collectPorts(text)
	out := make([]ParsedCandidate, 0, len(hosts))
	for _, host := range hosts {
		c := ParsedCandidate{IP: host}
		if n, ok := ports[host]; ok {
			port := n
			c.Port = &port
		}
		out = append(out, c)
	}
	return out
}

func ToCandidateInputs(parsed []ParsedCandidate, sourceID string) []CandidateInput {
	out := make([]CandidateInput, 0, len(parsed))
	for _, p := range parsed {
		out = append(out, CandidateInput{IP: p.IP, Port: p.Port, Source: sourceID})
	}
	return out
}

// ------------------------------------------------------------------
// 编排
// ------------------------------------------------------------------

type SourceSyncOutcome struct {
	SourceID    string         `json:"sourceId"`
	OK          bool           `json:"ok"`
	Added       int            `json:"added"`
	Updated     int            `json:"updated"`
	Rejected    int            `json:"rejected"`
	Reasons     map[string]int `json:"reasons"`
	NotModified bool           `json:"notModified"`
	Error       string         `json:"error"`
	DurationMS  int64          `json:"durationMs"`
	URL         string         `json:"url"`
}

type SyncReport struct {
	At             int64               `json:"at"`
	Outcomes       []SourceSyncOutcome `json:"outcomes"`
	PoolCandidates int                 `json:"poolCandidates"`
}

type SyncOptions struct {
	SourceIDs map[string]bool
	Now       int64
	FetchOpts SourceFetchOptions
	// LightCheck 是 Phase 3 注入的轻量校验（锁外执行）；nil 表示不校验。
	LightCheck func([]CandidateInput) []CandidateInput
	// Fetch 可注入以替换网络拉取（测试用）；nil 用默认实现。
	Fetch func(context.Context, SourceConfig, SourceFetchOptions) (SourceFetchResult, error)
	// Ctx 用于取消整个同步（桌面版停止定时器 / 服务关闭时）。
	Ctx context.Context
}

type fetchedSource struct {
	source  SourceConfig
	outcome SourceSyncOutcome
	inputs  []CandidateInput
	etag    string
	lm      string
}

func failedFetch(s SourceConfig, err string, started int64) fetchedSource {
	if len(err) > 300 {
		err = err[:300]
	}
	return fetchedSource{
		source: s,
		outcome: SourceSyncOutcome{
			SourceID: s.ID, OK: false, Reasons: map[string]int{}, Error: err,
			DurationMS: nowMS() - started, URL: SanitizeURL(s.URL),
		},
		inputs: []CandidateInput{}, etag: s.ETag, lm: s.LastModified,
	}
}

// SyncSources 并发拉取（锁外）→ 一次持锁提交池 + 配置 + 采集记录。
// 单源失败只记进 lastError 与采集记录，不清空池、不影响其它源。
func SyncSources(opts SyncOptions) SyncReport {
	now := opts.Now
	if now == 0 {
		now = nowMS()
	}
	ctx := opts.Ctx
	if ctx == nil {
		ctx = context.Background()
	}
	fetch := opts.Fetch
	if fetch == nil {
		fetch = FetchSourceText
	}

	configured := LoadSources()
	targets := make([]SourceConfig, 0, len(configured.Sources))
	for _, s := range configured.Sources {
		if !s.Enabled {
			continue
		}
		if len(opts.SourceIDs) > 0 && !opts.SourceIDs[s.ID] {
			continue
		}
		targets = append(targets, s)
	}

	// list 型源保持并发；api 型源走 Provider 串行节流，
	// 否则按频率限流的上游 API 会被并发直接打出 429。
	var listTargets, apiTargets []SourceConfig
	for _, s := range targets {
		if IsAPISource(s) {
			apiTargets = append(apiTargets, s)
		} else {
			listTargets = append(listTargets, s)
		}
	}

	fetched := make([]fetchedSource, 0, len(targets))
	listResults := make([]fetchedSource, len(listTargets))
	var wg sync.WaitGroup
	for i, s := range listTargets {
		wg.Add(1)
		go func(i int, s SourceConfig) {
			defer wg.Done()
			started := nowMS()
			res, err := fetch(ctx, s, opts.FetchOpts)
			if err != nil {
				listResults[i] = failedFetch(s, err.Error(), started)
				return
			}
			outcome := SourceSyncOutcome{
				SourceID: s.ID, OK: true, Reasons: map[string]int{},
				NotModified: res.NotModified, DurationMS: nowMS() - started, URL: res.URL,
			}
			item := fetchedSource{source: s, outcome: outcome, inputs: []CandidateInput{}, etag: res.ETag, lm: res.LastModified}
			if !res.NotModified {
				inputs := ToCandidateInputs(ParseSourcePayload(res.Text), s.ID)
				if opts.LightCheck != nil && len(inputs) > 0 {
					inputs = opts.LightCheck(inputs)
				}
				item.inputs = inputs
			}
			listResults[i] = item
		}(i, s)
	}
	wg.Wait()
	fetched = append(fetched, listResults...)

	lastAt := int64(0)
	lastType := ""
	for _, s := range apiTargets {
		spec := ProviderSpecs[s.Type]
		if lastType == s.Type {
			wait := spec.MinIntervalMS - (nowMS() - lastAt)
			if wait > 0 {
				select {
				case <-ctx.Done():
				case <-time.After(time.Duration(wait) * time.Millisecond):
				}
			}
		}
		lastType = s.Type
		lastAt = nowMS()
		started := nowMS()
		// Provider 的网络层可注入（测试用），与 list 源共用同一个 Client
		providerOpts := ProviderOptions{
			TimeoutMS: opts.FetchOpts.TimeoutMS,
			MaxBytes:  opts.FetchOpts.MaxBytes,
			Client:    opts.FetchOpts.Client,
		}
		res, err := RunProvider(ctx, s, providerOpts)
		if err != nil {
			fetched = append(fetched, failedFetch(s, err.Error(), started))
			continue
		}
		inputs := ToCandidateInputs(res.Candidates, s.ID)
		if opts.LightCheck != nil && len(inputs) > 0 {
			inputs = opts.LightCheck(inputs)
		}
		fetched = append(fetched, fetchedSource{
			source: s,
			outcome: SourceSyncOutcome{
				SourceID: s.ID, OK: true, Reasons: map[string]int{},
				DurationMS: nowMS() - started,
				// Note 已脱敏（不含 dork / key），可安全展示
				URL: res.Note,
			},
			inputs: inputs, etag: "", lm: "",
		})
	}

	report := SyncReport{At: now, Outcomes: make([]SourceSyncOutcome, 0, len(fetched))}
	_ = WithConfigDirLock(func() error {
		poolBefore := ReadPoolRaw()
		pool := ParsePool(poolBefore)
		cfgBefore := ReadSourcesRaw()
		cfg := ParseSources(cfgBefore)

		for i := range fetched {
			item := &fetched[i]
			for j := range cfg.Sources {
				if cfg.Sources[j].ID != item.source.ID {
					continue
				}
				cur := &cfg.Sources[j]
				cur.LastSyncAt = now
				if item.outcome.OK {
					cur.ETag, cur.LastModified, cur.FailCount, cur.LastError = item.etag, item.lm, 0, ""
				} else {
					cur.FailCount++
					cur.LastError = item.outcome.Error
				}
				break
			}
			if item.outcome.OK && !item.outcome.NotModified && len(item.inputs) > 0 {
				r := UpsertCandidates(pool, item.inputs, now, PoolMaxCandidates)
				item.outcome.Added, item.outcome.Updated = r.Added, r.Updated
				item.outcome.Rejected, item.outcome.Reasons = r.Rejected, r.Reasons
			}
			AppendRun(cfg, SyncRun{
				At: now, SourceID: item.outcome.SourceID, OK: item.outcome.OK,
				Added: item.outcome.Added, Updated: item.outcome.Updated,
				Rejected: item.outcome.Rejected, Error: item.outcome.Error,
				DurationMS: item.outcome.DurationMS, NotModified: item.outcome.NotModified,
			})
			report.Outcomes = append(report.Outcomes, item.outcome)
		}

		poolAfter, err := SerializePool(pool)
		if err != nil {
			return err
		}
		if poolAfter != poolBefore {
			if err := WritePoolAtomic(poolAfter); err != nil {
				return err
			}
		}
		cfgAfter, err := SerializeSources(cfg)
		if err != nil {
			return err
		}
		if cfgAfter != cfgBefore {
			return WriteSourcesAtomic(cfgAfter)
		}
		return nil
	})
	report.PoolCandidates = len(ParsePool(ReadPoolRaw()).Candidates)
	return report
}

// TestSource 只拉 + 解析，不写池、不改配置、不记采集记录。
func TestSource(ctx context.Context, s SourceConfig, opts SyncOptions) SourceSyncOutcome {
	started := nowMS()
	fetch := opts.Fetch
	if fetch == nil {
		fetch = FetchSourceText
	}
	probe := s
	probe.ETag, probe.LastModified = "", "" // 不带条件头，否则第二次永远 304
	res, err := fetch(ctx, probe, opts.FetchOpts)
	outcome := SourceSyncOutcome{
		SourceID: s.ID, OK: err == nil, Reasons: map[string]int{},
		DurationMS: nowMS() - started, URL: SanitizeURL(s.URL),
	}
	if err != nil {
		outcome.Error = err.Error()
		if len(outcome.Error) > 300 {
			outcome.Error = outcome.Error[:300]
		}
		return outcome
	}
	outcome.URL = res.URL
	outcome.NotModified = res.NotModified
	if !res.NotModified {
		outcome.Added = len(ParseSourcePayload(res.Text))
	}
	return outcome
}

// RemoveSource 只删配置与来源关联；仍被其它来源引用 / 用户禁用的候选保留。
func RemoveSource(id string) (removed int, kept int, err error) {
	err = WithConfigDirLock(func() error {
		cfgBefore := ReadSourcesRaw()
		cfg := ParseSources(cfgBefore)
		before := len(cfg.Sources)
		keptSources := make([]SourceConfig, 0, before)
		for _, s := range cfg.Sources {
			if s.ID != id {
				keptSources = append(keptSources, s)
			}
		}
		if len(keptSources) == before {
			return fmt.Errorf("数据源不存在：%s", id)
		}
		cfg.Sources = keptSources
		runs := make([]SyncRun, 0, len(cfg.Runs))
		for _, r := range cfg.Runs {
			if r.SourceID != id {
				runs = append(runs, r)
			}
		}
		cfg.Runs = runs
		cfg.UpdatedAt = nowMS()

		poolBefore := ReadPoolRaw()
		pool := ParsePool(poolBefore)
		candidates := make([]ExternalCandidate, 0, len(pool.Candidates))
		for _, c := range pool.Candidates {
			has := false
			for _, s := range c.Sources {
				if s == id {
					has = true
					break
				}
			}
			if !has {
				candidates = append(candidates, c)
				continue
			}
			sources := make([]string, 0, len(c.Sources))
			for _, s := range c.Sources {
				if s != id {
					sources = append(sources, s)
				}
			}
			c.Sources = sources
			if len(sources) > 0 || c.Status == StatusDisabled {
				candidates = append(candidates, c)
			} else {
				removed++
			}
		}
		pool.Candidates = candidates
		kept = len(candidates)

		cfgAfter, err := SerializeSources(cfg)
		if err != nil {
			return err
		}
		if cfgAfter != cfgBefore {
			if err := WriteSourcesAtomic(cfgAfter); err != nil {
				return err
			}
		}
		poolAfter, err := SerializePool(pool)
		if err != nil {
			return err
		}
		if poolAfter != poolBefore {
			return WritePoolAtomic(poolAfter)
		}
		return nil
	})
	return removed, kept, err
}
