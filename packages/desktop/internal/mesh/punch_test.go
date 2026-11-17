package mesh

import (
	"bytes"
	"testing"

	"github.com/vmihailenco/msgpack/v5"
)

func TestNodeIDWireIsArray(t *testing.T) {
	var id NodeID
	copy(id[:], []byte{1, 2, 3, 4, 5, 6, 7, 8})
	b, err := msgpack.Marshal(id)
	if err != nil {
		t.Fatal(err)
	}
	// NodeId 应为 8 元素 array（msgpack fixarray 0x98 + 8 字节）
	if b[0] != 0x98 {
		t.Errorf("NodeID wire 首字节 = %#x, 期望 0x98（8 元素 array）", b[0])
	}
	var back NodeID
	if err := msgpack.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back != id {
		t.Errorf("NodeID 往返不符: %x vs %x", back, id)
	}
}

func TestPunchMessageNamedFields(t *testing.T) {
	var from NodeID
	copy(from[:], []byte{9, 8, 7, 6, 5, 4, 3, 2, 1})
	addr := NewV4Addr([4]byte{198, 51, 100, 7}, 51820)
	m := &PunchMessage{
		PunchReq: &PunchRequest{
			From:       from,
			Candidates: []Candidate{{Addr: addr, Kind: CandidateHost, Priority: PriorityFor(CandidateHost, false)}},
			PunchAtMS:  1700000000000,
			Nonce:      42,
		},
	}

	b, err := EncodePunchMessage(m)
	if err != nil {
		t.Fatal(err)
	}
	// named MessagePack：解码为 map，键名应为 "PunchRequest"（外部标签）与内部字段名
	var asMap map[string]msgpack.RawMessage
	if err := msgpack.Unmarshal(b, &asMap); err != nil {
		t.Fatalf("打洞消息应为 map: %v", err)
	}
	if _, ok := asMap["PunchRequest"]; !ok {
		t.Errorf("缺少外部标签键 PunchRequest，实际键: %v", mapKeys(asMap))
	}
	var inner map[string]msgpack.RawMessage
	if err := msgpack.Unmarshal(asMap["PunchRequest"], &inner); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"from", "candidates", "punch_at_ms", "nonce"} {
		if _, ok := inner[key]; !ok {
			t.Errorf("PunchRequest 缺少 named 字段 %q，实际: %v", key, mapKeys(inner))
		}
	}

	// 往返
	back, err := DecodePunchMessage(b)
	if err != nil {
		t.Fatal(err)
	}
	if back.PunchReq == nil || back.PunchReq.Nonce != 42 || back.PunchReq.PunchAtMS != 1700000000000 {
		t.Errorf("往返字段不符: %+v", back.PunchReq)
	}
	if back.PunchReq.From != from {
		t.Error("from 不符")
	}
	if len(back.PunchReq.Candidates) != 1 || back.PunchReq.Candidates[0].Kind != CandidateHost {
		t.Errorf("candidates 不符: %+v", back.PunchReq.Candidates)
	}
}

func TestPunchAckObservedOmittedWhenNil(t *testing.T) {
	var from NodeID
	copy(from[:], []byte{1})
	m := &PunchMessage{PunchAck: &PunchAck{From: from, Nonce: 7, Observed: nil}}
	b, err := EncodePunchMessage(m)
	if err != nil {
		t.Fatal(err)
	}
	var asMap map[string]map[string]msgpack.RawMessage
	if err := msgpack.Unmarshal(b, &asMap); err != nil {
		t.Fatal(err)
	}
	inner := asMap["PunchAck"]
	if _, ok := inner["observed"]; ok {
		t.Error("observed=nil 时键不应出现（契约 §4.4）")
	}

	// 有 observed 时键应出现
	addr := NewV6Addr([16]byte{0x20, 0x01}, 443)
	m.PunchAck.Observed = &addr
	b2, _ := EncodePunchMessage(m)
	var asMap2 map[string]map[string]msgpack.RawMessage
	_ = msgpack.Unmarshal(b2, &asMap2)
	if _, ok := asMap2["PunchAck"]["observed"]; !ok {
		t.Error("observed 非 nil 时键应出现")
	}
}

func TestCandidatePriority(t *testing.T) {
	if PriorityFor(CandidateHost, false) != PriorityHost {
		t.Error("Host 优先级不符")
	}
	if PriorityFor(CandidateServerReflexive, false) != PriorityServerReflexive {
		t.Error("ServerReflexive 优先级不符")
	}
	if PriorityFor(CandidateRelayed, false) != PriorityRelayed {
		t.Error("Relayed 优先级不符")
	}
	if PriorityFor(CandidateHost, true) != PriorityHost+PriorityIPv6Bonus {
		t.Error("IPv6 加成不符（契约 §4.3：+10000）")
	}
	// 优先级应递减：Host > Reflexive > Relayed
	if !(PriorityHost > PriorityServerReflexive && PriorityServerReflexive > PriorityRelayed) {
		t.Error("候选优先级应 Host > Reflexive > Relayed")
	}
}

func TestRelayMessageRoomTagOmitted(t *testing.T) {
	var node NodeID
	copy(node[:], []byte{1, 2})
	m := &RelayMessage{Register: &RelayRegister{
		NodeID: node, TokenHash: []byte{0xaa, 0xbb}, RequestedKbps: 0, RoomTag: nil,
	}}
	b, err := EncodeRelayMessage(m)
	if err != nil {
		t.Fatal(err)
	}
	var asMap map[string]map[string]msgpack.RawMessage
	if err := msgpack.Unmarshal(b, &asMap); err != nil {
		t.Fatal(err)
	}
	if _, ok := asMap["Register"]["room_tag"]; ok {
		t.Error("room_tag=None 时键不应出现（契约 §4.6）")
	}
	back, err := DecodeRelayMessage(b)
	if err != nil || back.Register == nil {
		t.Fatalf("往返失败: %v", err)
	}
	if !bytes.Equal(back.Register.TokenHash, []byte{0xaa, 0xbb}) {
		t.Error("token_hash 不符")
	}
}

func mapKeys(m map[string]msgpack.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
