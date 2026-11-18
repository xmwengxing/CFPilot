// Package mesh 的协议常量（Phase 3b）。
//
// ⚠️ 本文件的所有值来自 E:\Projects\MobiHop\docs\MESH_INTEGRATION_CONTRACT.md
// （基于 main@1ccfdc1，审计修复后 wire 未改动）。**逐字节对齐，不要凭记忆改**。
//
// 协调约定（见 docs/mesh-integration-plan.md §7.1）：
// 若 MobiHop 演进 Phase C 引入可调参，只改本文件的读取来源，
// 不触碰编解码逻辑（frame.go / crypto.go）。
package mesh

// ---- 帧协议（契约 §1）----

const (
	MagicByte byte = 0x4D // 'M'，lib.rs:29

	// 线速版本（ADR-0016，2026-11-18 冻结）。
	//
	// 接受集合固定为 {v1, v2}；**出站默认 v2**。
	// 对已知 v1 对端必须显式降级（Frame.Version = WireVersionV1），
	// 否则旧节点在头部版本校验处直接丢帧。
	WireVersionV1      byte = 0x01 // LEGACY_VERSION，lib.rs:35
	WireVersionV2      byte = 0x02 // VERSION，lib.rs:31
	WireVersionDefault byte = WireVersionV2

	HeaderLen  = 32   // lib.rs:33
	MaxPayload = 1400 // lib.rs:35，单帧载荷上限 = 隧道 MTU
	MaxFrame   = 1432 // HeaderLen + MaxPayload，ws.rs:55
	DefaultTTL byte = 16 // lib.rs:37
	MaxTTL     byte = 64 // lib.rs:39
)

// 消息类型（契约 §1.2，header.rs:50-65）
type MsgType byte

const (
	MsgHandshake MsgType = 0x01 // 控制面 MessagePack，e2e 路由
	MsgGossip    MsgType = 0x02 // 控制面 MessagePack，逐跳
	MsgPing      MsgType = 0x03 // 控制面 MessagePack，逐跳
	MsgData      MsgType = 0x04 // E2E AEAD 密文（原始 IP 包）
	MsgHolePunch MsgType = 0x05 // 控制面 MessagePack（PunchMessage）
	MsgRelayMgmt MsgType = 0x06 // 控制面 MessagePack（RelayMessage）
	MsgAgentRpc  MsgType = 0x07 // E2E AEAD 密文
	MsgUdpProbe  MsgType = 0x08 // UDP 健康探测，不 e2e 路由（中继收到即丢弃）
)

// IsE2ERouted 报告该类型是否走 e2e 路由（契约 §1.2，header.rs:76-81）。
func (t MsgType) IsE2ERouted() bool {
	switch t {
	case MsgHandshake, MsgData, MsgHolePunch, MsgRelayMgmt, MsgAgentRpc:
		return true
	default:
		return false
	}
}

// flags 位（契约 §1.3，header.rs:104-130）
const (
	FlagEncrypted byte = 0x01 // bit0：载荷已 E2E AEAD 加密
	FlagRelayed   byte = 0x02 // bit1：经过至少一次中继（不参与 AAD）
	FlagAckReq    byte = 0x04 // bit2：请求确认
	FlagReserved  byte = 0xF8 // bit3-7：必须为 0
)

// ---- 握手（契约 §2）----

const (
	// NoisePattern 是 Noise 模式串（session.rs:24）
	NoisePattern = "Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s"
	// PskIndex 是 PSK 在握手中的 index（session.rs:102/139）
	PskIndex = 2
	// PskContext 是 BLAKE3 derive_key 的 context 字符串（kdf.rs:18）
	PskContext = "mobihop/psk/v1"
	// DirKeyI2R / DirKeyR2I 是方向密钥派生标签（session.rs:181-190）
	DirKeyI2R = "mobihop/i2r"
	DirKeyR2I = "mobihop/r2i"
	// RekeyCounterThreshold / RekeyAgeSec 触发重握手（session.rs:26-30）
	RekeyCounterThreshold uint64 = 1 << 32
	RekeyAgeSec                  = 600
	DrainAgeSec                  = 30
)

// ---- 数据面 AEAD（契约 §3）----

const (
	NonceLen = 12 // aead.rs:20
	TagLen   = 16 // aead.rs:23
	// ReplayWindowBits 是每会话每 epoch 的滑动窗口位图（replay.rs:8）
	ReplayWindowBits = 2048
)

// ---- 打洞（契约 §4）----

const (
	PunchWindowMs   int64 = 3000 // punch.rs:30
	PunchIntervalMs int64 = 100  // punch.rs:31
	PunchTimeoutMs  int64 = 6000 // punch.rs:32
	PunchCooldownMs int64 = 2000 // punch.rs:33
	MinStunServers        = 2    // stun.rs:77

	PriorityHost            uint64 = 1_000_000 // control.rs:59
	PriorityServerReflexive uint64 = 500_000   // control.rs:60
	PriorityRelayed         uint64 = 100_000   // control.rs:61
	PriorityIPv6Bonus       uint64 = 10_000    // control.rs:62
)

// ---- 选路（契约 §5）----

const (
	LossWeight     = 500.0 // route.rs:18，每 1.0 丢包率折算 500ms
	RelayPenaltyMS = 15.0  // route.rs:20，**每跳** 15ms

	// H3-2 质量加权边权（route.rs:22/24/26）。
	// 专项都已是「毫秒当量」，**不归一化**（归一化在实现中被否决）。
	// 缺质量样本时退化为 rtt + loss*500 + 15，与 H3 之前逐字节等价。
	WRttMin    = 1.0 // W_RTT_MIN
	WRttVar    = 1.5 // W_RTT_VAR：相对 rtt_min 的方差惩罚
	WJitter    = 2.0 // W_JITTER
	HysteresisMS     = 10.0  // path.rs:122，新路径需优出至少此值
	SwitchCooldownMS = 1000  // path.rs:123
	ProbeTimeoutMS   = 2000  // path.rs:124
)

// ---- WSS（契约 §6）----

const (
	WssDefaultPort = 443 // ws.rs:175
	NBadWindows    = 3   // node.rs:2776，连续差观测窗
	NGoodWindows   = 3   // node.rs:2778，连续好观测窗
	BadLossPct     = 20  // node.rs:2780，降级丢包阈值（百分比）
	BadRttMS       = 300 // node.rs:2781，降级 RTT 阈值
	GoodLossPct    = 5   // node.rs:2784，回切丢包阈值
	GoodRttMS      = 150 // node.rs:2785，回切 RTT 阈值
	CooldownTicks  = 10  // node.rs:2779
	LossMinSamples = 5   // router.rs:49
)
