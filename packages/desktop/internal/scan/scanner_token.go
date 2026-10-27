package scan

// 自动获取面板的一次性扫描令牌。
//
// ## 为什么需要
//
// 「回填优选结果到面板」需要 `Bearer` 令牌。令牌从面板的
// `POST /api/v1/scanner-token` 拿，而那个接口要求**面板会话**。
//
// 桌面版本来就保存着面板密码（部署清单 / 账户里都有），
// 所以可以自动完成「登录 → 取令牌」，用户不用手动去面板点。
//
// ## 流程（对照 worker-core/src/api.ts）
//
//	1. POST https://<控制面域名>/api/v1/login   {"password":"..."}
//	   → 200 + Set-Cookie: <session>
//	2. POST https://<控制面域名>/api/v1/scanner-token   (带 Cookie)
//	   → {"ok":true,"token":"...","expiresIn":600}
//
// 令牌有效期 10 分钟，够一次优选回填。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// TokenResult 是获取扫描令牌的结果。
type TokenResult struct {
	OK     bool
	Token  string
	Error  string
	Status int
}

// FetchScannerToken 用面板密码登录并获取一次性扫描令牌。
//
// baseURL 是控制面地址（如 `https://cpmanager.pages.dev`）。
// password 是面板密码。
func FetchScannerToken(ctx context.Context, baseURL, password string, timeout time.Duration) TokenResult {
	baseURL = strings.TrimSpace(baseURL)
	password = strings.TrimSpace(password)
	if baseURL == "" {
		return TokenResult{Error: "缺少控制面地址"}
	}
	if password == "" {
		return TokenResult{Error: "缺少面板密码"}
	}
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if !strings.HasPrefix(baseURL, "http://") && !strings.HasPrefix(baseURL, "https://") {
		baseURL = "https://" + baseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")

	// ⚠️ 不用 cookiejar，改为**手动提取并回传** Cookie
	//
	// 真机报错：「令牌响应解析失败：<!DOCTYPE html>...<title>Welcome</title>」
	//
	// 根因：面板的 Set-Cookie 带 `Secure; HttpOnly; SameSite=Strict`，
	// 而 Go 的 net/http/cookiejar 的存储/回传规则在 Pages 的
	// 多级子域 + 重定向下会**丢掉这个 Cookie**，导致第二步请求裸奔，
	// 服务端把它当未登录，返回 Pages 的默认 Welcome 页（纯 HTML），
	// JSON 解析自然失败。
	//
	// 手动处理最可靠：登录成功后从响应头里把 cookie 抓出来，
	// 原样放进第二步请求的 Cookie 头。
	client := &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			MaxIdleConnsPerHost: 4,
			IdleConnTimeout:     30 * time.Second,
			TLSHandshakeTimeout: 15 * time.Second,
			ForceAttemptHTTP2:   false,
			// 不自动跟随重定向：Pages 的某些路径会 301 到带斜杠的版本，
			// 跟随会丢掉我们手动设置的 Cookie 头
			DisableKeepAlives: false,
		},
		// 关键：不自动跟随重定向，否则 Cookie 头会被重置
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return fmt.Errorf("重定向次数过多")
			}
			// 保持原请求的 Cookie 头
			if len(via) > 0 {
				if c := via[0].Header.Get("Cookie"); c != "" {
					req.Header.Set("Cookie", c)
				}
			}
			return nil
		},
	}

	// ---- 1. 登录 ----
	loginBody, _ := json.Marshal(map[string]string{"password": password})
	loginReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		baseURL+"/api/v1/login", bytes.NewReader(loginBody))
	if err != nil {
		return TokenResult{Error: err.Error()}
	}
	loginReq.Header.Set("Content-Type", "application/json")

	loginRes, err := client.Do(loginReq)
	if err != nil {
		return TokenResult{Error: "登录请求失败：" + err.Error()}
	}
	loginRaw, _ := io.ReadAll(io.LimitReader(loginRes.Body, 4096))
	_ = loginRes.Body.Close()

	// ---- 先判断登录是否成功（顺序很重要）----
	//
	// ⚠️ 状态码检查必须在 Cookie 检查**之前**
	//
	// 早期把 Cookie 检查放在前面，于是密码错误（401，无 Cookie）时
	// 报的是「登录成功但服务端没有下发会话 Cookie」——
	// 完全误导用户：明明是密码不对，却说登录成功了。
	if loginRes.StatusCode == http.StatusUnauthorized {
		return TokenResult{Status: 401, Error: "面板密码不正确，请先在部署页确认密码"}
	}
	// 登录响应必须是 JSON（HTML 说明请求打到了非面板路由）
	if t := bytes.TrimSpace(loginRaw); len(t) > 0 && t[0] == '<' {
		return TokenResult{
			Status: loginRes.StatusCode,
			Error: "登录接口返回了网页而不是 JSON。\n" +
				"  请确认「自动识别域名」填的是**控制面**地址（如 cpmanager.pages.dev），\n" +
				"  而不是数据面（cpdata）或自定义域名。",
		}
	}
	if loginRes.StatusCode < 200 || loginRes.StatusCode >= 300 {
		return TokenResult{
			Status: loginRes.StatusCode,
			Error:  fmt.Sprintf("登录失败 HTTP %d %s", loginRes.StatusCode, brief(loginRaw)),
		}
	}

	// ---- 提取会话 Cookie ----
	// 手动提取（不依赖 cookiejar，见上方注释）
	var cookieParts []string
	for _, c := range loginRes.Cookies() {
		cookieParts = append(cookieParts, c.Name+"="+c.Value)
	}
	cookieHeader := strings.Join(cookieParts, "; ")
	if cookieHeader == "" {
		// 登录返回 2xx 却没给 Cookie：面板版本不匹配
		return TokenResult{
			Status: loginRes.StatusCode,
			Error:  "登录成功但服务端没有下发会话 Cookie（面板版本可能不匹配）",
		}
	}

	// ---- 2. 取令牌 ----
	tokenReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		baseURL+"/api/v1/scanner-token", nil)
	if err != nil {
		return TokenResult{Error: err.Error()}
	}
	tokenReq.Header.Set("Cookie", cookieHeader)
	tokenRes, err := client.Do(tokenReq)
	if err != nil {
		return TokenResult{Error: "获取令牌请求失败：" + err.Error()}
	}
	tokenRaw, _ := io.ReadAll(io.LimitReader(tokenRes.Body, 4096))
	_ = tokenRes.Body.Close()

	if tokenRes.StatusCode < 200 || tokenRes.StatusCode >= 300 {
		return TokenResult{
			Status: tokenRes.StatusCode,
			Error:  fmt.Sprintf("获取令牌失败 HTTP %d %s", tokenRes.StatusCode, brief(tokenRaw)),
		}
	}

	// ⚠️ 响应必须是 JSON。若拿到 HTML（典型是 Pages 的 Welcome 页），
	// 说明会话没生效 —— 直接给出可操作的提示，不要把整页 HTML 丢给用户。
	trimmed := bytes.TrimSpace(tokenRaw)
	if len(trimmed) > 0 && trimmed[0] == '<' {
		return TokenResult{
			Status: tokenRes.StatusCode,
			Error: "面板返回了网页而不是接口数据（会话未生效）。\n" +
				"  常见原因：面板密码不对，或该域名指向的不是本项目的控制面。\n" +
				"  请确认「自动识别域名」填的是控制面地址（cpmanager 那一个）。",
		}
	}

	var parsed struct {
		OK    bool   `json:"ok"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(trimmed, &parsed); err != nil {
		return TokenResult{Error: "令牌响应解析失败：" + brief(tokenRaw)}
	}
	if parsed.Token == "" {
		return TokenResult{Error: "面板没有返回令牌：" + brief(tokenRaw)}
	}
	return TokenResult{OK: true, Token: parsed.Token, Status: tokenRes.StatusCode}
}

// brief 把响应体压成一行简短文本（用于错误信息）。
func brief(raw []byte) string {
	s := strings.TrimSpace(string(raw))
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 160 {
		s = s[:160] + "…"
	}
	return s
}
