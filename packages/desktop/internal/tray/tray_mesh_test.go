//go:build mesh

package tray

import (
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/mesh"
)

func TestMeshToggleState(t *testing.T) {
	for _, test := range []struct {
		status   mesh.Status
		pending  bool
		label    string
		disabled bool
	}{
		{mesh.Status{}, false, "启动组网服务", false},
		{mesh.Status{Running: true}, false, "停止组网服务", false},
		{mesh.Status{Transition: "starting"}, false, "正在启动组网…", true},
		{mesh.Status{Running: true, Transition: "stopping"}, false, "正在停止组网…", true},
		{mesh.Status{Running: true}, true, "处理中…", true},
	} {
		label, disabled := meshToggleState(test.status, test.pending)
		if label != test.label || disabled != test.disabled {
			t.Errorf("状态 %+v，操作进行中=%t，菜单为 %q / 禁用=%t，期望 %q / 禁用=%t", test.status, test.pending, label, disabled, test.label, test.disabled)
		}
	}
}
