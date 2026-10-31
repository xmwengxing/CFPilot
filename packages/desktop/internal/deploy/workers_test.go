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
