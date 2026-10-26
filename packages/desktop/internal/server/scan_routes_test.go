package server

// 优选 API 的测试。
//
// 重点验证：
//   - 缺域名时给出可操作的提示（而不是启动一个注定失败的扫描）
//   - 自定义候选的清洗（粘 1000 行只认出 3 个是常见坑）
//   - pages.dev 域名规范化（曾经的 `a.pages.dev.pages.dev` 事故）
//   - 端口探测与地区列表

import (
	"net/http"
	"strings"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

// 缺域名必须 400，且提示能指导用户。
func TestScanRunRequiresHost(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/scan/run", cookie, map[string]any{
		"sample": 10,
	})
	if code != http.StatusBadRequest {
		t.Fatalf("缺域名应 400，实际 %d (%v)", code, body)
	}
	if !strings.Contains(str(body["error"]), "域名") {
		t.Errorf("错误信息应提到域名，实际 %v", body["error"])
	}
}

// 带协议前缀的域名要能自动清洗掉。
func TestScanRunStripsScheme(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	// 只验证接口接受并启动了任务（不等扫描完成）
	code, body := postJSON(t, base+"/api/scan/run", cookie, map[string]any{
		"host":       "https://cf.example.com/",
		"candidates": "127.0.0.1",
		"port":       1,
		"top":        5,
	})
	if code != http.StatusOK {
		t.Fatalf("应接受，实际 %d (%v)", code, body)
	}
	if body["started"] != true {
		t.Errorf("应返回 started=true，实际 %v", body["started"])
	}
}

// 扫描接口只接受 POST。
func TestScanRunRejectsGET(t *testing.T) {
	s, base := newTestServer(t)
	cookie := loginCookie(t, s, base)
	if code := doGetWithCookie(t, base+"/api/scan/run", cookie); code != http.StatusMethodNotAllowed {
		t.Errorf("GET 应 405，实际 %d", code)
	}
}

// 候选清洗接口：粘 CSV 也要正确认出来。
func TestScanParseCandidates(t *testing.T) {
	s, base := newTestServer(t)
	cookie := loginCookie(t, s, base)

	raw := strings.Join([]string{
		"IP 地址,已发送,已接收,丢包率,平均延迟,下载速度 (MB/s)",
		"104.16.1.1,4,4,0.00,45.2,12.34",
		"104.17.2.2:443#香港,4,4,0.00,50.1,10.00",
		"[2606:4700::1]:443,4,4,0,60,8",
		"cf.example.com,4,4,0,70,5",
		"999.999.999.999,0,0,100,0,0",
	}, "\n")

	code, body := postJSON(t, base+"/api/scan/parse-candidates", cookie, map[string]any{"raw": raw})
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", code)
	}
	count, _ := body["count"].(float64)
	if int(count) != 4 {
		t.Errorf("应认出 4 个（排除表头与非法 IP），实际 %v：%v", count, body["candidates"])
	}

	list, _ := body["candidates"].([]any)
	got := make([]string, 0, len(list))
	for _, v := range list {
		got = append(got, str(v))
	}
	want := map[string]bool{
		"104.16.1.1":     true,
		"104.17.2.2":     true,
		"2606:4700::1":   true,
		"cf.example.com": true,
	}
	for _, g := range got {
		if !want[g] {
			t.Errorf("不应包含 %q", g)
		}
	}
}

// 地区列表要非空且含常用机房。
func TestScanCountries(t *testing.T) {
	s, base := newTestServer(t)
	cookie := loginCookie(t, s, base)

	code, body := getJSON(t, base+"/api/scan/countries", cookie)
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", code)
	}
	list, ok := body["countries"].([]any)
	if !ok || len(list) == 0 {
		t.Fatalf("应有地区列表，实际 %v", body["countries"])
	}

	found := map[string]bool{}
	for _, item := range list {
		m, _ := item.(map[string]any)
		if m != nil {
			found[str(m["code"])] = true
		}
	}
	for _, want := range []string{"HKG", "NRT", "SIN", "LAX", "FRA"} {
		if !found[want] {
			t.Errorf("缺少常用机房 %s", want)
		}
	}
}

// 环境检测：没代理时应给出「可信」的结论。
func TestScanEnvCheck(t *testing.T) {
	s, base := newTestServer(t)
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/scan/env-check", cookie, map[string]any{})
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", code)
	}
	findings, ok := body["findings"].([]any)
	if !ok || len(findings) == 0 {
		t.Fatalf("应至少有一条结论，实际 %v", body["findings"])
	}
}

// 取消接口：没有扫描时也应正常返回。
func TestScanCancelNoop(t *testing.T) {
	s, base := newTestServer(t)
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/scan/cancel", cookie, map[string]any{})
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", code)
	}
	if !strings.Contains(str(body["note"]), "没有") {
		t.Errorf("应提示当前没有扫描，实际 %v", body["note"])
	}
}

// 缺凭据时自动识别域名要给出明确提示。
func TestScanDetectHostNoCredentials(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/scan/detect-host", cookie, map[string]any{})
	if code != http.StatusBadRequest {
		t.Fatalf("应 400，实际 %d", code)
	}
	if !strings.Contains(str(body["error"]), "Token") {
		t.Errorf("应提示填 Token，实际 %v", body["error"])
	}
}

// ---------- pages.dev 域名规范化 ----------

func TestNormalizePagesHost(t *testing.T) {
	cases := []struct{ in, want string }{
		// 核心回归：不能出现 `.pages.dev.pages.dev`
		{"cpdata.pages.dev", "cpdata.pages.dev"},
		{"cpdata.pages.dev.pages.dev", "cpdata.pages.dev"},
		{"cpdata.pages.dev.pages.dev.pages.dev", "cpdata.pages.dev"},
		// 不带后缀的要补一次
		{"cpdata", "cpdata.pages.dev"},
		{"cpdata-ux7t-li8f", "cpdata-ux7t-li8f.pages.dev"},
		// 带协议与路径
		{"https://cpdata.pages.dev/", "cpdata.pages.dev"},
		{"https://cpdata.pages.dev/__version", "cpdata.pages.dev"},
		{"http://cpdata.pages.dev", "cpdata.pages.dev"},
		// 大小写
		{"CPDATA.PAGES.DEV", "CPDATA.pages.dev"},
		// 空
		{"", ""},
		{"   ", ""},
	}
	for _, tc := range cases {
		if got := normalizePagesHost(tc.in); got != tc.want {
			t.Errorf("normalizePagesHost(%q) = %q，期望 %q", tc.in, got, tc.want)
		}
	}
}

// formatCopyable 输出格式要与 Electron 版一致（用户会跨版本复制）。
func TestFormatCopyable(t *testing.T) {
	entries := []scan.Entry{
		{IP: "104.16.1.1", Port: 443, Colo: "HKG"},
		{IP: "104.17.2.2", Port: 2053, Colo: ""},
	}
	got := formatCopyable(entries)
	want := "104.16.1.1:443#HKG\n104.17.2.2:2053#CF\n"
	if got != want {
		t.Errorf("输出格式不对：\n期望 %q\n实际 %q", want, got)
	}
}
