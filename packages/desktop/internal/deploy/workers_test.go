package deploy

import (
	"errors"
	"fmt"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
)

// TestIsPermissionErr 覆盖权限错误识别。
//
// 这个判定决定「部署前预检是否拦下」：
//   - 认不出 403 → 预检放行 → 又回到「先传脚本再失败」的老路
//   - 把网络错误当成权限错误 → 让用户去改 Token，白折腾
func TestIsPermissionErr(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"401", &cfapi.APIError{Status: 401, Message: "Unauthorized"}, true},
		{"403", &cfapi.APIError{Status: 403, Message: "Authentication error"}, true},
		{"500 不是权限问题", &cfapi.APIError{Status: 500, Message: "internal"}, false},
		{"包裹后的 403 仍能识别", fmt.Errorf("wrap: %w", &cfapi.APIError{Status: 403}), true},
		{"网络错误不是权限问题", errors.New("dial tcp: i/o timeout"), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isPermissionErr(c.err); got != c.want {
				t.Fatalf("isPermissionErr(%v) = %v, want %v", c.err, got, c.want)
			}
		})
	}
}

// TestWorkersPermHintNotEmpty 保证三条权限提示都写清楚了「去哪勾什么」。
//
// 提示为空等于把用户扔回一句裸的 Authentication error —— 这正是 0.12.3 的问题。
func TestWorkersPermHintNotEmpty(t *testing.T) {
	for name, hint := range map[string]string{
		"scripts": workersPermHint.scripts,
		"domains": workersPermHint.domains,
		"dns":     workersPermHint.dns,
	} {
		if hint == "" {
			t.Fatalf("%s 的权限提示为空", name)
		}
	}
}

// TestIsPagesLeftoverDns 覆盖「哪些 DNS 记录可以安全删掉」。
//
// 判错一边都不行：
//   - 漏判 → 换形态时 409 / 100117 依旧（Pages 遗留的 CNAME 没清掉）
//   - 多判 → 把用户的业务记录删了，比部署失败严重得多
func TestIsPagesLeftoverDns(t *testing.T) {
	cases := []struct {
		name string
		rec  cfapi.DNSRecord
		want bool
	}{
		{"Pages 遗留 CNAME", cfapi.DNSRecord{Type: "CNAME", Content: "aytwi20y.pages.dev"}, true},
		{"大写域名", cfapi.DNSRecord{Type: "CNAME", Content: "abc.PAGES.DEV"}, true},
		{"带尾点", cfapi.DNSRecord{Type: "CNAME", Content: "abc.pages.dev."}, true},
		{"指向别处的 CNAME", cfapi.DNSRecord{Type: "CNAME", Content: "origin.example.net"}, false},
		{"A 记录", cfapi.DNSRecord{Type: "A", Content: "203.0.113.9"}, false},
		{"TXT 验证记录", cfapi.DNSRecord{Type: "TXT", Content: "verify=abc"}, false},
		{"长得像但不以 pages.dev 结尾", cfapi.DNSRecord{Type: "CNAME", Content: "notpages.dev.evil.com"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isPagesLeftoverDns(c.rec); got != c.want {
				t.Fatalf("isPagesLeftoverDns(%v) = %v, want %v", c.rec, got, c.want)
			}
		})
	}
}
