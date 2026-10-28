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
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/safe"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/store"
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
	mux.HandleFunc("/api/scan/scanner-token", s.guard(s.handleScanScannerToken))
	mux.HandleFunc("/api/scan/push-results", s.guard(s.handleScanPushResults))
	// 一键优选（托盘菜单与界面按钮共用）
	mux.HandleFunc("/api/scan/quick", s.guard(s.handleScanQuick))
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

	// NoCallback 为 true 表示「只输出列表，不回填面板」
	NoCallback bool `json:"noCallback"`
	// CallbackURL 自定义回填地址（留空由 host 推导）
	CallbackURL string `json:"callbackUrl"`
	// ScanToken 回填用的令牌（面板一次性令牌 / SCANNER_TOKEN）
	ScanToken string `json:"scanToken"`

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
		Host:       host,
		Port:       req.Port,
		Candidates: candidates,
		// ⚠️ WSPath 与 ProbePath 必须**分别赋值**，不能互相回落
		//
		//
		// 早期写成 firstNonEmpty(req.WSPath, req.ProbePath, default)，
		// 于是只传 wsPath 时 ProbePath 也变成了代理路径，
		// 测速阶段 GET 一个 WebSocket 端点，只拿到 17 字节，
		// 算出来 0.000004 MB/s。
		WSPath:           firstNonEmpty(req.WSPath, scan.ProbeDefaultPath),
		ProbePath:        firstNonEmpty(req.ProbePath, scan.ProbeDefaultPath),
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

		// ⚠️ **panic 兜底**：扫描跑在后台 goroutine 里，
		// 这里 panic 会让**整个进程**退出（托盘 + 服务 + 日志一起消失），
		// 而 panic 信息在托盘模式下的 stderr 里用户看不见 ——
		// 表现就是「服务莫名被强制退出」。
		//
		// 接住 → 记日志（含堆栈）→ 报给界面，进程继续跑。
		defer func() {
			if r := safe.Recover("优选扫描"); r != nil {
				s.logLevel("优选过程发生内部错误，详情已记入日志（服务继续运行）", "err")
				s.events.publish("scan-result", map[string]any{
					"ok":    false,
					"error": "优选过程发生内部错误，详情已记入日志",
				})
			}
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

		// ---- 结果明细分条打到日志----
		//
		// 早期只在日志里打一行「优选完成：N 个可用节点，最快 X MB/s」，
		// 具体每个 IP 的机房 / TLS / TCP / 下行全都不显示 ——
		// 用户无法在日志里核对结果，也看不到测速是否真的在跑。
		if len(sum.Entries) > 0 {
			s.logLevel(fmt.Sprintf("优选完成：%d 个可用节点", len(sum.Entries)), "ok")
			s.logLevel("排名  地址                     机房  TLS(ms)  TCP(ms)  下行(MB/s)", "info")
			for i, e := range sum.Entries {
				if i >= 30 {
					s.logLevel(fmt.Sprintf("  …（其余 %d 条见页面表格）", len(sum.Entries)-30), "info")
					break
				}
				s.logLevel(fmt.Sprintf("%4d  %-23s  %-4s  %6d  %7d  %9.3f",
					i+1,
					fmt.Sprintf("%s:%d", scan.FormatHost(e.IP), e.Port),
					orDash(e.Colo),
					e.TLSMs,
					e.Latency,
					e.Speed,
				), "info")
			}
			s.logLevel("可复制格式（粘贴到面板「手动优选 IP」框）：", "info")
			s.logLevel(formatCopyable(sum.Entries), "info")
		} else {
			s.logLevel("优选完成，但没有可用节点（检查域名 / WS 路径 / 采样数）", "warn")
		}

		// ---- 回填面板（对应界面「不回填面板，只输出列表」勾选框）----
		//
		// 勾选「不回填」时界面会传 noCallback=true，这里就跳过。
		// 之前这个开关完全没接线，无论勾不勾行为都一样。
		if req.NoCallback {
			s.logLevel("· 已跳过回填（按「不回填面板，只输出列表」的要求）", "info")
		} else if len(sum.Entries) > 0 {
			s.doPanelCallback(ctx, host, sum.Entries, req.ScanToken)
		}

		s.events.publish("scan-result", payload)
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

// handleScanPushResults 把优选结果回填到面板。
//
// ## 与「优选时自动回填」的区别
//
// 早期是优选过程中顺带回填，但那需要提前申请令牌（10 分钟有效），
// 而优选本身要跑几分钟，令牌很容易在回填前过期。
//
// 现在改为：优选只出结果，用户看完后手动点「回填面板」，
// 服务端在那一刻才申请令牌并回填，一气呵成，不会超时。
func (s *Server) handleScanPushResults(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	var req struct {
		// Lines 是可复制格式的行（IP:Port#COLO）
		Lines []string `json:"lines"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	if len(req.Lines) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "没有可回填的 IP"})
		return
	}

	profile, err := s.store.Active()
	if err != nil || profile == nil || strings.TrimSpace(profile.CfToken) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "请先保存 API Token"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()

	// ---- 1. 找控制面 + 面板密码 ----
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

	// ---- 2. 现取临时令牌 ----
	tok := scan.FetchScannerToken(ctx, host, password, 25*time.Second)
	if !tok.OK {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": tok.Error})
		return
	}

	// ---- 3. 回填 ----
	url := scan.DefaultCallbackURL(host)
	res := scan.PostResults(ctx, url, tok.Token, req.Lines, 20*time.Second)
	if !res.OK {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": "回填失败：" + res.Error,
		})
		return
	}

	s.logLevel(fmt.Sprintf("✅ 已回填 %d 条到面板的「手动优选 IP」", len(req.Lines)), "ok")
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":    true,
		"count": len(req.Lines),
		"host":  host,
	})
}

// resolvePanelAccess 从清单里解析控制面地址与面板密码。
//
// 控制面一定是 `ControlSubdomain` —— 数据面没有面板接口
// （真机实测数据面返回 Pages Welcome 页）。
func (s *Server) resolvePanelAccess(ctx context.Context, profile *store.Profile) (*deploy.Manifest, string, string) {
	if profile == nil || strings.TrimSpace(profile.KVNamespaceID) == "" {
		return nil, "", ""
	}
	client := cfapi.New(cfapi.Options{Token: profile.CfToken})
	raw, ok := client.GetKVValue(ctx, profile.AccountID, profile.KVNamespaceID, deploy.ManifestKey)
	if !ok || strings.TrimSpace(raw) == "" {
		return nil, "", ""
	}
	var m deploy.Manifest
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, "", ""
	}
	host := normalizePagesHost(m.ControlSubdomain)
	pw := strings.TrimSpace(m.Credentials.PanelPassword)
	return &m, host, pw
}

// handleScanScannerToken 自动获取面板的一次性扫描令牌。
//
// ## 为什么需要
//
// 「回填优选结果」需要 Bearer 令牌，令牌来自面板的
// `POST /api/v1/scanner-token`，而那个接口要求面板会话。
//
// 桌面版本来就存着面板密码（部署清单 / 账户里都有），
// 所以可以自动「登录 → 取令牌」，用户不用手动去面板点。
//
// ## 密码从哪来（三级查找）
//
//  1. 请求体显式传入（用户在界面上填的）
//  2. 部署清单里保存的 `credentials.panelPassword`
//  3. 当前账户的 PanelPassword
func (s *Server) handleScanScannerToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	var req struct {
		// Host 是控制面地址（如 cpmanager.pages.dev）
		Host string `json:"host"`
		// Password 可选，留空则从清单 / 账户里找
		Password string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	profile, err := s.store.Active()
	if err != nil || profile == nil || strings.TrimSpace(profile.CfToken) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "请先保存 API Token"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// ---- 确定控制面地址 ----
	//
	// ⚠️ 必须用**清单里的 ControlSubdomain**，不能用界面传的 host
	//
	//
	// 原因：界面「目标域名」填的是**数据面**（cpdata.pages.dev），
	// 因为优选要用数据面做 SNI/Host。但面板登录接口 /api/v1/login
	// 只存在于**控制面**（cpmanager.pages.dev）。
	//
	// 真机实测：
	//   控制面登录 → {"ok":true} + 令牌     ✅
	//   数据面登录 → <!DOCTYPE html>...<title>Welcome</title>  ❌
	//
	// 早期实现直接用了 req.Host（数据面），于是拿数据面去登录，
	// 拿到 Welcome 页，报「令牌响应解析失败：<!DOCTYPE html>...」。
	var manifest *deploy.Manifest
	if strings.TrimSpace(profile.KVNamespaceID) != "" {
		client := cfapi.New(cfapi.Options{Token: profile.CfToken})
		if raw, ok := client.GetKVValue(ctx, profile.AccountID, profile.KVNamespaceID, deploy.ManifestKey); ok && strings.TrimSpace(raw) != "" {
			var m deploy.Manifest
			if json.Unmarshal([]byte(raw), &m) == nil {
				manifest = &m
			}
		}
	}
	if manifest == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": "没有找到部署清单，请先在「部署」页完成一次部署",
		})
		return
	}

	host := normalizePagesHost(manifest.ControlSubdomain)
	// 兼容：如果清单里控制面空着但用户传了个看起来像控制面的域名
	if host == "" {
		candidate := strings.TrimSpace(req.Host)
		if candidate != "" && !strings.Contains(candidate, "cpdata") {
			host = candidate
		}
	}
	if host == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": "清单里没有控制面域名，无法登录面板",
		})
		return
	}

	// 防御：如果传进来的是数据面域名，明确告知（而不是让它静默失败）
	if req.Host != "" && normalizePagesHost(req.Host) == normalizePagesHost(manifest.DataSubdomain) {
		s.logLevel("提示：面板登录走控制面 "+host+"（数据面 "+req.Host+" 没有面板接口）", "info")
	}

	// ---- 确定面板密码 ----
	password := strings.TrimSpace(req.Password)
	if password == "" && manifest != nil {
		password = manifest.Credentials.PanelPassword
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

	// ---- 登录并取令牌 ----
	res := scan.FetchScannerToken(ctx, host, password, 25*time.Second)
	if !res.OK {
		s.logLevel("获取扫描令牌失败："+res.Error, "warn")
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": res.Error})
		return
	}

	s.logLevel("✅ 已自动获取扫描令牌（有效期 10 分钟）", "ok")
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"token":     res.Token,
		"host":      host,
		"expiresIn": 600,
	})
}

// doPanelCallback 把优选结果回填到面板的「手动优选 IP」。
//
// 对应界面上的「不回填面板，只输出列表」勾选框。
//
// ## 为什么之前是空壳
//
// 界面有那个勾选框，但 Go 版**从未实现回填** ——
// 勾选状态在渲染层被读取的地方压根不存在，
// 所以取消勾选后点开始优选，界面重渲染又把默认值勾了回去，
// 用户完全无法测试回填是否工作。
//
// ## 令牌从哪来
//
// 面板的 `/api/v1/preferred-ips` 需要 Bearer 令牌：
//   - 面板 UI 里生成的**一次性扫描令牌**（`SCANNER_TOKEN`）
//   - 或内核环境变量 `SCANNER_TOKEN`
//
// 桌面版没有面板密码，拿不到一次性令牌，
// 所以这里优先用用户填的 scanToken；没有再提示去面板取。
func (s *Server) doPanelCallback(ctx context.Context, host string, entries []scan.Entry, scanToken string) {
	url := scan.DefaultCallbackURL(host)
	if url == "" {
		s.logLevel("· 跳过回填：无法确定回填地址", "warn")
		return
	}

	token := strings.TrimSpace(scanToken)
	if token == "" {
		s.logLevel("· 跳过回填：没有扫描令牌", "warn")
		s.logLevel("  → 请到面板「优选库」页生成一次性令牌后填入，或设置环境变量 SCANNER_TOKEN", "warn")
		return
	}

	lines := make([]string, 0, len(entries))
	for _, e := range entries {
		label := e.Colo
		if label == "" {
			label = "CF"
		}
		lines = append(lines, fmt.Sprintf("%s:%d#%s", scan.FormatHost(e.IP), e.Port, label))
	}

	s.logLevel("正在回填到面板："+url, "info")
	res := scan.PostResults(ctx, url, token, lines, 15*time.Second)
	if res.OK {
		s.logLevel(fmt.Sprintf("✅ 已回填 %d 条到面板", len(lines)), "ok")
		return
	}
	s.logLevel("✗ 回填失败："+res.Error, "err")
}

// orDash 空字符串返回 "—"。
func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "—"
	}
	return s
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
		fmt.Fprintf(&sb, "%s:%d#%s\n", scan.FormatHost(e.IP), e.Port, tag)
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
//
// ⚠️ 数据来源必须是 scan 包里的映射（与 CLI 版 countries.ts 同源），
// 不要在这里另写一份 —— 两份表会漂移。
var supportedCountries = buildSupportedCountries()

// buildSupportedCountries 从 scan 包的「国家 → 机房」映射生成界面列表。
//
// 输出顺序：按国家代码字典序，同一国家的机房按映射里的顺序。
func buildSupportedCountries() []map[string]string {
	out := make([]map[string]string, 0, 64)
	for _, country := range scan.SupportedCountries() {
		for _, colo := range scan.CountryColosOf(country) {
			out = append(out, map[string]string{
				"code": colo,
				"name": scan.ColoNameOf(colo),
			})
		}
	}
	return out
}
