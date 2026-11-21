// Package edge 实现盲中继 / 云监测台部署（与 CLI packages/cli/src/edge/deploy.ts 同源）。
//
// 产物是独立资源，不碰 CFPilot 代理内核：
//
//	D1 → Worker(DO migration + D1 绑定) → 域名 → /auth/setup → Pages 面板。
//
// 真机约束（2026-11-17 实测）：
//   - D1 建库/query 正常；
//   - 手动建 DO 命名空间被平台禁止（10099），必须走 new_sqlite_classes migration。
package edge

import (
	"bytes"
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
)

//go:embed assets/worker.js assets/dashboard.html assets/dashboard-worker.js assets/schema.sql
var assets embed.FS

const (
	edgeCompatDate      = "2026-01-01"
	doClassName         = "MeshRoom"
	d1ReadyTimeout      = 90 * time.Second
	d1RetryInitialDelay = 500 * time.Millisecond
	d1RetryMaximumDelay = 5 * time.Second
	monitorSetupTimeout = 90 * time.Second
)

var transientD1ProvisioningRe = regexp.MustCompile(`(?i)(?:d1|database).*(?:not found|not ready|not available|unavailable|provision)`)

// Options 是部署参数（与 CLI EdgeDeployOptions 对齐）。
type Options struct {
	AccountID        string
	Domain           string
	WorkerName       string
	MonitorPassword  string
	MonitorToken     string
	DashboardProject string
	WithDashboard    bool
	ZoneID           string
	// AutoDNS：绑定失败（409/100117，同名主机名已有「外部管理」的 DNS 记录）时，
	// 清理**我们自己的旧占位记录**（已代理 AAAA 100:: / CNAME→workers.dev|pages.dev）
	// 后重试绑定。注意：Worker 自定义域名应由 Workers 自动创建 DNS 记录，
	// **不要**在绑定前预建记录 —— 那会被判成 externally managed 而失败。
	AutoDNS           bool
	WindowMs          string
	MaxBytesPerWindow string
	MaxPackets        string
	MaxPeers          string
	Progress          func(string)
}

// Result 是部署结果（与 CLI EdgeDeployResult 对齐）。
type Result struct {
	WorkerName      string `json:"workerName"`
	WorkerURL       string `json:"workerUrl"`
	WssEndpoint     string `json:"wssEndpoint"`
	D1Name          string `json:"d1Name"`
	D1UUID          string `json:"d1Uuid"`
	DoClass         string `json:"doClass"`
	DashboardURL    string `json:"dashboardUrl"`
	MonitorToken    string `json:"monitorToken"`
	MonitorPassword string `json:"monitorPassword"`
}

func (o *Options) defaults() {
	if o.WorkerName == "" {
		o.WorkerName = "mobihop-edge-relay"
	}
	if o.WithDashboard {
		// 保持显式 true；零值 false 仅在调用方明确不部署时为 false
	}
	if o.WindowMs == "" {
		o.WindowMs = "1000"
	}
	if o.MaxBytesPerWindow == "" {
		o.MaxBytesPerWindow = "1048576"
	}
	if o.MaxPackets == "" {
		o.MaxPackets = "2000"
	}
	if o.MaxPeers == "" {
		o.MaxPeers = "512"
	}
	if o.Progress == nil {
		o.Progress = func(string) {}
	}
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// cleanupPlaceholderDNS 在 Worker 自定义域名绑定被 100117 拒绝时，清理**可识别的**
// 旧占位记录（已代理 AAAA 100::，或指向 workers.dev / pages.dev 的 CNAME）。
//
// 遇到用户自己的其它记录（例如真实 A 记录、指向自有域名的 CNAME）时返回错误，
// 由调用方提示用户手动处理 —— 部署工具不擅自删除用户 DNS。
func cleanupPlaceholderDNS(ctx context.Context, client *cfapi.Client, zoneID, domain string) error {
	records, err := client.ListDNSRecords(ctx, zoneID, domain)
	if err != nil {
		return err
	}
	removed := 0
	for _, r := range records {
		if !strings.EqualFold(r.Name, domain) {
			continue
		}
		isPlaceholder := (r.Type == "AAAA" && r.Content == "100::") ||
			(r.Type == "CNAME" && (strings.Contains(r.Content, ".workers.dev") || strings.Contains(r.Content, ".pages.dev")))
		if !isPlaceholder {
			return fmt.Errorf("同名记录 %s %s 不是占位记录，请手动删除或换子域", r.Type, r.Content)
		}
		if derr := client.DeleteDNSRecord(ctx, zoneID, r.ID); derr != nil {
			return derr
		}
		removed++
	}
	if removed == 0 {
		return fmt.Errorf("未找到可清理的占位记录（可能仍被其它记录占用）")
	}
	return nil
}

// waitDomainResolvable 轮询直到域名可解析。
//
// 判据放宽为「本地 DNS 或公共 DoH 任一能解析即通过」：
// 部署进程（Windows 服务 / 后台）的 DNS 可能比浏览器慢，或只返回 IPv6
// （net.LookupHost 仍算成功）。旧版 60s 内一直失败就整单失败，太脆弱。
func waitDomainResolvable(ctx context.Context, domain string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for {
		if ips, err := net.LookupHost(domain); err == nil && len(ips) > 0 {
			return nil
		} else if err != nil {
			lastErr = err
		}
		// 备用：DoH 查询（绕开本机 DNS 缓存/超时）
		if ok, derr := resolveViaDoH(ctx, domain); ok {
			return nil
		} else if derr != nil {
			lastErr = derr
		}
		if time.Now().After(deadline) {
			if lastErr != nil {
				return fmt.Errorf("DNS 未生效（最后错误：%v）", lastErr)
			}
			return fmt.Errorf("DNS 未生效")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// resolveViaDoH 用公共 DNS-over-HTTPS 查询 A 记录，作为本地解析失败时的备用判据。
func resolveViaDoH(ctx context.Context, domain string) (bool, error) {
	url := "https://223.5.5.5/resolve?name=" + url.QueryEscape(domain) + "&type=A"
	client := &http.Client{Timeout: 5 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	var out struct {
		Status int `json:"Status"`
		Answer []struct {
			Type int `json:"type"`
		} `json:"Answer"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return false, err
	}
	if out.Status != 0 {
		return false, nil
	}
	for _, a := range out.Answer {
		if a.Type == 1 {
			return true, nil
		}
	}
	return false, nil
}

// zoneNameFromDomain 从 relay.example.com 推 example.com（仅用于提示）。
func zoneNameFromDomain(domain string) string {
	parts := strings.Split(strings.TrimSuffix(strings.ToLower(domain), "."), ".")
	if len(parts) >= 2 {
		return strings.Join(parts[len(parts)-2:], ".")
	}
	return domain
}

// splitSQL 按分号拆分并剥掉注释行（与 CLI splitSchemaSql 同语义）。
func splitSQL(sql string) []string {
	lines := strings.Split(sql, "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		kept = append(kept, line)
	}
	var out []string
	for _, stmt := range strings.Split(strings.Join(kept, "\n"), ";") {
		if s := strings.TrimSpace(stmt); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func isTransientD1Error(err error) bool {
	if err == nil {
		return false
	}
	var apiErr *cfapi.APIError
	if errors.As(err, &apiErr) {
		if apiErr.Status == http.StatusRequestTimeout || apiErr.Status == http.StatusTooEarly ||
			apiErr.Status == http.StatusTooManyRequests || apiErr.Status >= http.StatusInternalServerError {
			return true
		}
		return transientD1ProvisioningRe.MatchString(apiErr.Message)
	}
	var netErr net.Error
	return errors.As(err, &netErr)
}

func waitD1Retry(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func queryD1WithRetry(ctx context.Context, client *cfapi.Client, accountID, databaseID, sql string, deadline time.Time, operation string, report func(string)) error {
	delay := d1RetryInitialDelay
	attempts := 0
	for {
		if time.Now().After(deadline) {
			return fmt.Errorf("%s在 %d 秒内未完成（已重试 %d 次）", operation, int(d1ReadyTimeout.Seconds()), attempts)
		}
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("%s已取消：%w", operation, err)
		}
		attempts++
		requestCtx, cancel := context.WithDeadline(ctx, deadline)
		err := client.QueryD1(requestCtx, accountID, databaseID, sql)
		cancel()
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s在 %d 秒内未完成（已重试 %d 次）：%w", operation, int(d1ReadyTimeout.Seconds()), attempts-1, err)
		}
		if !isTransientD1Error(err) {
			return fmt.Errorf("%s失败：%w", operation, err)
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return fmt.Errorf("%s在 %d 秒内未完成（已重试 %d 次）：%w", operation, int(d1ReadyTimeout.Seconds()), attempts-1, err)
		}
		wait := delay
		if wait > remaining {
			wait = remaining
		}
		if report != nil {
			report(fmt.Sprintf("D1 暂不可用，%.1f 秒后重试%s（第 %d 次）", wait.Seconds(), operation, attempts+1))
		}
		if waitErr := waitD1Retry(ctx, wait); waitErr != nil {
			return fmt.Errorf("%s已取消：%w", operation, waitErr)
		}
		if delay < d1RetryMaximumDelay {
			delay *= 2
			if delay > d1RetryMaximumDelay {
				delay = d1RetryMaximumDelay
			}
		}
	}
}

func initializeD1Schema(ctx context.Context, client *cfapi.Client, accountID, databaseID string, statements []string, report func(string)) error {
	deadline := time.Now().Add(d1ReadyTimeout)
	workCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	if report != nil {
		report("等待 D1 就绪")
	}
	if err := queryD1WithRetry(workCtx, client, accountID, databaseID, "SELECT 1", deadline, "D1 就绪检查", report); err != nil {
		return err
	}
	if report != nil {
		report("D1 已就绪，开始初始化 schema")
	}
	for _, sql := range statements {
		if err := queryD1WithRetry(workCtx, client, accountID, databaseID, sql, deadline, fmt.Sprintf("D1 schema 初始化失败（%s…）", firstN(sql, 40)), report); err != nil {
			return err
		}
	}
	return nil
}

// Deploy 执行完整部署编排。
func Deploy(ctx context.Context, client *cfapi.Client, raw Options) (*Result, error) {
	opt := raw
	opt.defaults()
	if strings.TrimSpace(opt.Domain) == "" {
		return nil, fmt.Errorf("盲中继必须提供自定义域名（*.workers.dev 国内被污染）")
	}
	// 初始密码留空 = 自动生成（此前界面写着「留空则自动生成」，实现却直接报错）
	if strings.TrimSpace(opt.MonitorPassword) == "" {
		opt.MonitorPassword = randomHex(8) // 16 位 hex，满足 ≥8
	} else if len(opt.MonitorPassword) < 8 {
		return nil, fmt.Errorf("监测台密码至少 8 位（留空可自动生成）")
	}

	workerCode, err := assets.ReadFile("assets/worker.js")
	if err != nil {
		return nil, fmt.Errorf("读取内置 worker.js 失败：%w（请先运行 npm run build -w cfpilot）", err)
	}
	dashWorker, err := assets.ReadFile("assets/dashboard-worker.js")
	if err != nil {
		return nil, fmt.Errorf("读取内置 dashboard-worker.js 失败：%w（请先运行 npm run build -w cfpilot）", err)
	}
	schemaSQL, err := assets.ReadFile("assets/schema.sql")
	if err != nil {
		return nil, fmt.Errorf("读取内置 schema.sql 失败：%w", err)
	}
	monitorToken := opt.MonitorToken
	if monitorToken == "" {
		monitorToken = randomHex(24)
	}
	d1Name := opt.WorkerName + "-monitor"

	// 1. D1 + schema
	opt.Progress("步骤 1/5：创建监测数据库（D1）")
	db, err := client.CreateD1Database(ctx, opt.AccountID, d1Name)
	if err != nil {
		// 重试部署时 D1 已存在：按名字复用，而不是直接失败。
		var reused bool
		if list, lerr := client.ListD1Databases(ctx, opt.AccountID); lerr == nil {
			for i := range list {
				if list[i].Name == d1Name {
					db = &list[i]
					reused = true
					break
				}
			}
		}
		if db == nil {
			return nil, fmt.Errorf("创建 D1 失败：%w", err)
		}
		opt.Progress("D1 已存在，复用：" + d1Name)
		_ = reused
	}
	statements := splitSQL(string(schemaSQL))
	opt.Progress(fmt.Sprintf("D1 已创建：%s，等待就绪并初始化 schema（%d 条）", db.Name, len(statements)))
	if err := initializeD1Schema(ctx, client, opt.AccountID, db.UUID, statements, opt.Progress); err != nil {
		return nil, err
	}
	opt.Progress("D1 schema 初始化完成")

	// 2. Worker（DO migration + D1 绑定 + vars）
	opt.Progress("步骤 2/5：部署盲中继 Worker（含 Durable Objects 房间）")
	bindings := []cfapi.WorkerBinding{
		{"type": "d1", "name": "DB", "id": db.UUID},
		{"type": "durable_object_namespace", "name": "MESH_ROOM", "class_name": doClassName},
		{"type": "plain_text", "name": "MONITOR_TOKEN", "text": monitorToken},
		{"type": "plain_text", "name": "WINDOW_MS", "text": opt.WindowMs},
		{"type": "plain_text", "name": "MAX_BYTES_PER_WINDOW", "text": opt.MaxBytesPerWindow},
		{"type": "plain_text", "name": "MAX_PACKETS_PER_WINDOW", "text": opt.MaxPackets},
		{"type": "plain_text", "name": "MAX_PEERS_PER_ROOM", "text": opt.MaxPeers},
	}
	// 新版平台用声明式 exports 声明 DO（真机 2026-11-17 验证），不是旧 migrations 数组
	extra := map[string]any{
		"exports": map[string]any{
			doClassName: map[string]any{"type": "durable-object", "state": "created", "storage": "sqlite"},
		},
	}
	if err := client.UploadWorkerScriptWithExports(ctx, opt.AccountID, opt.WorkerName, workerCode, bindings, edgeCompatDate, extra); err != nil {
		return nil, fmt.Errorf("盲中继 Worker 上传失败：%w（若 migration tag 冲突，请换 worker-name）", err)
	}
	workerURL := "https://" + opt.Domain
	wss := "wss://" + opt.Domain + "/mesh/<network_hash>?peer_id=<16hex>"

	// 3. 域名（由 Workers 自己创建 DNS 记录 → 等解析生效）
	if opt.ZoneID != "" {
		opt.Progress("步骤 3/5：绑定自定义域名 " + opt.Domain)
		_, attachErr := client.AttachWorkerDomain(ctx, opt.AccountID, opt.Domain, opt.WorkerName, opt.ZoneID)
		if attachErr != nil && opt.AutoDNS {
			// 409/100117：同名主机名已有「外部管理」的记录（通常是我们上一轮预建的占位）。
			// 清理**可识别的占位记录**后重试；遇到用户自己的真实记录则明确报错，不擅自删。
			if cerr := cleanupPlaceholderDNS(ctx, client, opt.ZoneID, opt.Domain); cerr != nil {
				return nil, fmt.Errorf("绑定域名失败：%w；且无法自动清理：%v", attachErr, cerr)
			}
			_, attachErr = client.AttachWorkerDomain(ctx, opt.AccountID, opt.Domain, opt.WorkerName, opt.ZoneID)
		}
		if attachErr != nil {
			return nil, fmt.Errorf("绑定域名失败：%w（若同名主机名已有其他 DNS 记录，请先删除或换一个子域）", attachErr)
		}
	} else {
		if opt.AutoDNS {
			opt.Progress("警告：未选择 Cloudflare Zone，无法自动创建 DNS 记录；请在控制台手动创建 " + opt.Domain)
		}
		opt.Progress("步骤 3/5：跳过域名绑定（请到控制台手动绑定 " + opt.Domain + "）")
	}

	// 3b. 尝试等域名解析（非阻塞）：绑定已成功、DNS 记录在控制台可见即可继续。
	// 旧版把「等待解析」做成**硬性失败**（60s 超时就整单失败），但真机上遇到：
	// 浏览器/控制台能看到 A 记录、本机 nslookup 也通，部署进程内 net.LookupHost 却一直失败
	// （后台服务 DNS 环境不同）。既然 /auth/setup 会自己发起 HTTPS 请求验证连通性，
	// 这里只做提示，不再阻断部署。
	opt.Progress("步骤 3/5：检查域名解析 " + opt.Domain)
	if err := waitDomainResolvable(ctx, opt.Domain, 8*time.Second); err != nil {
		opt.Progress("提示：部署进程暂时无法解析 " + opt.Domain + "（" + err.Error() +
			"），继续执行；若后续设置密码失败，请检查本机 DNS 或 hosts 配置")
	} else {
		opt.Progress("域名解析正常")
	}

	// 4. /auth/setup
	opt.Progress("步骤 4/5：设置监测台初始密码")
	if _, err := setupMonitorPassword(ctx, workerURL, opt.MonitorPassword, opt.Progress); err != nil {
		return nil, err
	}

	// 5. Pages 面板
	dashboardURL := ""
	if opt.WithDashboard {
		project := opt.DashboardProject
		if project == "" {
			project = opt.WorkerName + "-dashboard"
		}
		opt.Progress("步骤 5/5：部署监测面板 Pages（" + project + "）")
		// GetPagesProject 在项目不存在时返回 (nil, nil)，不是 error。
		existing, err := client.GetPagesProject(ctx, opt.AccountID, project)
		if err != nil {
			return nil, fmt.Errorf("查询 Pages 项目失败：%w", err)
		}
		if existing == nil {
			if _, err := client.CreatePagesProject(ctx, opt.AccountID, project, "main"); err != nil {
				return nil, fmt.Errorf("创建 Pages 项目失败：%w", err)
			}
		}
		// 面板以 ES module Worker 部署（Pages 静态 Direct Upload 的 manifest/hash 机制复杂；
		// 单页 HTML 包成 Worker 复用已验证的 DeployPagesWorker，真机可用）。
		worker := replaceDefaultAPI(string(dashWorker), workerURL)
		if _, err := client.DeployPagesWorker(ctx, cfapi.PagesDeployOptions{
			AccountID: opt.AccountID,
			Project:   project,
			Script:    []byte(worker),
		}); err != nil {
			return nil, fmt.Errorf("上传监测面板失败：%w", err)
		}
		dashboardURL = "https://" + project + ".pages.dev"
	} else {
		opt.Progress("步骤 5/5：跳过监测面板部署")
	}

	return &Result{
		WorkerName:      opt.WorkerName,
		WorkerURL:       workerURL,
		WssEndpoint:     wss,
		D1Name:          db.Name,
		D1UUID:          db.UUID,
		DoClass:         doClassName,
		DashboardURL:    dashboardURL,
		MonitorToken:    monitorToken,
		MonitorPassword: opt.MonitorPassword,
	}, nil
}

var defaultAPIRe = regexp.MustCompile(`const DEFAULT_API = (?:'[^']*'|location\.origin)`)

// replaceDefaultAPI 把面板默认 API 指向本次 Worker（与 CLI 同语义）。
func replaceDefaultAPI(html, workerURL string) string {
	return defaultAPIRe.ReplaceAllString(html, "const DEFAULT_API = '"+workerURL+"'")
}

func setupMonitorPassword(ctx context.Context, workerURL, password string, report func(string)) (bool, error) {
	body, _ := json.Marshal(map[string]string{"password": password})
	client := &http.Client{Timeout: 15 * time.Second}
	deadline := time.Now().Add(monitorSetupTimeout)
	delay := d1RetryInitialDelay
	attempts := 0
	var lastErr error
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return false, fmt.Errorf("设置监测台密码已取消：%w", err)
		}
		attempts++
		requestCtx, cancel := context.WithDeadline(ctx, deadline)
		req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, workerURL+"/auth/setup", bytes.NewReader(body))
		if err != nil {
			cancel()
			return false, err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode < 400 {
				cancel()
				return false, nil
			}
			if resp.StatusCode == http.StatusConflict {
				cancel()
				return true, nil
			}
			lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
			if resp.StatusCode != http.StatusRequestTimeout && resp.StatusCode != http.StatusTooEarly &&
				resp.StatusCode != http.StatusTooManyRequests && resp.StatusCode < http.StatusInternalServerError {
				cancel()
				return false, fmt.Errorf("设置监测台密码失败（%w）", lastErr)
			}
		} else {
			lastErr = err
		}
		cancel()
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		wait := delay
		if wait > remaining {
			wait = remaining
		}
		if report != nil {
			report(fmt.Sprintf("Worker/D1 尚未就绪，%.1f 秒后重试监测台初始化（第 %d 次）", wait.Seconds(), attempts+1))
		}
		if err := waitD1Retry(ctx, wait); err != nil {
			return false, fmt.Errorf("设置监测台密码已取消：%w", err)
		}
		if delay < d1RetryMaximumDelay {
			delay *= 2
			if delay > d1RetryMaximumDelay {
				delay = d1RetryMaximumDelay
			}
		}
	}
	return false, fmt.Errorf("设置监测台密码在 %d 秒内未完成（已尝试 %d 次）：%w", int(monitorSetupTimeout.Seconds()), attempts, lastErr)
}

func firstN(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// ZoneNameFromDomain 暴露给 server 层用于自动查 zone。
func ZoneNameFromDomain(domain string) string { return zoneNameFromDomain(domain) }
