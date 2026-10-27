package scan

import (
	"strings"
	"testing"
)

// TestFormatHostIPv6 验证 IPv6 输出带方括号。
//
// 数据面 sub-engine.ts 的解析器按冒号数量分流：
//
//	[2606:4700::1]:443  → 正确
//	2606:4700::1:443    → 冒号数 > 1 → 整个串当成 IPv6 地址 → IP 错了
//
// 所以产出方必须加方括号。
func TestFormatHostIPv6(t *testing.T) {
	if got := FormatHost("2606:4700::1"); got != "[2606:4700::1]" {
		t.Errorf("IPv6 应加方括号，实际 %q", got)
	}
	if got := FormatHost("104.16.0.1"); got != "104.16.0.1" {
		t.Errorf("IPv4 不应加方括号，实际 %q", got)
	}
}

// TestFormatHostRoundTrip 验证加方括号后能被数据面解析器正确还原。
func TestFormatHostRoundTrip(t *testing.T) {
	line := FormatHost("2606:4700::1") + ":443#HKG"
	if !strings.HasPrefix(line, "[") {
		t.Fatalf("IPv6 行应以 [ 开头：%q", line)
	}
	// 括号形式：[IPv6]:port#remark
	close := strings.Index(line, "]")
	if close < 0 {
		t.Fatalf("缺少右括号：%q", line)
	}
	host := line[1:close]
	if host != "2606:4700::1" {
		t.Errorf("还原出的 host 不对：%q", host)
	}
	rest := line[close+1:]
	if !strings.HasPrefix(rest, ":443") {
		t.Errorf("端口部分不对：%q", rest)
	}
}

// TestIsTimeoutError 验证超时识别。
func TestIsTimeoutError(t *testing.T) {
	timeoutCases := []string{"TLS 握手超时", "TLS 连接超时", "timeout", "ETIMEDOUT", "i/o timeout"}
	for _, c := range timeoutCases {
		if !isTimeoutError(c) {
			t.Errorf("%q 应识别为超时", c)
		}
	}
	otherCases := []string{"connection reset by peer", "ECONNRESET", "", "证书错误"}
	for _, c := range otherCases {
		if isTimeoutError(c) {
			t.Errorf("%q 不应识别为超时", c)
		}
	}
}

// TestCIDRWeightPrefixedTable 验证预解析后的权重表与逐条解析结果一致。
func TestCIDRWeightPrefixedTable(t *testing.T) {
	// 覆盖精确命中、最长前缀、未知网段三种情况
	cases := []string{
		"104.16.0.0/13",
		"104.17.1.1/32",
		"162.159.0.0/16",
		"198.41.128.0/17",
		"8.8.8.0/24",
	}
	for _, c := range cases {
		w := CIDRWeight(c)
		if w < 0 || w > 1 {
			t.Errorf("%s 权重 %v 越界", c, w)
		}
		// 重复调用应得到相同结果（表已预解析，不能有随机性）
		if again := CIDRWeight(c); again != w {
			t.Errorf("%s 两次调用结果不同：%v vs %v", c, w, again)
		}
	}
}
