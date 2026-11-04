package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/deploy"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/relay"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

// relayState 是反代体检的任务状态（同一时刻只允许一个）。
type relayState struct {
	mu      sync.Mutex
	running bool
	cancel  context.CancelFunc
}

// registerRelayRoutes 挂载反代优选（出站链路体检）相关路由。
func (s *Server) registerRelayRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/relay/run", s.guard(s.handleRelayRun))
	mux.HandleFunc("/api/relay/cancel", s.guard(s.handleRelayCancel))
	mux.HandleFunc("/api/relay/parse-candidates", s.guard(s.handleRelayParseCandidates))
	mux.HandleFunc("/api/relay/fetch-candidates", s.guard(s.handleRelayFetchCandidates))
	mux.HandleFunc("/api/relay/uuid", s.guard(s.handleRelayUUID))
	mux.HandleFunc("/api/relay/builtin", s.guard(s.handleRelayBuiltin))
	mux.HandleFunc("/api/relay/push-results", s.guard(s.handleRelayPushResults))
}

// handleRelayBuiltin 返回随版本发布的内置反代候选清单。
//
// 用户不可修改：这是「手上没有 IP 源时也能开跑」的兜底，
// 要测自己的清单就走导入（粘贴 / 文件 / 链接）。
func (s *Server) handleRelayBuiltin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET/POST"})
		return
	}
	list := relay.BuiltinCandidates()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"candidates": list,
		"count":      len(list),
		"raw":        strings.Join(list, "\n"),
	})
}

// relayRunRequest 是 POST /api/relay/run 的入参。
type relayRunRequest struct {
	Host string `json:"host"`
	// WSPath 是数据面的 WebSocket 路径
	WSPath string `json:"wsPath"`
	// UUID 是 VLESS UUID（隧道鉴权）
	UUID        string `json:"uuid"`
	Rounds      int    `json:"rounds"`
	Top         int    `json:"top"`
	TimeoutMs   int    `json:"timeoutMs"`
	Concurrency int    `json:"concurrency"`
	// Candidates 是原始候选文本（换行 / CSV / 带备注都支持）
	Candidates string `json:"candidates"`
}

// handleRelayRun 启动一次反代体检（异步）。
//
// 与 /api/scan/run 一样是**异步**：一个候选要跑三跳（隧道 → TLS → HTTP），
// 260 个候选按 8 并发也要几分钟，同步请求必然超时。
// 结果通过 SSE 的 `relay-result` 推送，进度走 `relay-progress`。
func (s *Server) handleRelayRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	var req relayRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}
	host := strings.TrimSpace(req.Host)
	wsPath := strings.TrimSpace(req.WSPath)
	uuid := strings.TrimSpace(req.UUID)
	if host == "" || wsPath == "" || uuid == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": "缺少数据面域名 / WS 路径 / UUID",
		})
		return
	}

	// 反代入口是「明文 TCP + 按 SNI 转发」，端口固定 443，只接受 IPv4
	all := scan.ParseCandidateList(req.Candidates)
	candidates := make([]string, 0, len(all))
	for _, ip := range all {
		if !strings.Contains(ip, ":") && net.ParseIP(ip) != nil {
			candidates = append(candidates, ip)
		}
	}
	if len(candidates) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": "候选列表为空（只接受 IPv4 地址）",
		})
		return
	}

	s.relay.mu.Lock()
	if s.relay.running {
		s.relay.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "已有反代体检在进行中"})
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.relay.running = true
	s.relay.cancel = cancel
	s.relay.mu.Unlock()

	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	rounds := req.Rounds
	top := req.Top

	s.logf(fmt.Sprintf("开始反代体检：%s，候选 %d 个（已忽略 %d 条非 IPv4）", host, len(candidates), len(all)-len(candidates)))

	go func() {
		defer func() {
			cancel()
			s.relay.mu.Lock()
			s.relay.running = false
			s.relay.cancel = nil
			s.relay.mu.Unlock()
		}()

		summary, err := relay.Run(ctx, relay.RunOptions{
			Host:       host,
			WSPath:     wsPath,
			UUID:       uuid,
			Rounds:     rounds,
			Top:        top,
			Timeout:    timeout,
			Candidates: candidates,
			OnProgress: func(done, total int, ip string, ok bool) {
				s.events.publish("relay-progress", map[string]any{
					"done":  done,
					"total": total,
					"ip":    ip,
					"ok":    ok,
				})
			},
		})
		if err != nil {
			s.logLevel("反代体检失败："+err.Error(), "err")
			s.events.publish("relay-result", map[string]any{"ok": false, "error": err.Error()})
			return
		}

		payload := map[string]any{
			"ok":            true,
			"expectedBuild": summary.ExpectedBuild,
			"alwaysOk":      summary.AlwaysOK,
			"neverOk":       summary.NeverOK,
			"flaky":         summary.Flaky,
			"picked":        summary.Picked(top),
			"entries":       summary.Aggregates,
			"at":            summary.GeneratedAt.UTC().Format(time.RFC3339),
		}
		s.events.publish("relay-result", payload)
		s.logLevel(
			fmt.Sprintf("反代体检完成：全通 %d / 抖动 %d / 全挂 %d", summary.AlwaysOK, summary.Flaky, summary.NeverOK),
			"ok",
		)
	}()

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"started": true,
		"count":   len(candidates),
	})
}

// handleRelayCancel 取消正在进行的反代体检。
func (s *Server) handleRelayCancel(w http.ResponseWriter, r *http.Request) {
	s.relay.mu.Lock()
	cancel := s.relay.cancel
	running := s.relay.running
	s.relay.mu.Unlock()

	if !running || cancel == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "没有正在进行的反代体检"})
		return
	}
	cancel()
	s.logf("已请求取消反代体检")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleRelayParseCandidates 清洗候选文本，返回可识别的 IPv4 与总条数。
//
// 界面上「自定义列表」在提交前先调这个，让用户立刻看到「实际会被测多少个」——
// 避免粘了 1000 行结果只认了 3 个。
func (s *Server) handleRelayParseCandidates(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req struct {
		Raw string `json:"raw"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}

	all := scan.ParseCandidateList(req.Raw)
	ipv4 := make([]string, 0, len(all))
	skipped := 0
	for _, ip := range all {
		if !strings.Contains(ip, ":") && net.ParseIP(ip) != nil {
			ipv4 = append(ipv4, ip)
		} else {
			skipped++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"candidates": ipv4,
		"count":      len(ipv4),
		"skipped":    skipped,
		"total":      len(all),
	})
}

// relayURLMaxBytes 是远程清单的体积上限（与 CLI 保持一致）。
const relayURLMaxBytes = 2 * 1024 * 1024

// relayFetchGuard 是远程导入的目标校验，测试可替换（生产恒为 validatePublicURL）。
var relayFetchGuard = validatePublicURL

// handleRelayFetchCandidates 由**服务端**拉取远程清单。
//
// 为什么不让界面直接 fetch：界面跑在 http://127.0.0.1，去拉任意外链会被
// 浏览器的 CORS 拦掉（对方站点不会给这个源开发跨域头）。服务端拉取绕开
// 这一层，同时由我们自己控制超时与体积。
func (s *Server) handleRelayFetchCandidates(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}
	target, err := relayFetchGuard(req.URL)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	httpReq.Header.Set("User-Agent", "cfpilot-relay-import")

	client := &http.Client{Timeout: 15 * time.Second}
	res, err := client.Do(httpReq)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "拉取失败：" + err.Error()})
		return
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": fmt.Sprintf("拉取失败：HTTP %d", res.StatusCode),
		})
		return
	}

	body, err := io.ReadAll(io.LimitReader(res.Body, relayURLMaxBytes+1))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "读取失败：" + err.Error()})
		return
	}
	if len(body) > relayURLMaxBytes {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": fmt.Sprintf("清单过大：超过 %d MB 上限", relayURLMaxBytes/1024/1024),
		})
		return
	}

	raw := string(body)
	all := scan.ParseCandidateList(raw)
	ipv4 := make([]string, 0, len(all))
	skipped := 0
	for _, ip := range all {
		if !strings.Contains(ip, ":") && net.ParseIP(ip) != nil {
			ipv4 = append(ipv4, ip)
		} else {
			skipped++
		}
	}
	if len(ipv4) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": "链接内容里没有可识别的 IPv4",
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"raw":        raw,
		"candidates": ipv4,
		"count":      len(ipv4),
		"skipped":    skipped,
		"url":        target.String(),
	})
}

// validatePublicURL 只允许 http/https 且目标是公网地址。
//
// 桌面版的面板跑在 127.0.0.1：如果允许连本机 / 内网，这个「导入链接」
// 就变成了一个打本机服务的跳板（`http://127.0.0.1:xxxx/api/...`）。
func validatePublicURL(raw string) (*url.URL, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, fmt.Errorf("请填写清单链接")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, fmt.Errorf("不是合法的链接")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("只支持 http/https 链接")
	}
	host := parsed.Hostname()
	if host == "" {
		return nil, fmt.Errorf("链接缺少主机名")
	}
	if ip := net.ParseIP(host); ip != nil {
		if isPrivateIP(ip) {
			return nil, fmt.Errorf("不允许导入内网 / 本机地址")
		}
		return parsed, nil
	}
	addrs, err := net.LookupIP(host)
	if err != nil || len(addrs) == 0 {
		return nil, fmt.Errorf("域名解析失败：%s", host)
	}
	for _, ip := range addrs {
		if isPrivateIP(ip) {
			return nil, fmt.Errorf("域名解析到了内网 / 本机地址，已拒绝")
		}
	}
	return parsed, nil
}

// isPrivateIP 判断回环 / 内网 / 链路本地地址。
func isPrivateIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified()
}

// handleRelayUUID 从面板配置里读 UUID 与 WS 路径。
//
// 用户手里通常只有订阅链接，让 ta 手抄 UUID 不现实；部署与凭据链路里
// 已经有现成的读取能力，这里直接复用。
func (s *Server) handleRelayUUID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET/POST"})
		return
	}

	profile, err := s.store.Active()
	if err != nil || profile == nil || strings.TrimSpace(profile.CfToken) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "请先保存 API Token"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()

	client := s.newCFClient(profile.CfToken)
	raw, ok := client.GetKVValue(ctx, profile.AccountID, profile.KVNamespaceID, deploy.ConfigKey)
	if !ok || strings.TrimSpace(raw) == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": "读不到面板配置（KV 里没有 CONFIG），请先在「部署」页确认实例",
		})
		return
	}

	var cfg struct {
		UUID   string `json:"uuid"`
		WSPath string `json:"wsPath"`
	}
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "面板配置不是合法 JSON"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"uuid":   strings.TrimSpace(cfg.UUID),
		"wsPath": strings.TrimSpace(cfg.WSPath),
	})
}

// handleRelayPushResults 把全通候选写进面板的 ProxyIP 池。
//
// ⚠️ 与「回填手动优选 IP」是两回事：那个池会进订阅（每个 IP 变成一个节点），
// 而 `proxyIp` 只影响 Worker 的出站选路，**不进订阅**。
func (s *Server) handleRelayPushResults(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req struct {
		IPs  []string `json:"ips"`
		Mode string   `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}
	if len(req.IPs) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "没有可写入的 IP"})
		return
	}

	profile, err := s.store.Active()
	if err != nil || profile == nil || strings.TrimSpace(profile.CfToken) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "请先保存 API Token"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()

	manifest, host, password := s.resolvePanelAccess(ctx, profile)
	if host == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": "清单里没有控制面域名，请先在「部署」页完成一次部署",
		})
		return
	}
	if password == "" && manifest != nil {
		password = strings.TrimSpace(manifest.Credentials.PanelPassword)
	}
	if password == "" {
		password = strings.TrimSpace(profile.PanelPassword)
	}
	if password == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": "找不到面板密码，请先在部署页填写面板密码并保存",
		})
		return
	}

	session, err := openPanelSession(ctx, host, password)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	cfg, err := session.getConfig(ctx)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	existing := splitPool(strings.TrimSpace(asString(cfg["proxyIp"])))
	next := req.IPs
	if strings.EqualFold(req.Mode, "incremental") || strings.EqualFold(req.Mode, "append") {
		next = mergePool(existing, req.IPs)
	}

	if _, err := session.patchConfig(ctx, map[string]any{"proxyIp": strings.Join(next, "\n")}); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	s.logLevel(
		fmt.Sprintf("✅ 已写入面板 ProxyIP 池：%d 条（池内共 %d 条）", len(req.IPs), len(next)),
		"ok",
	)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"written": len(req.IPs),
		"total":   len(next),
		"host":    host,
	})
}

/* ------------------------- 面板会话（登录 + 配置读写）------------------------- */

// panelSession 是控制面的登录会话。
//
// ⚠️ 不用 cookiejar：面板的 Set-Cookie 带 `Secure; HttpOnly; SameSite=Strict`，
// 在 Pages 的多级子域 + 重定向下会被标准 cookie 存储丢掉，导致后续请求裸奔。
// 手动抓 cookie 并原样回传最可靠（与 scanner-token 的做法一致）。
type panelSession struct {
	base   string
	cookie string
	client *http.Client
}

func openPanelSession(ctx context.Context, host, password string) (*panelSession, error) {
	base := host
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		base = "https://" + base
	}
	base = strings.TrimRight(base, "/")

	client := &http.Client{Timeout: 25 * time.Second}
	body, _ := json.Marshal(map[string]string{"password": password})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/v1/login", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("登录面板失败：%w", err)
	}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	_ = res.Body.Close()

	if res.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("面板密码不正确")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("登录面板失败：HTTP %d", res.StatusCode)
	}
	if t := bytes.TrimSpace(raw); len(t) > 0 && t[0] == '<' {
		return nil, fmt.Errorf("登录接口返回了网页而不是 JSON（是不是填成了数据面域名？）")
	}

	cookie := ""
	for _, c := range res.Header.Values("Set-Cookie") {
		part := strings.SplitN(c, ";", 2)[0]
		if strings.TrimSpace(part) == "" {
			continue
		}
		if cookie != "" {
			cookie += "; "
		}
		cookie += strings.TrimSpace(part)
	}
	if cookie == "" {
		return nil, fmt.Errorf("登录成功但服务端没有下发会话 Cookie")
	}
	return &panelSession{base: base, cookie: cookie, client: client}, nil
}

func (p *panelSession) getConfig(ctx context.Context) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.base+"/api/v1/config", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Cookie", p.cookie)
	res, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("读取面板配置失败：%w", err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("读取面板配置失败：HTTP %d", res.StatusCode)
	}
	var parsed struct {
		Config map[string]any `json:"config"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("面板配置不是合法 JSON")
	}
	if parsed.Config == nil {
		return map[string]any{}, nil
	}
	return parsed.Config, nil
}

func (p *panelSession) patchConfig(ctx context.Context, patch map[string]any) (map[string]any, error) {
	body, _ := json.Marshal(map[string]any{"config": patch})
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, p.base+"/api/v1/config", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", p.cookie)
	res, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("写入面板配置失败：%w", err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("写入面板配置失败：HTTP %d %s", res.StatusCode, strings.TrimSpace(string(raw[:min(len(raw), 120)])))
	}
	var parsed struct {
		Config map[string]any `json:"config"`
	}
	_ = json.Unmarshal(raw, &parsed)
	return parsed.Config, nil
}

// splitPool 把多行文本拆成条目（换行 / 逗号 / 分号都算分隔）。
func splitPool(text string) []string {
	if strings.TrimSpace(text) == "" {
		return nil
	}
	fields := strings.FieldsFunc(text, func(r rune) bool {
		return r == '\n' || r == ',' || r == ';' || r == '\r'
	})
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		if v := strings.TrimSpace(f); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// mergePool 增量合并并去重（保留原有顺序）。
func mergePool(existing, incoming []string) []string {
	seen := make(map[string]bool, len(existing)+len(incoming))
	out := make([]string, 0, len(existing)+len(incoming))
	for _, list := range [][]string{existing, incoming} {
		for _, item := range list {
			v := strings.TrimSpace(item)
			if v == "" || seen[v] {
				continue
			}
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
