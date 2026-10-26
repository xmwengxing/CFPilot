package server

// 本文件实现「优选类」API。
//
// ## 与 Electron 版的对应关系
//
//	window.cfpilot.runScan(params)        → POST /api/scan/run
//	window.cfpilot.detectScanHost()       → POST /api/scan/detect-host
//	window.cfpilot.detectScanPath()       → POST /api/scan/detect-path
//	window.cfpilot.listScanCountries()    → GET  /api/scan/countries
//	window.cfpilot.checkEnvironment()     → POST /api/scan/env-check
//
// 扫描与部署一样是长任务（几十秒到几分钟），所以同样用：
//   1. POST /api/scan/run 立即返回 { started: true }
//   2. 进度通过 SSE 的 `log` 事件推送
//   3. 完成后推送 `scan-result` 事件（含 entries / copyable / stats）

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/deploy"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

// scanState 记录当前扫描任务状态（同一时刻只允许一个扫描）。
type scanState struct {
	mu      sync.Mutex
	running bool
	cancel  context.CancelFunc
}

// registerScanRoutes 挂载优选相关路由。
func (s *Server) registerScanRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/scan/run", s.guard(s.handleScanRun))
	mux.HandleFunc("/api/scan/cancel", s.guard(s.handleScanCancel))
	mux.HandleFunc("/api/scan/detect-host", s.guard(s.handleScanDetectHost))
	mux.HandleFunc("/api/scan/detect-path", s.guard(s.handleScanDetectPath))
	mux.HandleFunc("/api/scan/countries", s.guard(s.handleScanCountries))
	mux.HandleFunc("/api/scan/env-check", s.guard(s.handleScanEnvCheck))
	mux.HandleFunc("/api/scan/parse-candidates", s.guard(s.handleScanParseCandidates))
}

// scanRequest 是扫描请求体（字段与 Electron 版 ScanParams 对齐）。
type scanRequest struct {
	Host      string   `json:"host"`
	WSPath    string   `json:"wsPath"`
	ProbePath string   `json:"probePath"`
	Sample    int      `json:"sample"`
	Top       int      `json:"top"`
	SkipSpeed bool     `json:"skipSpeed"`
	Countries []string `json:"countries"`

	// 自定义候选（留空则自动从网段采样）
	Candidates string `json:"candidates"`
	// 端口，默认 443
	Port int `json:"port"`

	// 阶段参数（留 0 用默认值）
	Concurrency      int `json:"concurrency"`
	TCPTimeoutMs     int `json:"tcpTimeoutMs"`
	TLSConcurrency   int `json:"tlsConcurrency"`
	TLSTimeoutMs     int `json:"tlsTimeoutMs"`
	ProbeLimit       int `json:"probeLimit"`
	ProbeConcurrency int `json:"probeConcurrency"`
	SpeedLimit       int `json:"speedLimit"`
	SpeedConcurrency int `json:"speedConcurrency"`
	SpeedBytes       int `json:"speedBytes"`
}

// handleScanRun 启动扫描（异步）。
func (s *Server) handleScanRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	var req scanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}

	host := strings.TrimSpace(req.Host)
	if host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "缺少域名：优选必须知道用哪个域名做 TLS SNI / HTTP Host。" +
				"可以点「自动识别域名」从已部署实例读取。",
		})
		return
	}
	// 去掉协议前缀，只留主机名
	host = strings.TrimPrefix(host, "https://")
	host = strings.TrimPrefix(host, "http://")
	host = strings.TrimSuffix(host, "/")

	// 候选：用户给了就用用户的，否则从网段采样
	var candidates []string
	if strings.TrimSpace(req.Candidates) != "" {
		candidates = scan.ParseCandidateList(req.Candidates)
	}
	if len(candidates) == 0 {
		sample := req.Sample
		if sample <= 0 {
			sample = 500
		}
		candidates = scan.SampleCandidates(scan.SampleOptions{Count: sample})
	}
	if len(candidates) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "未能生成候选 IP"})
		return
	}

	// 同一时刻只允许一个扫描
	s.scan.mu.Lock()
	if s.scan.running {
		s.scan.mu.Unlock()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "已有扫描正在进行，请等待完成或先取消"})
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.scan.running = true
	s.scan.cancel = cancel
	s.scan.mu.Unlock()

	opt := scan.Options{
		Host:             host,
		Port:             req.Port,
		Candidates:       candidates,
		WSPath:           firstNonEmpty(req.WSPath, req.ProbePath, scan.ProbeDefaultPath),
		Countries:        req.Countries,
		Concurrency:      req.Concurrency,
		TCPTimeoutMs:     req.TCPTimeoutMs,
		TLSConcurrency:   req.TLSConcurrency,
		TLSTimeoutMs:     req.TLSTimeoutMs,
		ProbeLimit:       req.ProbeLimit,
		ProbeConcurrency: req.ProbeConcurrency,
		SpeedLimit:       req.SpeedLimit,
		SpeedConcurrency: req.SpeedConcurrency,
		SpeedBytes:       req.SpeedBytes,
		Top:              req.Top,
		Progress: func(p scan.Progress) {
			msg := p.Message
			if p.Total > 0 {
				msg = fmt.Sprintf("%s（%d/%d）", p.Message, p.Done, p.Total)
			}
			s.logf(msg)
		},
	}

	s.logf(fmt.Sprintf("开始优选：域名 %s，候选 %d 个", host, len(candidates)))

	go func() {
		defer func() {
			s.scan.mu.Lock()
			s.scan.running = false
			s.scan.cancel = nil
			s.scan.mu.Unlock()
			cancel()
		}()

		sum, err := scan.Run(ctx, opt)
		if err != nil {
			s.logLevel("优选失败："+err.Error(), "err")
			s.events.publish("scan-result", map[string]any{
				"ok":    false,
				"error": err.Error(),
			})
			return
		}

		// 转成界面期望的形态
		entries := make([]map[string]any, 0, len(sum.Entries))
		for _, e := range sum.Entries {
			entries = append(entries, map[string]any{
				"ip":      e.IP,
				"port":    e.Port,
				"colo":    e.Colo,
				"latency": e.Latency,
				"tlsMs":   e.TLSMs,
				"speed":   e.Speed,
			})
		}

		payload := map[string]any{
			"ok":       true,
			"entries":  entries,
			"copyable": formatCopyable(sum.Entries),
			"stats":    sum.Stats,
			"host":     host,
		}
		s.events.publish("scan-result", payload)

		if len(sum.Entries) == 0 {
			s.logLevel("优选完成，但没有可用节点（检查域名 / WS 路径 / 采样数）", "warn")
		} else {
			s.logLevel(fmt.Sprintf("优选完成：%d 个可用节点，最快 %.2f MB/s",
				len(sum.Entries), sum.Entries[0].Speed), "ok")
		}
	}()

	writeJSON(w, http.StatusOK, map[string]any{
		"started":    true,
		"candidates": len(candidates),
		"note":       "扫描已开始，进度会通过 SSE 实时推送",
	})
}

// handleScanCancel 取消正在进行的扫描。
func (s *Server) handleScanCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	s.scan.mu.Lock()
	cancel := s.scan.cancel
	running := s.scan.running
	s.scan.mu.Unlock()

	if !running || cancel == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "note": "当前没有进行中的扫描"})
		return
	}
	cancel()
	s.logLevel("已请求取消扫描", "warn")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "note": "取消请求已发出"})
}

// handleScanDetectHost 自动识别数据面域名。
//
// 优先用自定义域名，没有则用 pages.dev 子域名。
// 数据来自 KV 里的部署清单 —— 用户不用记域名。
func (s *Server) handleScanDetectHost(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	profile, err := s.store.Active()
	if err != nil || profile == nil || strings.TrimSpace(profile.CfToken) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "尚未保存 API Token"})
		return
	}
	if strings.TrimSpace(profile.AccountID) == "" || strings.TrimSpace(profile.KVNamespaceID) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请先检测账号并选择 KV"})
		return
	}

	client := cfapi.New(cfapi.Options{Token: profile.CfToken})
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	raw, ok := client.GetKVValue(ctx, profile.AccountID, profile.KVNamespaceID, deploy.ManifestKey)
	if !ok || strings.TrimSpace(raw) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "没有找到部署清单。请先在「部署」页完成一次部署。",
		})
		return
	}
	var m deploy.Manifest
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "部署清单格式损坏"})
		return
	}

	// 优先自定义域名
	host := m.DataCustomDomain
	source := "自定义域名"
	if host == "" {
		host = normalizePagesHost(m.DataSubdomain)
		source = "pages.dev 子域名"
	}
	if host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "清单里没有可用的数据面域名"})
		return
	}

	s.logf(fmt.Sprintf("识别到数据面域名：%s（来源：%s）", host, source))
	writeJSON(w, http.StatusOK, map[string]any{
		"host":   host,
		"source": source,
	})
}

// handleScanDetectPath 自动识别数据面 WS 路径。
//
// 从 KV 的 CONFIG 里读 wsPath，读不到就回落默认 /__edge_probe。
func (s *Server) handleScanDetectPath(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	profile, err := s.store.Active()
	if err != nil || profile == nil || strings.TrimSpace(profile.CfToken) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "尚未保存 API Token"})
		return
	}
	if strings.TrimSpace(profile.AccountID) == "" || strings.TrimSpace(profile.KVNamespaceID) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请先检测账号并选择 KV"})
		return
	}

	client := cfapi.New(cfapi.Options{Token: profile.CfToken})
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	path := scan.ProbeDefaultPath
	source := "默认值"

	if raw, ok := client.GetKVValue(ctx, profile.AccountID, profile.KVNamespaceID, deploy.ConfigKey); ok && raw != "" {
		var cfg struct {
			WsPath string `json:"wsPath"`
		}
		if err := json.Unmarshal([]byte(raw), &cfg); err == nil && strings.TrimSpace(cfg.WsPath) != "" {
			path = strings.TrimSpace(cfg.WsPath)
			source = "KV 配置"
		}
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	s.logf(fmt.Sprintf("识别到 WS 路径：%s（来源：%s）", path, source))
	writeJSON(w, http.StatusOK, map[string]any{
		"path":   path,
		"source": source,
	})
}

// handleScanCountries 返回支持的地区列表。
//
// 数据来源：Cloudflare 的常用机房代码。
// 与 Electron 版的 countries.ts 保持一致。
func (s *Server) handleScanCountries(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"countries": supportedCountries,
	})
}

// handleScanEnvCheck 检查本机网络环境（是否有代理干扰）。
func (s *Server) handleScanEnvCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	findings := []map[string]string{}

	// 检查常见代理端口是否在监听。
	// 有代理接管流量时，扫描结果会失真（测到的是代理的延迟，不是本地到 CF 的）。
	for _, item := range scanProxyPorts {
		if isPortOpen("127.0.0.1", item.Port, 200*time.Millisecond) {
			findings = append(findings, map[string]string{
				"kind":    "proxy",
				"message": fmt.Sprintf("检测到本机 %d 端口有服务（常见于 %s），可能正在接管流量", item.Port, item.Name),
				"level":   "warn",
			})
		}
	}

	if len(findings) == 0 {
		findings = append(findings, map[string]string{
			"kind":    "ok",
			"message": "未检测到本机代理干扰，优选结果可信",
			"level":   "ok",
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{"findings": findings})
}

// handleScanParseCandidates 清洗用户粘贴的候选列表。
//
// 界面上「自定义候选」输入框在提交前先调这个，
// 让用户能立刻看到「实际会被测多少个」——避免粘了 1000 行结果只认了 3 个。
func (s *Server) handleScanParseCandidates(w http.ResponseWriter, r *http.Request) {
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

	list := scan.ParseCandidateList(req.Raw)
	writeJSON(w, http.StatusOK, map[string]any{
		"candidates": list,
		"count":      len(list),
	})
}

// ---------- 辅助 ----------

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// formatCopyable 生成可直接粘贴进客户端的节点列表。
//
// 格式：`IP:Port#机房`，每行一个。
// 与 Electron 版的 formatCopyable 输出一致 —— 用户会在两个版本间复制粘贴。
func formatCopyable(entries []scan.Entry) string {
	var sb strings.Builder
	for _, e := range entries {
		tag := e.Colo
		if tag == "" {
			tag = "CF"
		}
		fmt.Fprintf(&sb, "%s:%d#%s\n", e.IP, e.Port, tag)
	}
	return sb.String()
}

// scanProxyPorts 是常见的本地代理端口。
var scanProxyPorts = []struct {
	Name string
	Port int
}{
	{"Clash", 7890},
	{"Clash Verge", 7897},
	{"V2Ray / Xray", 10808},
	{"V2Ray HTTP", 10809},
	{"Sing-box", 1080},
	{"Shadowsocks", 1080},
}

// isPortOpen 快速检查端口是否可连（带超时）。
func isPortOpen(host string, port int, timeout time.Duration) bool {
	addr := fmt.Sprintf("%s:%d", host, port)
	conn, err := netDialTimeout(addr, timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// supportedCountries 是支持的地区列表（机房代码 → 中文名）。
var supportedCountries = []map[string]string{
	{"code": "HKG", "name": "香港"},
	{"code": "TPE", "name": "台北"},
	{"code": "NRT", "name": "东京"},
	{"code": "KIX", "name": "大阪"},
	{"code": "ICN", "name": "首尔"},
	{"code": "SIN", "name": "新加坡"},
	{"code": "BKK", "name": "曼谷"},
	{"code": "KUL", "name": "吉隆坡"},
	{"code": "CGK", "name": "雅加达"},
	{"code": "MNL", "name": "马尼拉"},
	{"code": "SGN", "name": "胡志明"},
	{"code": "BOM", "name": "孟买"},
	{"code": "SYD", "name": "悉尼"},
	{"code": "MEL", "name": "墨尔本"},
	{"code": "AKL", "name": "奥克兰"},
	{"code": "LAX", "name": "洛杉矶"},
	{"code": "SJC", "name": "圣何塞"},
	{"code": "SEA", "name": "西雅图"},
	{"code": "DFW", "name": "达拉斯"},
	{"code": "ORD", "name": "芝加哥"},
	{"code": "IAD", "name": "华盛顿"},
	{"code": "EWR", "name": "纽瓦克"},
	{"code": "YYZ", "name": "多伦多"},
	{"code": "LHR", "name": "伦敦"},
	{"code": "MAN", "name": "曼彻斯特"},
	{"code": "AMS", "name": "阿姆斯特丹"},
	{"code": "FRA", "name": "法兰克福"},
	{"code": "CDG", "name": "巴黎"},
	{"code": "MAD", "name": "马德里"},
	{"code": "MXP", "name": "米兰"},
	{"code": "ARN", "name": "斯德哥尔摩"},
	{"code": "WAW", "name": "华沙"},
	{"code": "IST", "name": "伊斯坦布尔"},
	{"code": "DXB", "name": "迪拜"},
	{"code": "TLV", "name": "特拉维夫"},
	{"code": "JNB", "name": "约翰内斯堡"},
	{"code": "GRU", "name": "圣保罗"},
	{"code": "EZE", "name": "布宜诺斯艾利斯"},
	{"code": "MEX", "name": "墨西哥城"},
}
