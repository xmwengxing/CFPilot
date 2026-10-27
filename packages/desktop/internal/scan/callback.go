package scan

// 优选结果回填到面板。
//
// ## 为什么需要
//
// 界面上的「不回填面板，只输出列表」勾选框在 Go 版**完全没有接线** ——
// 勾选状态被读取的地方根本不存在，也就是说无论勾不勾，行为都一样。
//
// 用户实测：「取消勾选后点开始优选，勾选又被自动勾上，无法测试回填」。
// 真实原因是：回填功能压根没实现，界面渲染时又重新渲染了默认值。
//
// ## 契约（与 scanner-cli 的 callback.ts 对齐）
//
//	POST https://<host>/api/v1/preferred-ips
//	Authorization: Bearer <token>
//	Content-Type: application/json
//	{"ips": ["1.2.3.4:443#LAX", ...]}
//
// token 来自面板生成的**一次性扫描令牌**，或内核环境变量 SCANNER_TOKEN。

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

// CallbackResult 是回填结果。
type CallbackResult struct {
	OK     bool
	Status int
	Error  string
}

// PostResults 把优选结果 POST 回面板。
//
// entries 是「可复制」格式的行（`IP:Port#COLO`），与 scanner-cli 一致。
func PostResults(ctx context.Context, callbackURL, token string, entries []string, timeout time.Duration) CallbackResult {
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	body, err := json.Marshal(map[string]any{"ips": entries})
	if err != nil {
		return CallbackResult{Error: err.Error()}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, callbackURL, bytes.NewReader(body))
	if err != nil {
		return CallbackResult{Error: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", "CFPilot-Desktop/1.0")

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return CallbackResult{Error: err.Error()}
	}
	defer func() { _ = res.Body.Close() }()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		msg := strings.TrimSpace(string(raw))
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", res.StatusCode)
		} else {
			msg = fmt.Sprintf("HTTP %d %s", res.StatusCode, msg)
		}
		return CallbackResult{Status: res.StatusCode, Error: msg}
	}
	return CallbackResult{OK: true, Status: res.StatusCode}
}

// DefaultCallbackURL 由数据面/控制面域名推导回填地址。
//
// 与 scanner-cli 的默认值一致：`https://<host>/api/v1/preferred-ips`
func DefaultCallbackURL(host string) string {
	host = strings.TrimSpace(host)
	if host == "" {
		return ""
	}
	if !strings.HasPrefix(host, "http://") && !strings.HasPrefix(host, "https://") {
		host = "https://" + host
	}
	host = strings.TrimRight(host, "/")
	return host + "/api/v1/preferred-ips"
}
