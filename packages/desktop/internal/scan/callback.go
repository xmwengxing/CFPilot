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
	// Proxy 是本次实际使用的代理来源（空 = 直连）。
	//
	// 为什么要带出来：用户「明明开了代理」却出问题时，
	// 只有这条信息能说明我们到底有没有用上它、用的是哪一个。
	Proxy string
}

// PostResults 把优选结果 POST 回面板。
//
// entries 是「可复制」格式的行（`IP:Port#IPv4_SJC圣何塞_12_35.5`），与 CLI 一致。
//
// mode 是写入方式：
//
//	replace  （默认）清空面板优选池后写入
//	append            保留池里已有的 IP，只补真正新的（「增量回填」）
//
// 空串按 replace 处理 —— 历史调用方不传时行为完全不变。
// PushTarget 回填的目标池。
//
//	TargetLocal —— 本地优选池（订阅的 L1 来源）
//	TargetRelay —— 自定义反代入口池（反代优选的产出；只影响出站选路，不进订阅）
type PushTarget string

const (
	TargetLocal PushTarget = "local"
	TargetRelay PushTarget = "relay"
)

func PostResults(ctx context.Context, callbackURL, token string, entries []string, mode string, timeout time.Duration) CallbackResult {
	return PostResultsTo(ctx, callbackURL, token, entries, mode, TargetLocal, timeout)
}

// PostResultsTo 回填到指定的目标池。
//
// 直连失败（网络层）时自动用「已配置的代理」重试一次 —— 面板域名常是 `*.pages.dev`，
// 它在部分网络直连会被阻断（TLS 握手超时）。见 panel_client.go。
func PostResultsTo(ctx context.Context, callbackURL, token string, entries []string, mode string, target PushTarget, timeout time.Duration) CallbackResult {
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	if mode != "append" {
		mode = "replace"
	}
	if target != TargetRelay {
		target = TargetLocal
	}

	body, err := json.Marshal(map[string]any{"ips": entries, "mode": mode, "target": string(target)})
	if err != nil {
		return CallbackResult{Error: err.Error()}
	}

	res, netErr := postResultsOnce(ctx, callbackURL, token, body, timeout, false)
	if netErr == nil || !shouldRetryViaProxy(ctx, netErr) {
		return res
	}
	// 直连在网络层就失败了（典型：TLS handshake timeout）→ 换已配置的代理再来一次
	retry, retryErr := postResultsOnce(ctx, callbackURL, token, body, timeout, true)
	if retry.Error == msgNoSystemProxy {
		// 没有代理可试 —— 报直连的真实原因，别让用户以为是代理的问题
		return res
	}
	if retryErr == nil {
		return retry
	}
	return CallbackResult{Error: netErr.Error() + "（已尝试经代理重试，仍未成功：" + retryErr.Error() + "）"}
}

// postResultsOnce 发一次回填请求。viaProxy 为 true 时走已配置的代理。
//
// 返回的第二个值是**网络层错误**（nil 表示拿到了服务端答复，
// 无论状态码是多少都算答复）—— 调用方据此决定要不要换通路重试。
func postResultsOnce(ctx context.Context, callbackURL, token string, body []byte, timeout time.Duration, viaProxy bool) (result CallbackResult, netErr error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	client := directClient(timeout)
	src := ""
	if viaProxy {
		client, src = proxyClient(timeout)
		if client == nil {
			return CallbackResult{Error: msgNoSystemProxy}, nil
		}
	}
	// 无论成功还是失败，都把「这次走了什么通路」带回去。
	defer func() { result.Proxy = src }()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, callbackURL, bytes.NewReader(body))
	if err != nil {
		return CallbackResult{Error: err.Error()}, nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", "CFPilot-Desktop/1.0")

	res, err := client.Do(req)
	if err != nil {
		return CallbackResult{Error: err.Error()}, err
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
		return CallbackResult{Status: res.StatusCode, Error: msg}, nil
	}
	return CallbackResult{OK: true, Status: res.StatusCode}, nil
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
