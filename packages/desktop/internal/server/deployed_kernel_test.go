package server

import (
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/store"
)

// TestDeployedKernelVersion 验证托盘「检查部署更新」读到的是**线上已部署内核版本**，
// 而不是应用包版本（后者不随部署变化，会导致更新提示永远消不掉）。
func TestDeployedKernelVersion(t *testing.T) {
	s := &Server{}
	s.SetStore(store.New(t.TempDir()))

	// 无快照时返回空串（调用方按「更旧」处理，提示重新部署）
	if got := s.DeployedKernelVersion(); got != "" {
		t.Errorf("无快照时应返回空串，实际 %q", got)
	}

	// 部署快照写入内核版本后，应原样读出（含空白裁剪）
	s.saveSnapshot(&DeploySnapshot{KernelVersion: " 0.7.6 ", ControlProject: "p", DataProject: "d"})
	if got := s.DeployedKernelVersion(); got != "0.7.6" {
		t.Errorf("DeployedKernelVersion = %q，期望 0.7.6", got)
	}
}
