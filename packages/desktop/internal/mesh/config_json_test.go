package mesh

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// 面板 / meshd 之间用 JSON 传配置：nodeId 与 peers.staticPub 都是**十六进制字符串**。
// 早前只实现了 MessagePack 编解码，JSON 解码直接报
// 「cannot unmarshal string into Go struct field Config.nodeId of type mesh.NodeID」。
func TestConfigJSONAcceptsHexNodeIDAndPub(t *testing.T) {
	hexPub := strings.Repeat("11", 32) // 32 字节 → 64 hex
	payload := `{
		"nodeId":"0100000000000001",
		"networkName":"n","psk":"s","virtualIp":"10.97.0.1",
		"listen":"0.0.0.0:51820",
		"peers":[{"nodeId":"0200000000000002","addr":"1.2.3.4:51820",
		          "staticPub":"` + hexPub + `","virtualIp":"10.97.0.2"}]
	}`
	var cfg Config
	if err := json.Unmarshal([]byte(payload), &cfg); err != nil {
		t.Fatalf("十六进制配置解码失败: %v", err)
	}
	if cfg.NodeID.Hex() != "0100000000000001" {
		t.Errorf("NodeID = %s", cfg.NodeID.Hex())
	}
	if len(cfg.Peers) != 1 {
		t.Fatalf("peers = %d", len(cfg.Peers))
	}
	if got := cfg.Peers[0].NodeID.Hex(); got != "0200000000000002" {
		t.Errorf("peer NodeID = %s", got)
	}
	if len(cfg.Peers[0].StaticPub) != 32 {
		t.Errorf("staticPub 长度 = %d，期望 32（hex 应被解码）", len(cfg.Peers[0].StaticPub))
	}
	if err := cfg.Validate(); err != nil {
		t.Errorf("解码后应通过校验: %v", err)
	}
}

func TestConfigJSONAcceptsBase64Pub(t *testing.T) {
	pub := make([]byte, 32)
	for i := range pub {
		pub[i] = 0x22
	}
	b64 := base64.StdEncoding.EncodeToString(pub)
	payload := `{"nodeId":"0100000000000001","networkName":"n","psk":"s",
		"virtualIp":"10.97.0.1",
		"peers":[{"nodeId":"0200000000000002","addr":"1.2.3.4:51820",
		          "staticPub":"` + b64 + `","virtualIp":"10.97.0.2"}]}`
	var cfg Config
	if err := json.Unmarshal([]byte(payload), &cfg); err != nil {
		t.Fatalf("base64 配置解码失败: %v", err)
	}
	if len(cfg.Peers[0].StaticPub) != 32 {
		t.Errorf("staticPub 长度 = %d", len(cfg.Peers[0].StaticPub))
	}
}

func TestConfigJSONRejectsBadNodeID(t *testing.T) {
	var cfg Config
	err := json.Unmarshal([]byte(`{"nodeId":"xyz","networkName":"n","psk":"s","virtualIp":"10.97.0.1"}`), &cfg)
	if err == nil {
		t.Fatal("非法 nodeId 应该报错")
	}
}

// NodeID 的输出侧也必须是 hex 字符串（meshd 的状态/日志与面板互通依赖它）
func TestNodeIDJSONRoundTrip(t *testing.T) {
	id := NodeID{1, 2, 3, 4, 5, 6, 7, 8}
	b, err := json.Marshal(id)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `"0102030405060708"` {
		t.Errorf("MarshalJSON = %s", b)
	}
	var got NodeID
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got != id {
		t.Errorf("往返不一致: %v != %v", got, id)
	}
}

func TestConfigJSONAllowsEmptyNodeID(t *testing.T) {
	// 身份接口还没返回时 UI 会传空 nodeId；内核会用 identitySeed 重新派生，
	// 这里不能报 400（否则用户看到的是「点了启动就失败」）。
	var cfg Config
	payload := `{"nodeId":"","networkName":"n","psk":"s","virtualIp":"10.97.0.1"}`
	if err := json.Unmarshal([]byte(payload), &cfg); err != nil {
		t.Fatalf("空 nodeId 应被容忍: %v", err)
	}
	if cfg.NodeID != (NodeID{}) {
		t.Errorf("空 nodeId 应解成零值，实际 %v", cfg.NodeID)
	}
}
