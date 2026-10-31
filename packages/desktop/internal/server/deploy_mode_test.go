package server

import (
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/deploy"
)

// TestDataPlaneModeOf 覆盖「清单里没有形态字段」的兼容路径。
//
// 旧清单（0.12.3 之前）没有 dataPlaneMode 字段，读出来是空串。
// 界面靠这个值回填单选框 —— 返回空串会让「Pages / Workers」两个选项
// 都不选中，用户看到的是一个既不是 Pages 也不是 Workers 的实例。
func TestDataPlaneModeOf(t *testing.T) {
	cases := []struct {
		name string
		in   *deploy.Manifest
		want string
	}{
		{"nil 清单", nil, "pages"},
		{"旧清单无字段", &deploy.Manifest{}, "pages"},
		{"workers 实例", &deploy.Manifest{DataPlaneMode: "workers"}, "workers"},
		{"pages 实例", &deploy.Manifest{DataPlaneMode: "pages"}, "pages"},
		{"未知取值按 pages 兜底", &deploy.Manifest{DataPlaneMode: "wat"}, "pages"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := dataPlaneModeOf(c.in); got != c.want {
				t.Fatalf("dataPlaneModeOf = %q, want %q", got, c.want)
			}
		})
	}
}
