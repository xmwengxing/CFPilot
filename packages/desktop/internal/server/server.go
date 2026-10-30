// Package server 实现 CFPilot 桌面版的本地 HTTP 服务。
//
// ## 设计要点
//
// 桌面版不再自带浏览器内核：服务监听 127.0.0.1，用户用系统浏览器访问。
// 界面层（index.html / renderer.js）与 Electron 版**完全同一份源码**，
// 差别只在通信层：Electron 走 ipcRenderer.invoke，这里走 fetch('/api/...')。
//
// ## 安全模型
//
// 这个服务能读写 Cloudflare Token，是本地的高价值目标，因此：
//
//  1. **只监听回环地址**（127.0.0.1），不监听 0.0.0.0 —— 局域网不可达。
//  2. **启动令牌**：进程启动时生成一次性 token，拼在欢迎 URL 里。
//     首次访问用它换一个 HttpOnly Cookie，之后的 API 请求只认 Cookie。
//     这样别的网页没法直接调用本服务的 API（它拿不到 token）。
//  3. **Origin 校验**：凡是带 Origin 头的请求，必须是本站 Origin。
//     防止恶意网页用跨站请求打本地端口。
//  4. **Host 校验**：只接受 localhost / 127.0.0.1 的 Host 头，
//     防 DNS Rebinding（把 evil.com 解析到 127.0.0.1 来绕过同源策略）。
package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/safe"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/store"
)

//go:embed all:assets
var embeddedFS embed.FS

// SessionCookie 是换取会话用的 Cookie 名。
const SessionCookie = "cfpilot_session"

// Server 是本地服务实例。
type Server struct {
	mu       sync.RWMutex
	settings config.DesktopSettings
	// sessionToken 是当前有效的会话令牌（HttpOnly Cookie 的值）
	sessionToken string
	// bootToken 是启动时打印在 URL 里的一次性令牌
	bootToken string
	listener  net.Listener
	httpSrv   *http.Server
	startedAt time.Time
	// store 是凭据库（与 Electron 版共用同一份 secrets.json）
	store *store.Store
	// events 是 SSE 事件总线（推送日志 / 部署状态 / 扫描结果）
	events *eventBus
	// deploy 是部署任务状态（同一时刻只允许一个部署）
	deploy deployState
	// scan 是优选任务状态（同一时刻只允许一个扫描）
	scan scanState
	// update 是更新下载状态
	update updateState
	// cfBase 覆盖 Cloudflare API 根地址（测试用；生产恒为空 → 走官方地址）
	cfBase string
}

// New 创建一个服务实例（不启动监听）。
func New(settings config.DesktopSettings) (*Server, error) {
	boot, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	return &Server{
		settings:  settings,
		bootToken: boot,
		startedAt: time.Now(),
		store:     store.New(""),
		events:    newEventBus(),
	}, nil
}

// SetStore 注入凭据库（测试用；生产环境用默认目录）。
func (s *Server) SetStore(st *store.Store) {
	s.store = st
}

// SetCFAPIBase 注入 Cloudflare API 根地址（测试用）。
//
// 生产恒为空 —— 空串会让 cfapi 走官方地址（cfapi.DefaultAPIBase）。
// 测试要指向 httptest 服务器，才能验证
// 「请求里的 kvNamespaceId 是否真被用上」「外部 Token 是否被落盘」
// 这类**接口契约**（它们都是踩过坑才写对的规则）。
func (s *Server) SetCFAPIBase(base string) {
	s.cfBase = base
}

// BootToken 返回一次性启动令牌（供托盘「打开界面」拼接 URL）。
func (s *Server) BootToken() string {
	return s.bootToken
}

// WelcomeURL 返回带启动令牌的欢迎地址。
func (s *Server) WelcomeURL() string {
	return fmt.Sprintf("http://%s:%d/?t=%s", browseHost(s.settings.Host), s.port(), s.bootToken)
}

// ServiceURL 返回独立服务管理页的地址。
func (s *Server) ServiceURL() string {
	return fmt.Sprintf("http://%s:%d/service", browseHost(s.settings.Host), s.port())
}

// browseHost 把监听地址转成浏览器可访问的地址。
//
// `0.0.0.0` / `::` 是「监听所有网卡」的表示，不能直接放进 URL ——
// 浏览器访问 `http://0.0.0.0:19726` 在部分系统上是未定义行为。
func browseHost(host string) string {
	if host == "" || host == config.AnyHost || host == "::" {
		return config.LoopbackHost
	}
	return host
}

func (s *Server) port() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settings.Port
}

// Settings 返回当前设置副本。
func (s *Server) Settings() config.DesktopSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settings
}

// Start 开始监听。端口被占用时返回可读的错误。
func (s *Server) Start() error {
	addr := net.JoinHostPort(s.settings.Host, strconv.Itoa(s.settings.Port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		if isAddrInUse(err) {
			return fmt.Errorf("端口 %d 已被占用，请在托盘菜单里换一个端口", s.settings.Port)
		}
		return fmt.Errorf("无法监听 %s：%w", addr, err)
	}
	s.listener = ln
	s.httpSrv = &http.Server{
		Handler:           s.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := s.httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("[cfpilot] 服务异常退出：%v", err)
		}
	}()
	log.Printf("[cfpilot] 已启动：http://%s", addr)
	return nil
}

// Stop 关闭监听。
//
// ## 为什么用 Shutdown 而不是 Close
//
// Close 会**立刻掐断所有连接**，包括正在处理的那个请求本身 ——
// 用户点「修改端口」，服务端处理完关监听时把这条连接的响应也砍了，
// 浏览器只会看到「The response ended prematurely」，以为操作失败。
// Shutdown 会等在途请求写完再关。
//
// ## 超时不能设太长
//
// 换端口时「本请求」正是要等的那个在途请求，Shutdown 会一直等到它结束。
// 超时设 5 秒就会让停服务卡 5 秒（测试里更是每次收尾都多等 5 秒）。
// 真正的换端口流程已经改成「先 flush 响应再后台执行」，
// 所以这里 800ms 足够覆盖正常收尾，超时就强关。
func (s *Server) Stop() error {
	s.mu.Lock()
	srv := s.httpSrv
	s.httpSrv = nil
	s.listener = nil
	s.mu.Unlock()
	if srv == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		// 超时还没关干净就强关，避免托盘里点了「停止」却还占着端口
		_ = srv.Close()
		return nil
	}
	return nil
}

// UpdatePort 换端口：先关旧监听，再在新端口上起服务。
//
// 失败时回滚到原端口，避免用户改错一个数字就把服务搞没了。
func (s *Server) UpdatePort(port int) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("端口 %d 超出范围（1-65535）", port)
	}
	s.mu.Lock()
	old := s.settings.Port
	s.mu.Unlock()
	if port == old {
		return nil
	}

	// 先确认新端口能绑上，再动旧监听 ——
	// 否则端口被占用时要先停后起，中间有一段时间界面直接失联。
	if err := probePortFree(port); err != nil {
		return fmt.Errorf("端口 %d 不可用：%w", port, err)
	}

	if err := s.Stop(); err != nil {
		return fmt.Errorf("关闭原监听失败：%w", err)
	}

	s.mu.Lock()
	s.settings.Port = port
	s.mu.Unlock()

	if err := s.Start(); err != nil {
		// 回滚
		s.mu.Lock()
		s.settings.Port = old
		s.mu.Unlock()
		if rbErr := s.Start(); rbErr != nil {
			return fmt.Errorf("换端口失败（%w），且回滚到 %d 也失败（%v）", err, old, rbErr)
		}
		return fmt.Errorf("换端口失败：%w（已回滚到 %d）", err, old)
	}

	if err := config.SaveSettings(s.Settings()); err != nil {
		return fmt.Errorf("端口已切换，但保存设置失败：%w", err)
	}
	return nil
}

// probePortFree 试绑端口，确认可用后立即释放。
func probePortFree(port int) error {
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		if isAddrInUse(err) {
			return fmt.Errorf("已被其他程序占用")
		}
		return err
	}
	return ln.Close()
}

// ---------- 路由 ----------

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	// 静态资源（内嵌的界面文件）
	sub, err := fs.Sub(embeddedFS, "assets")
	if err != nil {
		panic(err)
	}
	mux.Handle("/", http.FileServer(http.FS(sub)))

	// 会话换取：首次访问带 ?t=<bootToken> 换 Cookie
	mux.HandleFunc("/__session", s.handleSession)

	// 服务管理 API（托盘里的功能也用这些接口，做到「界面与托盘同一套逻辑」）
	mux.HandleFunc("/api/service/status", s.guard(s.handleServiceStatus))
	// 日志浏览（界面「日志」页签用）
	s.registerLogRoutes(mux)
	mux.HandleFunc("/api/service/port", s.guard(s.handleServicePort))
	mux.HandleFunc("/api/service/stop", s.guard(s.handleServiceStop))

	// 账户与凭据 API
	s.registerCredRoutes(mux)

	// SSE 事件推送（日志 / 部署状态 / 扫描结果）
	s.registerEventRoutes(mux)

	// 部署 / KV / 账号检测 API
	s.registerDeployRoutes(mux)

	// 优选 / 环境检测 API
	s.registerScanRoutes(mux)

	// 检查更新 API
	s.registerUpdateRoutes(mux)

	// 链式代理（自建落地节点）API
	s.registerChainRoutes(mux)

	return s.withCommonHeaders(mux)
}

// withCommonHeaders 统一加安全响应头与 Host 校验。
//
// ## Host 校验的两种模式
//
// 校验 Host 头的目的是**防 DNS Rebinding**：
// 恶意网页把自己的域名解析到 127.0.0.1，再让浏览器请求本服务。
// 浏览器发请求时 Host 头会是 `evil.com`，我们据此拒绝。
//
//   - **仅本机模式**（默认）：Host 必须是回环地址
//     （`127.0.0.1` / `localhost` / `[::1]` / 本机网卡 IP）。
//   - **局域网模式**（用户显式开启）：额外放行私有网段的 IP 与
//     本机主机名 —— 否则同事用 `http://192.168.1.10:19726`
//     访问时 Host 是 `192.168.1.10`，会被判成非法而打不开。
//
// ⚠️ 局域网模式下**仍然拒绝任意域名**（`evil.com` 一律 403），
// 所以 DNS Rebinding 依然防得住 —— 攻击者无法让 Host 头变成内网 IP。
func (s *Server) withCommonHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowLAN := s.Settings().AllowLAN

		// Host 校验：防 DNS Rebinding
		if !hostAllowed(r.Host, allowLAN) {
			http.Error(w, "非法 Host", http.StatusForbidden)
			return
		}
		// 同源校验：带 Origin 时必须是同 Host
		if origin := r.Header.Get("Origin"); origin != "" && !s.originAllowed(origin, r.Host) {
			http.Error(w, "非法 Origin", http.StatusForbidden)
			return
		}

		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		// 界面不需要被任何外部页面嵌入
		w.Header().Set("X-Frame-Options", "DENY")
		// 本地服务不缓存：避免浏览器拿旧界面
		w.Header().Set("Cache-Control", "no-store")

		// ⚠️ **panic 兜底**：Go 里 handler panic 会让整个进程退出
		// （net/http 的 recover 只保护连接，不保护进程）。
		// 一次请求里的 nil 解引用就会把「托盘 + 服务 + 正在跑的扫描」全部带走，
		// 而托盘模式下 panic 信息写在 stderr（用户看不见）→ 表现为「服务莫名消失」。
		//
		// 这里接住 → 记日志（含堆栈）→ 返回 500，连接与进程都保住。
		defer func() {
			if r := safe.Recover("处理 HTTP 请求 " + r.Method + " " + r.URL.Path); r != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{
					"error": "服务内部错误，详情已记入日志",
				})
			}
		}()

		next.ServeHTTP(w, r)
	})
}

// hostAllowed 判断 Host 头是否可接受。
//
// allowLAN 为 true 时，额外放行私有网段地址与主机名（局域网访问场景）。
func hostAllowed(hostport string, allowLAN bool) bool {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	host = strings.Trim(host, "[]")

	// 回环 / localhost 永远放行
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		// 非 IP 的 Host（如主机名）。仅本机模式下一律拒绝，
		// 局域网模式下放行「看起来像内网主机名」的简单名称。
		if !allowLAN {
			return false
		}
		return isSimpleHostname(host)
	}
	if ip.IsLoopback() {
		return true
	}
	if !allowLAN {
		return false
	}
	// 局域网模式：只放行私有网段（10/8、172.16/12、192.168/16、fc00::/7、fe80::/10）
	return ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

// isSimpleHostname 判断是否是简单主机名（不含点，或含点但不是公网域名）。
//
// 用于局域网模式下允许 `http://my-pc:19726` 这种访问。
// 明确排除带公网后缀的名称，避免被 DNS Rebinding 利用。
func isSimpleHostname(host string) bool {
	if host == "" || len(host) > 253 {
		return false
	}
	// 不含点 → 是本地主机名（如 DESKTOP-ABC），放行
	if !strings.Contains(host, ".") {
		return true
	}
	// 含点的一律拒绝：`evil.com` 可能被解析到 127.0.0.1
	return false
}

// guard 校验会话 Cookie，未通过直接 401。
func (s *Server) guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.hasValidSession(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{
				"error": "未授权：请从托盘菜单打开界面，或用带 t= 参数的欢迎链接访问",
			})
			return
		}
		h(w, r)
	}
}

func (s *Server) hasValidSession(r *http.Request) bool {
	c, err := r.Cookie(SessionCookie)
	if err != nil {
		return false
	}
	s.mu.RLock()
	want := s.sessionToken
	s.mu.RUnlock()
	if want == "" || c.Value == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(c.Value), []byte(want)) == 1
}

func (s *Server) originAllowed(origin, host string) bool {
	// Origin 形如 http://127.0.0.1:19726
	const p = "http://"
	if !strings.HasPrefix(origin, p) {
		return false
	}
	return strings.EqualFold(strings.TrimPrefix(origin, p), host)
}

// ---------- handlers ----------

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	t := r.URL.Query().Get("t")
	if t == "" || subtle.ConstantTimeCompare([]byte(t), []byte(s.bootToken)) != 1 {
		http.Error(w, "启动令牌无效", http.StatusForbidden)
		return
	}
	token, err := randomHex(24)
	if err != nil {
		http.Error(w, "内部错误", http.StatusInternalServerError)
		return
	}
	s.mu.Lock()
	s.sessionToken = token
	s.mu.Unlock()

	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		// ⚠️ 用 Lax 而不是 Strict。
		//
		// Strict 的语义是「任何跨站来源的请求都不带 Cookie」，
		// 包括**从地址栏直接粘贴 URL 打开**这种场景在某些浏览器上
		// 也会被判为「无来源」而不携带 —— 表现为会话明明建立了，
		// 后续 API 仍然全线 401。
		//
		// Lax 仍然阻止跨站 POST（本服务所有写操作都是 POST），
		// 安全性等价，兼容性更好。
		SameSite: http.SameSiteLaxMode,
		// 本地 http 服务，不能设 Secure（否则浏览器不会回传）
		MaxAge: 12 * 60 * 60,
	})
	// 明确告诉浏览器/代理不要缓存这次会话建立
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "expiresIn": 12 * 60 * 60})
}

func (s *Server) handleServiceStatus(w http.ResponseWriter, r *http.Request) {
	st := s.Settings()
	writeJSON(w, http.StatusOK, map[string]any{
		"running":       true,
		"host":          st.Host,
		"port":          st.Port,
		"url":           fmt.Sprintf("http://%s:%d/", st.Host, st.Port),
		"uptimeSeconds": int(time.Since(s.startedAt).Seconds()),
		"keepInTray":    st.KeepRunningInTray,
		"settingsFile":  config.SettingsPathForDisplay(),
		"pid":           osGetpid(),
	})
}

func (s *Server) handleServicePort(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var body struct {
		Port int `json:"port"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}
	if body.Port < 1 || body.Port > 65535 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": fmt.Sprintf("端口 %d 超出范围（1-65535）", body.Port)})
		return
	}

	// 先做「不关监听就能做」的全部校验，失败直接回错误，服务不受影响。
	if body.Port == s.port() {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "port": body.Port, "note": "端口未变化"})
		return
	}
	if err := probePortFree(body.Port); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": fmt.Sprintf("端口 %d 不可用：%v", body.Port, err),
		})
		return
	}

	// 关键：关旧监听会掐断「正在处理本请求」的这条连接。
	//
	// 实测两种都会失败：
	//   - Close()         立刻断开 → 客户端 "response ended prematurely"
	//   - Shutdown(ctx)   会等本请求结束，而本请求正等 Shutdown 返回 → 死等到超时
	//
	// 所以必须**先把响应写出去并冲刷**，再在后台换端口。
	w.Header().Set("Connection", "close")
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":   true,
		"port": body.Port,
		"url":  fmt.Sprintf("http://127.0.0.1:%d/", body.Port),
		"note": "端口即将切换到新地址，请用新地址重新打开界面",
	})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	go func() {
		// 给响应一点时间真正离开内核缓冲区
		time.Sleep(250 * time.Millisecond)
		if err := s.UpdatePort(body.Port); err != nil {
			log.Printf("[cfpilot] 换端口失败：%v", err)
		}
	}()
}

func (s *Server) handleServiceStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "note": "服务即将关闭"})
	go func() {
		time.Sleep(300 * time.Millisecond)
		if err := s.Stop(); err != nil {
			log.Printf("[cfpilot] 停止失败：%v", err)
		}
	}()
}

// ---------- 小工具 ----------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func isLoopbackHost(hostport string) bool {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isAddrInUse(err error) bool {
	// 不直接 import syscall 的常量（Windows/Linux 错误码不同），
	// 用错误文本判断已足够，且不引入平台分支
	msg := err.Error()
	return strings.Contains(msg, "Only one usage of each socket address") ||
		strings.Contains(msg, "address already in use")
}
