package mesh

import (
	"context"
	"net"
)

// PeerLink 是到单个对端的原始帧收发链路（对齐 MobiHop link.rs:16-83）。
//
// 帧为完整线速报文（32B 头 + 载荷）；中继只读头、零拷贝转发，绝不解密。
// Go 版最小集：Send/Recv/PeerAddr/Close + 降级相关默认方法（阶段 2 充实）。
type PeerLink interface {
	// Send 向对端发送一个完整帧。
	Send(ctx context.Context, frame []byte) error
	// SendProbe 发送探测帧（默认等同 Send；阶段 2 双入口链路特化）。
	SendProbe(ctx context.Context, frame []byte) error
	// Recv 从对端接收一个完整帧（阻塞至有帧/链路关闭）。
	Recv(ctx context.Context) ([]byte, error)
	// PeerAddr 对端传输层地址（用于失效清理；无地址返回 nil）。
	PeerAddr() *net.UDPAddr
	// IsRelayed 是否经中继的只出不进腿（阶段 2 用）。
	IsRelayed() bool
	// HasFallback 是否已有中继兜底（阶段 2 用）。
	HasFallback() bool
	// DemoteDirect 让双入口链路放弃直连（阶段 2 用）；返回是否真降级。
	DemoteDirect() bool
	// LastIngressDirect 最近一帧是否从直连入口进来（阶段 2 用）。
	LastIngressDirect() bool
	// Close 关闭链路。
	Close() error
}

// baseLink 提供 PeerLink 的默认降级相关方法（嵌入到具体链路实现）。
// SendProbe 由具体链路实现为等同 Send，不在此提供。
type baseLink struct{}

func (baseLink) PeerAddr() *net.UDPAddr  { return nil }
func (baseLink) IsRelayed() bool         { return false }
func (baseLink) HasFallback() bool       { return false }
func (baseLink) DemoteDirect() bool      { return false }
func (baseLink) LastIngressDirect() bool { return true }
