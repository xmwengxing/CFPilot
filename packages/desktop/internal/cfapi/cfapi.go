// Package cfapi 是 Cloudflare REST API 的 Go 客户端。
//
// ## 与 Electron 版的关系
//
// 对应 packages/deploy-wizard/src/cf-api.ts。字段名、错误码语义、
// 边界行为（404 返回 nil 而不是报错、DELETE 无响应体等）都必须一致 ——
// 部署向导的 8000119 风控判定、域名迁移、KV 归属校验都建立在这些细节上。
//
// ## 三个必须遵守的约束
//
//  1. **multipart 的 Content-Type 必须交给 http 库自己生成**。
//     手动设 boundary 会让 Cloudflare 解析失败，Pages 部署接口对这点尤其敏感。
//  2. **必须校验响应信封的 success 字段**。
//     只看 HTTP 200 会把 `{"success":false,"errors":[...]}` 当成成功，
//     表现为「部署成功但页面还是旧的」，极难排查。
//  3. **account-owned Token（cfat_ 前缀）不能用 /user/tokens/verify**。
//     它只认 /accounts/{id}/tokens/verify，用错端点必然返回 401。
package cfapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"time"
)

// DefaultAPIBase 是 Cloudflare API 根地址。
const DefaultAPIBase = "https://api.cloudflare.com/client/v4"

// DefaultTimeout 是单请求超时。
//
// 30 秒是 Electron 版的值。Pages 部署上传 _worker.js 约 60KB，
// 30 秒足够；但 KV 写入与脚本上传也走这个超时。
const DefaultTimeout = 30 * time.Second

// ErrCodeProjectLimit 是 8000119 —— 项目级风控标记。
//
// 实测：同一项目二次部署 100% 被拒，全新项目首次通常成功。
// 部署向导据此触发「换项目名重试」。
const ErrCodeProjectLimit = 8000119

// APIError 表示 Cloudflare 返回的错误。
type APIError struct {
	// Message 是 errors[0].message 或拼起来的全部消息
	Message string
	// Status 是 HTTP 状态码
	Status int
	// Code 是 Cloudflare 业务错误码（可能为 0，表示响应里没有）
	Code int
	// Raw 是原始响应体（排查用，会截断）
	Raw string
}

func (e *APIError) Error() string {
	if e.Code != 0 {
		return fmt.Sprintf("%s（HTTP %d，code %d）", e.Message, e.Status, e.Code)
	}
	return fmt.Sprintf("%s（HTTP %d）", e.Message, e.Status)
}

// IsProjectLimit 判断是否为 8000119 项目级风控。
func (e *APIError) IsProjectLimit() bool {
	return e.Code == ErrCodeProjectLimit
}

// IsNotFound 判断是否 404。
func (e *APIError) IsNotFound() bool {
	return e.Status == http.StatusNotFound
}

// Client 是 Cloudflare API 客户端。
type Client struct {
	token   string
	apiBase string
	timeout time.Duration
	httpC   *http.Client
}

// Options 是构造参数。
type Options struct {
	// Token 是 Cloudflare API Token
	Token string
	// APIBase 可覆盖（测试用 mock 服务器）
	APIBase string
	// TimeoutMs 是单请求超时（毫秒），0 表示用默认 30 秒
	TimeoutMs int
}

// New 创建客户端。
//
// ## 为什么要自定义 Transport
//
// 最初用 `&http.Client{Timeout: timeout}`，即 Go 默认 Transport。
// 真机部署时出现大量：
//
//	Post "https://api.cloudflare.com/...": EOF
//	请求超时：Cloudflare API 无响应
//
// 甚至被误判成 8000119（业务错误）。根因是默认 Transport 的默认值
// 对「短时间内多次打同一域名」的部署场景不合适：
//
//   - `MaxIdleConnsPerHost` 默认只有 **2**，而我们连续发几十个请求
//     （建项目、配变量、绑 KV、部署、轮询状态），连接频繁新建/关闭
//   - 没有 `DialContext` 超时，TCP 建连卡住时会一直等
//   - 没有 `TLSHandshakeTimeout` / `ExpectContinueTimeout`
//
// 更关键的是：连接被服务端或中间设备（代理/防火墙）过早关闭时，
// Go 会复用一个**已经失效的连接**，直接报 EOF。
// `ForceAttemptHTTP2 = false` + 合理的 IdleConnTimeout 能显著缓解。
func New(opts Options) *Client {
	base := opts.APIBase
	if base == "" {
		base = DefaultAPIBase
	}
	timeout := DefaultTimeout
	if opts.TimeoutMs > 0 {
		timeout = time.Duration(opts.TimeoutMs) * time.Millisecond
	}

	// 针对「连续多次请求同一域名」优化的 Transport
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		// 每个 host 保留更多空闲连接：部署过程会连续打几十个请求，
		// 默认值 2 会导致频繁重建连接（也是 EOF 的来源之一）
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 16,
		MaxConnsPerHost:     32,
		// 空闲连接复用时长：太长会用到被中间设备掐断的死连接
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		// 关闭 HTTP/2：Cloudflare API 上 HTTP/2 复用连接在多请求场景下
		// 偶发 stream 错误，强制 HTTP/1.1 更稳定
		ForceAttemptHTTP2: false,
	}

	return &Client{
		token:   strings.TrimSpace(opts.Token),
		apiBase: strings.TrimRight(base, "/"),
		timeout: timeout,
		httpC: &http.Client{
			Timeout:   timeout,
			Transport: transport,
		},
	}
}

// ---------- 底层请求 ----------

// envelope 是 Cloudflare 的响应信封。
type envelope struct {
	Success bool            `json:"success"`
	Errors  []envelopeErr   `json:"errors"`
	Result  json.RawMessage `json:"result"`
}

type envelopeErr struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// parseAPIError 把错误响应体解析成 *APIError。
func parseAPIError(status int, body []byte) *APIError {
	text := string(body)
	e := &APIError{Status: status, Raw: truncate(text, 300)}
	e.Message = fmt.Sprintf("HTTP %d", status)

	var env envelope
	if err := json.Unmarshal(body, &env); err == nil && len(env.Errors) > 0 {
		msgs := make([]string, 0, len(env.Errors))
		for _, item := range env.Errors {
			msgs = append(msgs, item.Message)
		}
		e.Message = strings.Join(msgs, "; ")
		e.Code = env.Errors[0].Code
	} else if text != "" {
		e.Message = fmt.Sprintf("HTTP %d %s", status, truncate(text, 300))
	}
	return e
}

// readResponse 校验 HTTP 状态 + 响应信封，解出 result。
func readResponse(status int, body []byte) (json.RawMessage, error) {
	if status < 200 || status >= 300 {
		return nil, parseAPIError(status, body)
	}
	// DELETE 等接口可能返回空体
	if len(bytes.TrimSpace(body)) == 0 {
		return nil, nil
	}

	var env envelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, &APIError{
			Message: fmt.Sprintf("响应不是合法 JSON：%s", truncate(string(body), 200)),
			Status:  status,
		}
	}
	// 关键：信封里 success=false 即使 HTTP 200 也是失败
	if !env.Success {
		return nil, parseAPIError(status, body)
	}
	return env.Result, nil
}

// doJSON 发 JSON 请求并解出 result。
func (c *Client) doJSON(ctx context.Context, method, path string, payload any, out any) error {
	var body io.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.apiBase+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	res, err := c.httpC.Do(req)
	if err != nil {
		return wrapNetErr(err)
	}
	defer func() { _ = res.Body.Close() }()

	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return wrapNetErr(err)
	}
	result, err := readResponse(res.StatusCode, raw)
	if err != nil {
		return err
	}
	if out == nil || len(result) == 0 {
		return nil
	}
	return json.Unmarshal(result, out)
}

// doForm 发 multipart 请求并解出 result。
//
// ⚠️ Content-Type 必须由 multipart.Writer 生成（带 boundary），
// 手动设置会让 Cloudflare 解析失败。http 库自动处理这一点，
// 所以我们**不设** Content-Type。
func (c *Client) doForm(
	ctx context.Context,
	method, path string,
	files map[string]FormFile,
	fields map[string]string,
	out any,
) error {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)

	for name, ff := range files {
		fw, err := w.CreateFormFile(name, ff.Filename)
		if err != nil {
			return err
		}
		if _, err := fw.Write(ff.Content); err != nil {
			return err
		}
	}
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			return err
		}
	}
	if err := w.Close(); err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, method, c.apiBase+path, &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", w.FormDataContentType())

	res, err := c.httpC.Do(req)
	if err != nil {
		return wrapNetErr(err)
	}
	defer func() { _ = res.Body.Close() }()

	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return wrapNetErr(err)
	}
	result, err := readResponse(res.StatusCode, raw)
	if err != nil {
		return err
	}
	if out == nil || len(result) == 0 {
		return nil
	}
	return json.Unmarshal(result, out)
}

// FormFile 是一个待上传的文件。
type FormFile struct {
	Filename string
	Content  []byte
}

// wrapNetErr 把网络错误转成用户能看懂的提示。
func wrapNetErr(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("请求超时：Cloudflare API 无响应（检查网络或代理）")
	}
	msg := err.Error()
	if strings.Contains(msg, "timeout") || strings.Contains(msg, "deadline") {
		return fmt.Errorf("请求超时：Cloudflare API 无响应（检查网络或代理）")
	}
	return fmt.Errorf("网络请求失败：%w", err)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ---------- 账号与 Token ----------

// Account 是 Cloudflare 账号。
type Account struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// TokenVerifyResult 是 Token 校验结果。
type TokenVerifyResult struct {
	ID        string `json:"id"`
	Status    string `json:"status"`
	NotBefore string `json:"notBefore"`
	ExpiresOn string `json:"expiresOn"`
}

// VerifyToken 校验 Token。
//
// account-owned Token（cfat_ 前缀）只认账号维度端点：
// /user/tokens/verify 对它一律 401。所以先试用户维度，
// 失败且已知账号时回退到账号维度。
//
// 拿不到元信息**不代表 Token 不可用**，调用方不应据此阻断部署。
func (c *Client) VerifyToken(ctx context.Context, accountID string) (*TokenVerifyResult, error) {
	var r TokenVerifyResult
	if err := c.doJSON(ctx, http.MethodGet, "/user/tokens/verify", nil, &r); err == nil {
		return &r, nil
	} else if accountID == "" {
		return nil, err
	}

	var r2 TokenVerifyResult
	if err := c.doJSON(ctx, http.MethodGet, "/accounts/"+accountID+"/tokens/verify", nil, &r2); err != nil {
		return nil, err
	}
	return &r2, nil
}

// ListAccounts 列出账号。
func (c *Client) ListAccounts(ctx context.Context) ([]Account, error) {
	var out []Account
	if err := c.doJSON(ctx, http.MethodGet, "/accounts?per_page=50", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------- KV ----------

// KVNamespace 是 KV 命名空间。
type KVNamespace struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// ListKVNamespaces 列出 KV 命名空间。
func (c *Client) ListKVNamespaces(ctx context.Context, accountID string) ([]KVNamespace, error) {
	var out []KVNamespace
	if err := c.doJSON(ctx, http.MethodGet,
		"/accounts/"+accountID+"/storage/kv/namespaces", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateKVNamespace 创建 KV 命名空间。
func (c *Client) CreateKVNamespace(ctx context.Context, accountID, title string) (*KVNamespace, error) {
	var out KVNamespace
	if err := c.doJSON(ctx, http.MethodPost,
		"/accounts/"+accountID+"/storage/kv/namespaces",
		map[string]string{"title": title}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// KVReadState 是 KV 读取的三态结果。
//
// ## 为什么要三态
//
// 「键不存在」与「读不到」必须区分：
//
//   - 键不存在（HTTP 404）→ 可以安全当成「空」
//   - 读不到（403 / 500 / 网络异常）→ **不能**当成「空」
//
// 旧实现两者都返回 `("", false)`，于是 KV 归属判定在
// 「KV 属于别的账号」「Token 没权限」「网络断了」时
// 全部落到 `empty`（**不阻断**）→ 继续建项目、写 KV，
// 产出孤儿 Pages 项目与半成品实例。
//
// ⚠️ 与 CLI 版 packages/cli/src/deploy/cf-api.ts 的 getKvValue 语义一致
// （AGENTS.md §2.2：两端行为必须一致）。
type KVReadState int

const (
	// KVFound：键存在。
	KVFound KVReadState = iota
	// KVNotFound：键不存在（HTTP 404）。
	KVNotFound
	// KVError：读取失败（403 / 500 / 网络异常 / 响应异常）。
	KVError
)

// GetKVValueState 读 KV 值，区分「不存在」与「读取失败」。
//
// 返回的 error 只在 KVError 时非空，描述里保留 Cloudflare 原文。
func (c *Client) GetKVValueState(ctx context.Context, accountID, nsID, key string) (string, KVReadState, error) {
	p := fmt.Sprintf("/accounts/%s/storage/kv/namespaces/%s/values/%s",
		accountID, nsID, url.PathEscape(key))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.apiBase+p, nil)
	if err != nil {
		return "", KVError, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)

	res, err := c.httpC.Do(req)
	if err != nil {
		return "", KVError, err
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode == http.StatusNotFound {
		return "", KVNotFound, nil
	}
	if res.StatusCode != http.StatusOK {
		return "", KVError, fmt.Errorf("读取 KV 失败：HTTP %d", res.StatusCode)
	}
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return "", KVError, err
	}
	return string(raw), KVFound, nil
}

// GetKVValue 读 KV 值；不存在或失败时返回 ("", false)。
//
// ⚠️ 这是**宽松**版本：「不存在」与「读取失败」都当 false。
//
// 只适用于「读不到也无所谓」的场景（扫描时的可选探测）。
// **需要区分两者的地方必须用 GetKVValueState** ——
// 典型是 KV 归属判定（读不到时不可放行）。
func (c *Client) GetKVValue(ctx context.Context, accountID, nsID, key string) (string, bool) {
	raw, state, _ := c.GetKVValueState(ctx, accountID, nsID, key)
	if state != KVFound {
		return "", false
	}
	return raw, true
}

// SetKVValue 写 KV 值（text/plain）。
func (c *Client) SetKVValue(ctx context.Context, accountID, nsID, key, value string) error {
	p := fmt.Sprintf("/accounts/%s/storage/kv/namespaces/%s/values/%s",
		accountID, nsID, url.PathEscape(key))
	req, err := http.NewRequestWithContext(ctx, http.MethodPut,
		c.apiBase+p, strings.NewReader(value))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "text/plain")

	res, err := c.httpC.Do(req)
	if err != nil {
		return wrapNetErr(err)
	}
	defer func() { _ = res.Body.Close() }()

	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return wrapNetErr(err)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return parseAPIError(res.StatusCode, raw)
	}
	return nil
}

// ---------- Pages ----------

// PagesProject 是 Pages 项目。
type PagesProject struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Subdomain        string   `json:"subdomain"`
	Domains          []string `json:"domains"`
	ProductionBranch string   `json:"production_branch"`
	CreatedOn        string   `json:"created_on"`
	// DeploymentConfigs 里带 production.env_vars，用于核对 DATA_HOST 是否过期
	DeploymentConfigs PagesDeployConfigs `json:"deployment_configs"`
}

// PagesDeployConfigs 是 Pages 部署配置。
type PagesDeployConfigs struct {
	Production PagesEnvConfig `json:"production"`
}

// PagesEnvConfig 是某个环境的配置。
type PagesEnvConfig struct {
	EnvVars map[string]PageVar `json:"env_vars"`
}

// PagesDeployment 是 Pages 部署记录。
type PagesDeployment struct {
	ID          string `json:"id"`
	ShortID     string `json:"short_id"`
	URL         string `json:"url"`
	Environment string `json:"environment"`
	CreatedOn   string `json:"created_on"`
	// LatestStage 是部署阶段对象，只取 status 字段
	LatestStage StageStatus `json:"latest_stage"`
}

// StageStatus 是部署阶段状态。
type StageStatus struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

// PagesDomain 是 Pages 项目的自定义域名。
type PagesDomain struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

// GetPagesProject 取单个项目；不存在时返回 (nil, nil)。
func (c *Client) GetPagesProject(ctx context.Context, accountID, name string) (*PagesProject, error) {
	var out PagesProject
	err := c.doJSON(ctx, http.MethodGet,
		fmt.Sprintf("/accounts/%s/pages/projects/%s", accountID, url.PathEscape(name)), nil, &out)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.IsNotFound() {
			return nil, nil
		}
		return nil, err
	}
	return &out, nil
}

// ListPagesProjects 列出全部 Pages 项目。
//
// ⚠️ 不要加 `?per_page=` —— Pages 接口不吃这个参数，会返回
// 400 "Invalid list options provided. Review the `page` or `per_page` parameter."
// （code 8000024）。这是真机实测踩到的坑，mock 测试测不出来。
func (c *Client) ListPagesProjects(ctx context.Context, accountID string) ([]PagesProject, error) {
	var out []PagesProject
	if err := c.doJSON(ctx, http.MethodGet,
		fmt.Sprintf("/accounts/%s/pages/projects", accountID), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CreatePagesProject 创建 Pages 项目。
func (c *Client) CreatePagesProject(ctx context.Context, accountID, name, productionBranch string) (*PagesProject, error) {
	if productionBranch == "" {
		productionBranch = "main"
	}
	var out PagesProject
	if err := c.doJSON(ctx, http.MethodPost,
		fmt.Sprintf("/accounts/%s/pages/projects", accountID),
		map[string]any{
			"name":              name,
			"production_branch": productionBranch,
		}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeletePagesProject 删除 Pages 项目。
func (c *Client) DeletePagesProject(ctx context.Context, accountID, name string) error {
	return c.doJSON(ctx, http.MethodDelete,
		fmt.Sprintf("/accounts/%s/pages/projects/%s", accountID, url.PathEscape(name)), nil, nil)
}

// UpdatePagesEnv 设置 Pages 项目的环境变量（production）。
//
// ⚠️ 调用它会**自动触发一次部署**。之后再 POST /deployments 就是二次部署，
// 会触发 8000119。所以顺序必须是「建项目 → 设变量 → 部署」，
// 且设变量后不要再单独触发部署。
func (c *Client) UpdatePagesEnv(ctx context.Context, accountID, name string, vars map[string]PageVar) error {
	type payload struct {
		DeploymentConfigs struct {
			Production struct {
				EnvVars map[string]PageVar `json:"env_vars"`
			} `json:"production"`
		} `json:"deployment_configs"`
	}
	var p payload
	p.DeploymentConfigs.Production.EnvVars = vars
	return c.doJSON(ctx, http.MethodPatch,
		fmt.Sprintf("/accounts/%s/pages/projects/%s", accountID, url.PathEscape(name)), &p, nil)
}

// BindPagesKV 给 Pages 项目绑定 KV 命名空间。
//
// bindings 的键是**绑定名**，值是命名空间 ID。
// CFPilot 需要绑两个名字：`KV`（自研内核读）与 `K`（兼容部分旧版实现）。
// 少绑一个就会有一侧读不到配置。
func (c *Client) BindPagesKV(ctx context.Context, accountID, name string, bindings map[string]string) error {
	type kvBinding struct {
		NamespaceID string `json:"namespace_id"`
	}
	type payload struct {
		DeploymentConfigs struct {
			Production struct {
				KVNamespaces map[string]kvBinding `json:"kv_namespaces"`
			} `json:"production"`
		} `json:"deployment_configs"`
	}
	var p payload
	p.DeploymentConfigs.Production.KVNamespaces = make(map[string]kvBinding, len(bindings))
	for k, v := range bindings {
		p.DeploymentConfigs.Production.KVNamespaces[k] = kvBinding{NamespaceID: v}
	}
	return c.doJSON(ctx, http.MethodPatch,
		fmt.Sprintf("/accounts/%s/pages/projects/%s", accountID, url.PathEscape(name)), &p, nil)
}

// PageVar 是 Pages 环境变量。
type PageVar struct {
	Value string `json:"value"`
	Type  string `json:"type"` // "plain_text" 或 "secret_text"
}

// PagesDeployOptions 是部署参数。
type PagesDeployOptions struct {
	AccountID string
	Project   string
	// Script 是 _worker.js 的内容
	Script []byte
	// CommitMessage 是部署备注
	CommitMessage string
	// Branch 是分支名（默认 main）
	Branch string
}

// DeployPagesWorker 上传 _worker.js 完成一次部署。
//
// ⚠️ metadata 里**不能带 compatibility_date**。Pages Advanced Mode 与
// Workers 的 metadata 结构不同，多带会让 Pages 忽略 _worker.js，
// 表现为「部署成功、HTTP 200，但返回默认 Welcome 页」。
// 正确的 metadata 只有 { main_module: "_worker.js", bindings: {} }。
func (c *Client) DeployPagesWorker(ctx context.Context, opts PagesDeployOptions) (*PagesDeployment, error) {
	// ================================================================
	// ⚠️ Pages 部署 API 的表单结构
	//
	// 早期实现直接发 `_worker.js` + `metadata` 两个顶层字段，
	// **100% 失败**。真实错误是：
	//
	//     code 8000096
	//     "A \"manifest\" field was expected in the request body but was not provided."
	//
	// 而这个错误在部署流程里被误判成 8000119（风控），
	// 导致「反复换名重试 + 堆积孤儿项目」，且部署永远不成功。
	//
	// 正确的结构（对照 Electron 版 cf-api.ts 的 deployPagesWorker）：
	//
	//   外层 multipart：
	//     branch         = "main"
	//     manifest       = "{}"                 ← 必须有！
	//     _worker.bundle = 内层 multipart 的原始字节
	//
	//   内层 multipart（_worker.bundle 的内容）：
	//     metadata   = {"main_module":"_worker.js","bindings":{}}
	//     _worker.js = 脚本内容
	// ================================================================

	// ---- 内层：构建 _worker.bundle ----
	innerMeta := map[string]any{
		"main_module": "_worker.js",
		"bindings":    map[string]any{},
	}
	innerMetaRaw, err := json.Marshal(innerMeta)
	if err != nil {
		return nil, err
	}

	var innerBuf bytes.Buffer
	innerW := multipart.NewWriter(&innerBuf)

	metaHeader := make(textproto.MIMEHeader)
	metaHeader.Set("Content-Disposition", `form-data; name="metadata"; filename="metadata.json"`)
	metaHeader.Set("Content-Type", "application/json")
	metaPart, err := innerW.CreatePart(metaHeader)
	if err != nil {
		return nil, err
	}
	if _, err := metaPart.Write(innerMetaRaw); err != nil {
		return nil, err
	}

	scriptHeader := make(textproto.MIMEHeader)
	scriptHeader.Set("Content-Disposition", `form-data; name="_worker.js"; filename="_worker.js"`)
	scriptHeader.Set("Content-Type", "application/javascript+module")
	scriptPart, err := innerW.CreatePart(scriptHeader)
	if err != nil {
		return nil, err
	}
	if _, err := scriptPart.Write(opts.Script); err != nil {
		return nil, err
	}
	if err := innerW.Close(); err != nil {
		return nil, err
	}

	// ---- 外层：branch + manifest + _worker.bundle ----
	branch := opts.Branch
	if branch == "" {
		branch = "main"
	}

	var outerBuf bytes.Buffer
	outerW := multipart.NewWriter(&outerBuf)

	if err := outerW.WriteField("branch", branch); err != nil {
		return nil, err
	}
	// ⚠️ manifest 是必需字段，缺了直接 8000096
	if err := outerW.WriteField("manifest", "{}"); err != nil {
		return nil, err
	}

	bundleHeader := make(textproto.MIMEHeader)
	bundleHeader.Set("Content-Disposition", `form-data; name="_worker.bundle"; filename="_worker.bundle"`)
	bundleHeader.Set("Content-Type", innerW.FormDataContentType())
	bundlePart, err := outerW.CreatePart(bundleHeader)
	if err != nil {
		return nil, err
	}
	if _, err := bundlePart.Write(innerBuf.Bytes()); err != nil {
		return nil, err
	}
	if err := outerW.Close(); err != nil {
		return nil, err
	}

	// ---- 发送 ----
	path := fmt.Sprintf("/accounts/%s/pages/projects/%s/deployments",
		opts.AccountID, url.PathEscape(opts.Project))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiBase+path, &outerBuf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", outerW.FormDataContentType())

	res, err := c.httpC.Do(req)
	if err != nil {
		return nil, wrapNetErr(err)
	}
	defer func() { _ = res.Body.Close() }()

	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, wrapNetErr(err)
	}
	result, err := readResponse(res.StatusCode, raw)
	if err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return &PagesDeployment{}, nil
	}
	var out PagesDeployment
	if err := json.Unmarshal(result, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListPagesDeployments 列出部署记录。
func (c *Client) ListPagesDeployments(ctx context.Context, accountID, name string) ([]PagesDeployment, error) {
	var out []PagesDeployment
	if err := c.doJSON(ctx, http.MethodGet,
		fmt.Sprintf("/accounts/%s/pages/projects/%s/deployments?per_page=5",
			accountID, url.PathEscape(name)), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListPagesDomains 列出项目的自定义域名。
//
// ⚠️ 必须用 /domains 子接口，不能用 project.domains ——
// 后者只列 active 域名，正在 initializing 的域名看不到，
// 会导致迁移时误判「没有域名要迁」。
func (c *Client) ListPagesDomains(ctx context.Context, accountID, name string) ([]PagesDomain, error) {
	var out []PagesDomain
	if err := c.doJSON(ctx, http.MethodGet,
		fmt.Sprintf("/accounts/%s/pages/projects/%s/domains", accountID, url.PathEscape(name)),
		nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AddPagesDomain 绑定自定义域名。
func (c *Client) AddPagesDomain(ctx context.Context, accountID, name, domain string) error {
	return c.doJSON(ctx, http.MethodPost,
		fmt.Sprintf("/accounts/%s/pages/projects/%s/domains", accountID, url.PathEscape(name)),
		map[string]string{"name": domain}, nil)
}

// RemovePagesDomain 解绑自定义域名。
func (c *Client) RemovePagesDomain(ctx context.Context, accountID, name, domain string) error {
	return c.doJSON(ctx, http.MethodDelete,
		fmt.Sprintf("/accounts/%s/pages/projects/%s/domains/%s",
			accountID, url.PathEscape(name), url.PathEscape(domain)), nil, nil)
}

// ================================================================
// Workers（数据面）
// ================================================================

// Zone 是账号下的一个 DNS 托管域。
type Zone struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// WorkerDomain 是 Worker 的自定义域名绑定。
type WorkerDomain struct {
	ID       string `json:"id"`
	Hostname string `json:"hostname"`
	Service  string `json:"service"`
	ZoneID   string `json:"zone_id"`
	ZoneName string `json:"zone_name"`
	Enabled  bool   `json:"enabled"`
}

// WorkerBinding 是脚本绑定（KV / 明文变量）。
//
// 用 map 序列化而不是结构体：不同类型绑定字段不同
// （kv_namespace 要 namespace_id，plain_text 要 text），
// 结构体加 omitempty 很容易漏字段，直接构造 map 更不容易错。
type WorkerBinding map[string]any

// ListZones 列出账号下的全部 zone（绑定 Workers 自定义域名时要用 zone_id）。
func (c *Client) ListZones(ctx context.Context) ([]Zone, error) {
	var out []Zone
	if err := c.doJSON(ctx, http.MethodGet, "/zones?per_page=50", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UploadWorkerScript 上传（或更新）一个 ES module 形式的 Worker 脚本。
//
// ⚠️ metadata 段必须是 `application/json`，模块段必须是
// `application/javascript+module` —— 用 CreateFormFile 会把两段都写成
// application/octet-stream，Cloudflare 会当成「没有 main_module」而拒绝。
func (c *Client) UploadWorkerScript(
	ctx context.Context,
	accountID, scriptName string,
	code []byte,
	bindings []WorkerBinding,
	compatibilityDate string,
) error {
	metadata, err := json.Marshal(map[string]any{
		"main_module":        "worker.js",
		"compatibility_date": compatibilityDate,
		"bindings":           bindings,
	})
	if err != nil {
		return err
	}

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)

	metaHeader := make(textproto.MIMEHeader)
	metaHeader.Set("Content-Disposition", `form-data; name="metadata"; filename="metadata.json"`)
	metaHeader.Set("Content-Type", "application/json")
	metaPart, err := w.CreatePart(metaHeader)
	if err != nil {
		return err
	}
	if _, err := metaPart.Write(metadata); err != nil {
		return err
	}

	modHeader := make(textproto.MIMEHeader)
	modHeader.Set("Content-Disposition", `form-data; name="worker.js"; filename="worker.js"`)
	modHeader.Set("Content-Type", "application/javascript+module")
	modPart, err := w.CreatePart(modHeader)
	if err != nil {
		return err
	}
	if _, err := modPart.Write(code); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut,
		c.apiBase+fmt.Sprintf("/accounts/%s/workers/scripts/%s", accountID, url.PathEscape(scriptName)),
		&buf)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", w.FormDataContentType())

	res, err := c.httpC.Do(req)
	if err != nil {
		return wrapNetErr(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return wrapNetErr(err)
	}
	_, err = readResponse(res.StatusCode, raw)
	return err
}

// DeleteWorkerScript 删除 Worker 脚本。
func (c *Client) DeleteWorkerScript(ctx context.Context, accountID, scriptName string) error {
	return c.doJSON(ctx, http.MethodDelete,
		fmt.Sprintf("/accounts/%s/workers/scripts/%s", accountID, url.PathEscape(scriptName)), nil, nil)
}

// GetWorkersSubdomain 返回账号的 workers.dev 子域（未注册时为空串）。
func (c *Client) GetWorkersSubdomain(ctx context.Context, accountID string) (string, error) {
	var out struct {
		Subdomain string `json:"subdomain"`
	}
	if err := c.doJSON(ctx, http.MethodGet,
		fmt.Sprintf("/accounts/%s/workers/subdomain", accountID), nil, &out); err != nil {
		return "", err
	}
	return out.Subdomain, nil
}

// PutScriptSubdomain 开启 / 关闭脚本的 workers.dev 路由。
//
// 上传成功后该路由默认是关闭的，必须显式开启，
// 否则 https://<name>.<sub>.workers.dev 一直返回「There is nothing here yet」。
func (c *Client) PutScriptSubdomain(ctx context.Context, accountID, scriptName string, enabled bool) error {
	return c.doJSON(ctx, http.MethodPost,
		fmt.Sprintf("/accounts/%s/workers/scripts/%s/subdomain", accountID, url.PathEscape(scriptName)),
		map[string]bool{"enabled": enabled}, nil)
}

// ListWorkerDomains 列出账号下全部 Worker 自定义域名绑定。
func (c *Client) ListWorkerDomains(ctx context.Context, accountID string) ([]WorkerDomain, error) {
	var out []WorkerDomain
	if err := c.doJSON(ctx, http.MethodGet,
		fmt.Sprintf("/accounts/%s/workers/domains", accountID), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AttachWorkerDomain 绑定 Worker 自定义域名。
//
// ⚠️ 返回 200 只代表「已受理」：证书签发要 1~3 分钟，
// 期间访问会 TLS 失败，调用方必须再探一次可达性。
func (c *Client) AttachWorkerDomain(
	ctx context.Context, accountID, hostname, service, zoneID string,
) (*WorkerDomain, error) {
	var out WorkerDomain
	body := map[string]string{
		"hostname":    hostname,
		"service":     service,
		"zone_id":     zoneID,
		"environment": "production",
	}
	if err := c.doJSON(ctx, http.MethodPut,
		fmt.Sprintf("/accounts/%s/workers/domains", accountID), body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteWorkerDomain 解除自定义域名绑定。
func (c *Client) DeleteWorkerDomain(ctx context.Context, accountID, domainID string) error {
	return c.doJSON(ctx, http.MethodDelete,
		fmt.Sprintf("/accounts/%s/workers/domains/%s", accountID, url.PathEscape(domainID)), nil, nil)
}

// ListScripts 列出账号下的 Worker 脚本（仅用于权限预检）。
func (c *Client) ListScripts(ctx context.Context, accountID string) ([]string, error) {
	var out []struct {
		ID string `json:"id"`
	}
	if err := c.doJSON(ctx, http.MethodGet,
		fmt.Sprintf("/accounts/%s/workers/scripts", accountID), nil, &out); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(out))
	for _, s := range out {
		names = append(names, s.ID)
	}
	return names, nil
}

// ListDNSRecords 读 zone 下的 DNS 记录（仅用于权限预检）。
//
// 绑定 Worker 自定义域名时 Cloudflare 会自动建一条 DNS 记录，
// 因此令牌必须有 Zone / DNS / Edit；用读接口做代理探测，
// 403 基本等价于「写也写不了」。
func (c *Client) ListDNSRecords(ctx context.Context, zoneID, name string) (int, error) {
	path := fmt.Sprintf("/zones/%s/dns_records?per_page=1", url.PathEscape(zoneID))
	if name != "" {
		path += "&name=" + url.QueryEscape(name)
	}
	var out []map[string]any
	if err := c.doJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return 0, err
	}
	return len(out), nil
}
