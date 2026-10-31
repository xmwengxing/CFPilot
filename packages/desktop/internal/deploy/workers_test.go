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
//   - 认不出 403 → 预检放行 → 部署到一半才失败
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

// TestWorkersPermHintNotEmpty 保证权限提示写清楚了「去哪勾什么」。
//
// 提示为空等于把用户扔回一句裸的 Authentication error。
func TestWorkersPermHintNotEmpty(t *testing.T) {
	if workersPermHint.scripts == "" {
		t.Fatal("scripts 的权限提示为空")
	}
}

// TestWorkersDevHost 覆盖生产域名的拼装。
//
// 账号没注册 workers.dev 子域时要能退回 `<name>.workers.dev` —— 否则
// 订阅里会出现 `name..workers.dev` 这种畸形域名。
func TestWorkersDevHost(t *testing.T) {
	cases := []struct {
		name, sub, want string
	}{
		{"abc123", "wxgo8609", "abc123.wxgo8609.workers.dev"},
		{"abc123", "", "abc123.workers.dev"},
		{"abc123", "   ", "abc123.workers.dev"},
	}
	for _, c := range cases {
		if got := workersDevHost(c.name, c.sub); got != c.want {
			t.Fatalf("workersDevHost(%q,%q) = %q, want %q", c.name, c.sub, got, c.want)
		}
	}
}

// TestResolveNodeHost 覆盖节点域名选择。
//
// 用户填了就写进 DATA_HOST（订阅用它）；留空才退回 workers.dev。
func TestResolveNodeHost(t *testing.T) {
	cases := []struct{ dataHost, devHost, want string }{
		{"w1.example.com", "abc.wxgo8609.workers.dev", "w1.example.com"},
		{"", "abc.wxgo8609.workers.dev", "abc.wxgo8609.workers.dev"},
		{"   ", "abc.workers.dev", "abc.workers.dev"},
	}
	for _, c := range cases {
		if got := resolveNodeHost(c.dataHost, c.devHost); got != c.want {
			t.Fatalf("resolveNodeHost(%q,%q) = %q, want %q", c.dataHost, c.devHost, got, c.want)
		}
	}
}
