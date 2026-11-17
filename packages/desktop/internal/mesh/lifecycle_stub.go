//go:build !mesh

package mesh

import "context"

// stubLifecycle 是非 mesh 变体下的占位实现。
//
// 普通桌面版（不带 -tags=mesh）不暴露完整 mesh 能力，
// 但保留类型存在，使主程序在编译期不依赖 build tag 分支。
// +mesh 变体（lifecycle_mesh.go）会提供真正的入口（Phase 3b 填充协议）。
type stubLifecycle struct{}

// NewLifecycle 返回 Lifecycle 实现。
// 非 mesh 变体返回 stub：Start 明确报 ErrStub，不伪装成功。
func NewLifecycle() Lifecycle { return &stubLifecycle{} }

func (s *stubLifecycle) Start(ctx context.Context) error { return ErrStub }
func (s *stubLifecycle) Stop() error                     { return nil }
func (s *stubLifecycle) Status() Status {
	return Status{Running: false, Note: "非 +mesh 变体：组网能力未编译进本产物"}
}
