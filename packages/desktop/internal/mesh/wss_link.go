package mesh

import (
	"context"
	"fmt"
	"net"
	"sync"
)

// WssLink 把 WsConn 适配为 PeerLink（对齐 MobiHop ws.rs:446-587 的 WsLink<S>）。
//
// WSS 经盲中继房间转发，所以：
//   - IsRelayed() = true（经中继的只出不进腿；入站由房间内其它连接接收）
//   - PeerAddr() = nil（无对端 UDP 地址）
//   - SendProbe = Send（无双入口，探测帧走同一 WSS）
//
// 注意：盲中继按 SNI 转发 + 房间扇出，Worker 不终结 E2E；Session 与链路无关，
// 所以 UDP↔WSS 切换只换本适配器，不动 Session（对齐 node.rs:2429）。
type WssLink struct {
	baseLink
	conn *WsConn
	url  *WsUrl

	mu            sync.Mutex
	ingressDirect bool // WSS 链路恒为 false（非直连入口）
	demoted       bool
}

// NewWssLink 从已建立的 WsConn 构造 PeerLink。
func NewWssLink(conn *WsConn) *WssLink {
	return &WssLink{conn: conn, url: conn.url}
}

func (l *WssLink) Send(ctx context.Context, frame []byte) error {
	if len(frame) > MaxFrame {
		return fmt.Errorf("mesh wss: 帧 %d 超过 %d", len(frame), MaxFrame)
	}
	return l.conn.SendFrame(ctx, frame)
}

func (l *WssLink) SendProbe(ctx context.Context, frame []byte) error { return l.Send(ctx, frame) }

func (l *WssLink) Recv(ctx context.Context) ([]byte, error) { return l.conn.RecvFrame(ctx) }

func (l *WssLink) PeerAddr() *net.UDPAddr { return nil }

func (l *WssLink) IsRelayed() bool { return true } // 经盲中继房间

func (l *WssLink) HasFallback() bool {
	// WSS 链路本身无中继兜底（它已经是兜底）；是否有 UDP 兜底由上层决定。
	return false
}

func (l *WssLink) DemoteDirect() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.demoted {
		return false
	}
	l.demoted = true
	l.ingressDirect = false
	return true
}

func (l *WssLink) LastIngressDirect() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.ingressDirect
}

func (l *WssLink) Close() error { return l.conn.Close() }
