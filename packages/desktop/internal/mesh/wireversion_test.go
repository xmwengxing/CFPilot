package mesh

import "testing"

// ADR-0016 版本协商：只从能解码的入站帧学习，未知对端按 v2。
func TestPeerWireVersions(t *testing.T) {
	v := NewPeerWireVersions()
	a := nodeID(1)
	b := nodeID(2)

	if got := v.VersionFor(a); got != WireVersionV2 {
		t.Errorf("未知对端应按 v2，实际 %#x", got)
	}
	if v.Known(a) {
		t.Error("未知对端不应被标记为已知")
	}

	v.Learn(a, WireVersionV1)
	if got := v.VersionFor(a); got != WireVersionV1 {
		t.Errorf("学到 v1 后应返回 v1，实际 %#x", got)
	}
	if !v.Known(a) {
		t.Error("学到后应为已知")
	}

	// 非法版本来自不可靠输入，必须忽略（不能把对端写成 0x03 然后发不出去）
	v.Learn(a, 0x03)
	if got := v.VersionFor(a); got != WireVersionV1 {
		t.Errorf("非法版本应被忽略，实际 %#x", got)
	}
	if got := v.VersionFor(b); got != WireVersionV2 {
		t.Errorf("其它对端不应受影响，实际 %#x", got)
	}

	// 握手 5s 兜底会用 ForceVersion 强制降级
	v.ForceVersion(b, WireVersionV1)
	if got := v.VersionFor(b); got != WireVersionV1 {
		t.Errorf("ForceVersion 未生效：%#x", got)
	}
}
