// Package mesh —— MobiHop 组网模块嵌入 CFPilot 的工程骨架（Phase 3a）。
//
// ⚠️ 本包当前只定义**工程骨架**：TUN adapter 接口、插件边界、生命周期桩。
//
//	不含任何协议字节级实现（帧 / Noise / AEAD / 打洞 / 选路 / TUN 平台读写），
//	那些在 Phase 3b，依赖 MobiHop 审计后的协议契约报告定稿。
//	详见 CFPilot/docs/mesh-integration-plan.md §8。
//
// 对应 MobiHop 源码（只读核查）：
//   - crates/mobihop-dataplane/src/tun.rs:24  trait TunDevice { name(); recv(); send(Bytes) }
//   - 数据面只依赖 trait，具体实现是 TappersTun（Win AsyncTun / Linux AsyncFd<Tun>）
//   - SharedTun = Arc<dyn TunDevice>
//
// Go 侧对齐：用 TunDevice interface 隔离平台差异与管理员/root 权限，
// 数据面（Phase 3b）只依赖接口，不直接碰 wintun.dll / /dev/net/tun。
package mesh

import (
	"context"
	"fmt"
)

// TunDevice 是虚拟网卡的抽象（对齐 MobiHop 的 TunDevice trait）。
//
// 实现方负责：创建 TUN 设备、配置 IP/路由、收发 IP 包。
// 调用方（数据面）只依赖本接口，从而：
//   - 平台差异（Windows wintun.dll 动态加载 / Linux /dev/net/tun）被隔离在 adapter 后
//   - 管理员/root 权限集中在一处处理
//   - Phase 3a 可用 stub 实现跑通框架测试，不碰真实网卡
type TunDevice interface {
	// Name 返回网卡名（如 "wintun" / "cfpilot0"）。
	Name() string
	// Recv 读一个 IP 包。返回 io.EOF 表示设备关闭。
	Recv(ctx context.Context) ([]byte, error)
	// Send 写一个 IP 包。
	Send(ctx context.Context, packet []byte) error
	// Close 关闭设备并清理（释放句柄、恢复路由）。
	Close() error
}

// TunFactory 创建 TUN 设备（由平台 adapter 实现，Phase 3b 提供真实实现）。
//
// 之所以把创建也抽象成接口：MobiHop 的启动流程里 TUN 创建需要管理员/root，
// 且 Windows 要动态加载 wintun.dll；把它放在 factory 后，上游可用 stub 注入。
type TunFactory interface {
	Create(name string, ipv4 string, mtu int) (TunDevice, error)
}

// Lifecycle 是 mesh 模块的生命周期契约（桌面版与 CLI 共用）。
//
// Phase 3a 只定义接口；Phase 3b 实现内部协议栈（WSS 连接 / Noise 握手 /
// 打洞 / 选路 / 数据面收发），并接入 TunDevice。
type Lifecycle interface {
	// Start 启动组网（建立 WSS 到盲中继、握手、打洞、选路、起数据面）。
	// 需要管理员/root（TUN）；调用方负责提权引导。
	Start(ctx context.Context) error
	// Stop 停止组网并清理（关闭连接、释放 TUN、恢复路由）。
	Stop() error
	// Status 返回当前状态快照（供本地控制 API / 托盘 / CLI 消费）。
	Status() Status
}

// Status 是组网状态快照（插件边界的数据契约）。
//
// 字段刻意保持精简且与协议无关：Phase 3b 内部实现变化时，
// 这份对外快照尽量稳定，避免 UI / CLI 跟着改。
type Status struct {
	Running   bool   `json:"running"`
	NodeID    string `json:"nodeId,omitempty"`
	VirtualIP string `json:"virtualIp,omitempty"`
	Network   string `json:"network,omitempty"`
	// NatType / Reflexive 是 STUN 探测结果（Unknown / NAT3 / NAT4 + 公网映射）。
	NatType   string `json:"natType,omitempty"`
	Reflexive string `json:"reflexive,omitempty"`
	// Reflexive6 是 IPv6 反射地址（无 NAT 时即本机全球地址，免映射直连依据）。
	Reflexive6 string `json:"reflexive6,omitempty"`
	// Listen 是 UDP 监听地址；排查「对端连不到我」时第一眼看它。
	Listen    string `json:"listen,omitempty"`
	Peers     []Peer `json:"peers,omitempty"`
	UptimeSec int64  `json:"uptimeSec,omitempty"`

	// 帧计数：用户能据此判断「到底有没有在收发」，而不是干等。
	TXFrames    uint64 `json:"txFrames"`
	RXFrames    uint64 `json:"rxFrames"`
	TXDropped   uint64 `json:"txDropped"`
	RXDropped   uint64 `json:"rxDropped"`
	HandshakeOK uint64 `json:"handshakeOk"`

	Note string `json:"note,omitempty"`
}

// Peer 是对等节点快照（插件边界数据契约）。
type Peer struct {
	NodeID    string `json:"nodeId"`
	VirtualIP string `json:"virtualIp,omitempty"`
	// Name 是对端设备名（云监测台 alias / gossip 描述符名）；没有时为空。
	Name string `json:"name,omitempty"`
	// Addr 是对端 UDP 地址（配置值，或从首帧学到的实际地址）。
	Addr string `json:"addr,omitempty"`
	// State 是给人看的状态：已连接 / 握手中 / 等待对端。
	State  string `json:"state,omitempty"`
	Online bool   `json:"online"`
	Via    string `json:"via,omitempty"` // "udp" / "wss"
	RTTMs  int64  `json:"rttMs,omitempty"`
	// PunchState / PunchKind 给界面显示持续的打洞进度：
	// state = idle / probing / retrying / direct / failed；
	// kind = ipv6 / stun / host / port-predict / wss。
	PunchState string `json:"punchState,omitempty"`
	PunchKind  string `json:"punchKind,omitempty"`
	// LossRate 只在样本足够（≥5）时才有意义，否则为 0。
	LossRate float64 `json:"lossRate"`
}

// ErrStub 表示调用到了 Phase 3b 才实现的方法（骨架阶段显式报错，不静默成功）。
var ErrStub = fmt.Errorf("mesh: 协议实现待 Phase 3b，当前为工程骨架")
