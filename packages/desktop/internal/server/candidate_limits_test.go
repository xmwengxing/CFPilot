package server

// 大清单的闸门 —— 回归测试。
//
// ## 要挡的场景
//
// 界面「自定义候选」输入框在**每敲一个键**时就把整个文本发过来
// （刷新「已识别 N 个」提示）。清单一大（几万行）就是：
//
//   - 浏览器把几万行塞进一个 textarea → 渲染卡死；
//   - 每次按键都把整个文本 POST 回来 → 后端被大请求撑爆（进程被杀）。
//
// 所以三道闸：
//   1. 请求体上限（超过直接 413，不进内存）；
//   2. 合并清单的行数上限（界面只拿到截断后的原文）；
//   3. 自定义候选的数量上限（优选不会对几万个 IP 逐个握手）。

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// 请求体超上限要 413，且提示说人话。
func TestRequestBodyLimit(t *testing.T) {
	s, base := newTestServer(t)
	cookie := loginCookie(t, s, base)

	huge := strings.Repeat("1.2.3.4\n", (maxRequestBody/8)+1024)
	code, body := postJSON(t, base+"/api/scan/parse-candidates", cookie, map[string]any{"raw": huge})
	if code != http.StatusRequestEntityTooLarge {
		t.Fatalf("超大请求体应 413，实际 %d (%v)", code, body)
	}
	if !strings.Contains(str(body["error"]), "过大") {
		t.Errorf("提示应说明过大，实际 %v", body["error"])
	}
}

// 正常大小的请求体不受影响。
func TestRequestBodyLimitAllowsNormalSize(t *testing.T) {
	s, base := newTestServer(t)
	cookie := loginCookie(t, s, base)

	raw := strings.Repeat("1.2.3.4\n", 100)
	code, body := postJSON(t, base+"/api/scan/parse-candidates", cookie, map[string]any{"raw": raw})
	if code != http.StatusOK {
		t.Fatalf("正常请求体应 200，实际 %d (%v)", code, body)
	}
}

// 自定义候选超过上限要 400，并说清怎么办。
func TestScanRunRejectsTooManyCandidates(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/scan/run", cookie, map[string]any{
		"host":       "cf.example.com",
		"candidates": distinctIPs(maxCustomCandidates + 10),
	})
	if code != http.StatusBadRequest {
		t.Fatalf("候选过多应 400，实际 %d (%v)", code, body)
	}
	msg := str(body["error"])
	if !strings.Contains(msg, "上限") {
		t.Errorf("提示应说明上限，实际 %v", msg)
	}
}

// 候选数正好等于上限时不拦。
func TestScanRunAllowsCandidatesAtLimit(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/scan/run", cookie, map[string]any{
		"host":       "cf.example.com",
		"candidates": distinctIPs(maxCustomCandidates),
	})
	if code != http.StatusOK {
		t.Fatalf("正好到上限应接受，实际 %d (%v)", code, body)
	}
	if body["started"] != true {
		t.Errorf("应返回 started=true，实际 %v", body)
	}
}

// 合并清单的行数上限：原文被截断，并如实说明丢了多少行。
func TestMergeWithLineBudget(t *testing.T) {
	short := []string{"1.1.1.1\n2.2.2.2", "3.3.3.3"}
	got, dropped := mergeWithLineBudget(short, 100)
	if dropped != 0 {
		t.Errorf("没超预算时不该丢内容，实际 dropped=%d", dropped)
	}
	if got != "1.1.1.1\n2.2.2.2\n3.3.3.3" {
		t.Errorf("没超预算时应原样合并，实际 %q", got)
	}
}

// ⚠️ 超预算时要**按来源均摊** —— 直接截断拼接结果等于只留前几个来源，
// 后面几十个来源的候选全丢，候选多样性被毁掉。
func TestMergeWithLineBudgetSpreadsAcrossSources(t *testing.T) {
	chunks := make([]string, 0, 10)
	for i := 0; i < 10; i++ {
		chunks = append(chunks, strings.TrimSuffix(strings.Repeat(fmt.Sprintf("10.0.0.%d\n", i), 1000), "\n"))
	}
	got, dropped := mergeWithLineBudget(chunks, 1000)
	lines := strings.Split(got, "\n")
	if len(lines) != 1000 {
		t.Errorf("合并后应剩 1000 行，实际 %d", len(lines))
	}
	// 每个来源都该分到一点（10 个来源 × 100 行）
	// ⚠️ 变的是第 4 段，取的也要是第 4 段
	seen := map[string]bool{}
	for _, l := range lines {
		seen[strings.Split(l, ".")[3]] = true
	}
	if len(seen) != 10 {
		t.Errorf("10 个来源都应保留，实际只保留了 %d 个", len(seen))
	}
	if dropped != 9000 {
		t.Errorf("应丢掉 9000 行，实际 %d", dropped)
	}
}

// distinctIPs 造 n 个互不相同的 IP（解析器会去重，重复的造不出「超上限」）。
func distinctIPs(n int) string {
	var b strings.Builder
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, "104.%d.%d.%d\n", (i/65536)%256, (i/256)%256, i%256)
	}
	return b.String()
}
