package mesh

import "testing"

// TestNewLifecycleContract 验证两种 build tag 下 Lifecycle 的通用契约：
// 空配置下 Start 必须 fail-closed（返回错误，不静默成功），Stop 无错，Status 不谎报 Running。
// 非 mesh 变体返回 ErrStub；mesh 变体因 Config.Validate 失败返回配置错误——两者都满足"不静默成功"。
func TestNewLifecycleContract(t *testing.T) {
	l := NewLifecycle()
	if l == nil {
		t.Fatal("NewLifecycle 不应返回 nil")
	}
	if err := l.Start(nil); err == nil {
		t.Error("空配置 Start 必须返回错误（不得静默成功）")
	}
	if err := l.Stop(); err != nil {
		t.Errorf("Stop 应无错误，实际 %v", err)
	}
	st := l.Status()
	if st.Running {
		t.Error("Status.Running 必须为 false（不得谎报组网成功）")
	}
	if st.Note == "" {
		t.Error("Status.Note 应说明当前变体/状态")
	}
}
