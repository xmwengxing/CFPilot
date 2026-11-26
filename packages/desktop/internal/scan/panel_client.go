package scan

// 访问面板域名（控制面）时的 HTTP 客户端与「直连失败自动走代理」策略。
//
// ## 为什么需要这一层
//
// 真机故障（2026-11-25，双 Pages 部署）：
//
//	覆盖回填失败：Post "https://etmanager.pages.dev/api/v1/preferred-ips":
//	  net/http: TLS handshake timeout
//
// 面板域名是 `*.pages.dev`，该域名在部分网络下**直连会被阻断**（TLS 握手超时）。
// 用户此时通常开着代理，但桌面版拿不到：
//
//   - Go 的 net/http 只认 HTTP_PROXY / HTTPS_PROXY **环境变量**；
//   - 绝大多数客户端装的是 **Windows 系统代理**（改注册表，不设环境变量）；
//   - 桌面版是 GUI 启动，继承不到用户 shell 里的环境变量。
//
// 与「访问 GitHub 超时」是同一个根因（见 internal/proxy 的说明）。
//
// ## 策略：先直连，失败再用**用户明确配置过的**代理重试一次
//
// 不做「一律走代理」：绝大多数用户的直连是通的，多一次代理握手只是变慢；
// 而代理配置坏掉时会让原本正常的回填一起失败。
// 所以只在**直连在网络层就失败**时重试 —— HTTP 4xx/5xx（说明已经连上了）不重试。
//
// ⚠️ 代理来源只认「明确的」两档：环境变量、Windows 系统代理。
// 不猜本机常见端口（那是给 GitHub 下载用的启发式，见 proxy.ResolveExplicit）。
// 靠猜端口意味着「端口不是常见值就用不上」，猜中也可能撞上别的程序，
// 而回填是写操作，猜错只会让失败原因更难理解。
// 走了代理时会把来源写进结果（`Proxy` 字段），界面日志里能看到到底用的是什么。

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/proxy"
)

// directClient 返回访问面板域名的直连客户端。
//
// 克隆默认 Transport 而不是新建：默认 Transport 带着连接池、HTTP/2、
// Expect: 100-continue 处理等设定，自建会丢掉它们。
// 只改一处：TLS 握手上限（缩短，给代理重试留时间）。
func directClient(timeout time.Duration) *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = http.ProxyFromEnvironment
	t.TLSHandshakeTimeout = 8 * time.Second
	// ⚠️ 不要设 ForceAttemptHTTP2=false
	//
	// 真机实测：强制 h1 后，部分 CF 边缘节点的回填请求会收到
	// `malformed HTTP response`（内容是 HTTP/2 的 SETTINGS 帧）——
	// 服务端按 h2 回了响应，客户端却在用 h1 解析。
	// 保持默认（交给 http2 自动协商）最稳。
	return &http.Client{Timeout: timeout, Transport: t}
}

// msgNoSystemProxy 表示「本机没有明确配置过的代理」——
// 这不是失败原因，而是「没有第二条通路可用」，调用方应保留直连的原始错误。
const msgNoSystemProxy = "没有配置代理（HTTP_PROXY / 系统代理都未开启）"

// proxyResolver 是「解析明确的代理」的钩子，测试可替换。
var proxyResolver = proxy.ResolveExplicit

// proxyClient 返回走代理的客户端与来源说明（无代理可用时两个都为零值）。
func proxyClient(timeout time.Duration) (*http.Client, string) {
	r := proxyResolver()
	if r.URL == nil {
		return nil, ""
	}
	c := r.Client(timeout)
	if t, ok := c.Transport.(*http.Transport); ok {
		t.TLSHandshakeTimeout = 12 * time.Second
	}
	return c, r.Source
}

// shouldRetryViaProxy 判断「值不值得用代理重试一次」。
//
// 只有网络层失败才重试：DNS 解析不了、TCP 连不上、TLS 握手超时、连接被重置、
// 读到 EOF。HTTP 状态码非 2xx 说明**已经连上了**（服务端明确回了话），
// 换代理只会得到同样的答复。
func shouldRetryViaProxy(ctx context.Context, err error) bool {
	if err == nil {
		return false
	}
	// 用户取消 / 上层超时：重试没有意义，反而拖长等待
	if errors.Is(err, context.Canceled) || ctx.Err() != nil {
		return false
	}
	// 任何网络错误都算；这里不细分类别 —— DNS 失败也该让代理再试一次
	// （代理侧会自己解析域名）。
	return true
}

// tokenClient 返回「取面板令牌」用的客户端与来源说明。
//
// 与回填的差别：它必须**手动管理 Cookie 且不自动跟随重定向**
// （Pages 的某些路径会 301 到带斜杠版本，跟随会丢掉 Cookie 头），
// 所以 CheckRedirect 在这里统一装上，两条通路（直连 / 代理）共用。
func tokenClient(timeout time.Duration, viaProxy bool) (*http.Client, string) {
	var c *http.Client
	src := ""
	if viaProxy {
		c, src = proxyClient(timeout)
		if c == nil {
			return nil, ""
		}
	} else {
		c = directClient(timeout)
	}
	// 关键：不自动跟随重定向，否则 Cookie 头会被重置
	c.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return fmt.Errorf("重定向次数过多")
		}
		// 保持原请求的 Cookie 头
		if len(via) > 0 {
			if ck := via[0].Header.Get("Cookie"); ck != "" {
				req.Header.Set("Cookie", ck)
			}
		}
		return nil
	}
	return c, src
}
