package mesh

import (
	"encoding/hex"
	"testing"
)

// TestNodeIDFromIdentityPub 验证 NodeId = BLAKE3(pub)[0..8] 的确定性与长度。
func TestNodeIDFromIdentityPub(t *testing.T) {
	pubA := make([]byte, 32)
	pubA[0] = 1
	pubB := make([]byte, 32)
	pubB[0] = 2

	idA := NodeIDFromIdentityPub(pubA)
	if len(hex.EncodeToString(idA[:])) != 16 {
		t.Errorf("NodeId hex 长度应为 16，实际 %q", idA.Hex())
	}
	if idA == NodeIDFromIdentityPub(pubA) && idA != NodeIDFromIdentityPub(pubB) {
		// 确定性 + 不同公钥不同 ID
	} else {
		t.Error("NodeId 派生应确定性且不同公钥产生不同 ID")
	}
}

// TestLoadOrCreateIdentity 验证身份生成后持久化，第二次加载复用同一身份。
func TestLoadOrCreateIdentity(t *testing.T) {
	dir := t.TempDir()
	id1, err := LoadOrCreateIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	if id1.NodeID == (NodeID{}) {
		t.Error("NodeId 不应为全零")
	}
	if len(id1.TunnelPub) != 32 {
		t.Errorf("隧道公钥长度应为 32，实际 %d", len(id1.TunnelPub))
	}

	id2, err := LoadOrCreateIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	if id2.NodeID != id1.NodeID {
		t.Errorf("重启后 NodeId 应不变：%s vs %s", id1.NodeID.Hex(), id2.NodeID.Hex())
	}
	if string(id2.TunnelPub) != string(id1.TunnelPub) {
		t.Error("重启后隧道公钥应不变")
	}
}

// TestEnsureDistinct 验证 NodeId 冲突时自动重新生成身份（克隆密钥场景）。
func TestEnsureDistinct(t *testing.T) {
	dir := t.TempDir()
	id, err := LoadOrCreateIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	// 无冲突：不重新生成
	same, changed, err := id.EnsureDistinct(dir, []NodeID{NodeIDFromIdentityPub(make([]byte, 32))})
	if err != nil || changed || same.NodeID != id.NodeID {
		t.Errorf("无冲突时不应重新生成: changed=%v err=%v", changed, err)
	}
	// 有冲突（对端 ID == 本机 ID）：重新生成
	fresh, changed, err := id.EnsureDistinct(dir, []NodeID{id.NodeID})
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("冲突时应重新生成身份")
	}
	if fresh.NodeID == id.NodeID {
		t.Errorf("重新生成后 NodeId 应变化: %s", fresh.NodeID.Hex())
	}
	// 再次加载应拿到新身份（持久化生效）
	reloaded, err := LoadOrCreateIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.NodeID != fresh.NodeID {
		t.Error("新身份应持久化")
	}
}
