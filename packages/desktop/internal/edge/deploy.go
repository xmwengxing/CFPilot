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
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
)

//go:embed assets/worker.js assets/dashboard.html assets/dashboard-worker.js assets/schema.sql
var assets embed.FS

const (
	edgeCompatDate = "2026-01-01"
	doClassName    = "MeshRoom"
)

// Options 是部署参数（与 CLI EdgeDeployOptions 对齐）。
type Options struct {
	AccountID         string
	Domain            string
	WorkerName        string
	MonitorPassword   string
	MonitorToken      string
	DashboardProject  string
	WithDashboard     bool
	ZoneID            string
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

// Deploy 执行完整部署编排。
func Deploy(ctx context.Context, client *cfapi.Client, raw Options) (*Result, error) {
	opt := raw
	opt.defaults()
	if strings.TrimSpace(opt.Domain) == "" {
		return nil, fmt.Errorf("盲中继必须提供自定义域名（*.workers.dev 国内被污染）")
	}
	if len(opt.MonitorPassword) < 8 {
		return nil, fmt.Errorf("监测台密码至少 8 位")
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
		return nil, fmt.Errorf("创建 D1 失败：%w", err)
	}
	statements := splitSQL(string(schemaSQL))
	opt.Progress(fmt.Sprintf("D1 已创建：%s，初始化 schema（%d 条）", db.Name, len(statements)))
	for _, sql := range statements {
		if err := client.QueryD1(ctx, opt.AccountID, db.UUID, sql); err != nil {
			return nil, fmt.Errorf("D1 schema 初始化失败（%s…）：%w", firstN(sql, 40), err)
		}
	}

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

	// 3. 域名
	if opt.ZoneID != "" {
		opt.Progress("步骤 3/5：绑定自定义域名 " + opt.Domain)
		if _, err := client.AttachWorkerDomain(ctx, opt.AccountID, opt.Domain, opt.WorkerName, opt.ZoneID); err != nil {
			return nil, fmt.Errorf("绑定域名失败：%w", err)
		}
	} else {
		opt.Progress("步骤 3/5：跳过域名绑定（请到控制台手动绑定 " + opt.Domain + "）")
	}

	// 4. /auth/setup
	opt.Progress("步骤 4/5：设置监测台初始密码")
	if err := setupMonitorPassword(ctx, workerURL, opt.MonitorPassword); err != nil {
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

var defaultAPIRe = regexp.MustCompile(`const DEFAULT_API = '[^']*'`)

// replaceDefaultAPI 把面板默认 API 指向本次 Worker（与 CLI 同语义）。
func replaceDefaultAPI(html, workerURL string) string {
	return defaultAPIRe.ReplaceAllString(html, "const DEFAULT_API = '"+workerURL+"'")
}

func setupMonitorPassword(ctx context.Context, workerURL, password string) error {
	body, _ := json.Marshal(map[string]string{"password": password})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, workerURL+"/auth/setup", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("设置监测台密码失败：%w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 && resp.StatusCode != 409 {
		return fmt.Errorf("设置监测台密码失败（HTTP %d）", resp.StatusCode)
	}
	return nil // 409 = 已有密码，幂等成功
}

func firstN(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// ZoneNameFromDomain 暴露给 server 层用于自动查 zone。
func ZoneNameFromDomain(domain string) string { return zoneNameFromDomain(domain) }
