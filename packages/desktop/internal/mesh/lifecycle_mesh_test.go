//go:build mesh

package mesh

import (
	"bytes"
	"context"
	"encoding/hex"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type lifecycleTestTun struct {
	toMesh, fromMesh chan []byte
	closed           chan struct{}
	once             sync.Once
}

func newLifecycleTestTun() *lifecycleTestTun {
	return &lifecycleTestTun{toMesh: make(chan []byte, 1), fromMesh: make(chan []byte, 1), closed: make(chan struct{})}
}

func (tun *lifecycleTestTun) Name() string { return "test-tun" }

func (tun *lifecycleTestTun) Recv(ctx context.Context) ([]byte, error) {
	select {
	case packet := <-tun.toMesh:
		return packet, nil
	case <-tun.closed:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (tun *lifecycleTestTun) Send(ctx context.Context, packet []byte) error {
	select {
	case tun.fromMesh <- append([]byte(nil), packet...):
		return nil
	case <-tun.closed:
		return io.ErrClosedPipe
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (tun *lifecycleTestTun) Close() error {
	tun.once.Do(func() { close(tun.closed) })
	return nil
}

type lifecycleTestRelayConn struct {
	*memoryWsConn
	other      *memoryWsConn
	allowPunch *atomic.Bool
}

func (conn *lifecycleTestRelayConn) SendFrame(ctx context.Context, raw []byte) error {
	frame, err := Decode(raw)
	if err != nil {
		return err
	}
	if frame.Type == MsgHolePunch && !conn.allowPunch.Load() {
		return nil
	}
	select {
	case conn.other.in <- append([]byte(nil), raw...):
		return nil
	case <-conn.closed:
		return io.ErrClosedPipe
	case <-conn.other.closed:
		return io.ErrClosedPipe
	case <-ctx.Done():
		return ctx.Err()
	}
}

func lifecycleTestIdentity(t *testing.T, seed byte) *Identity {
	t.Helper()
	id, err := IdentityFromSeeds([32]byte{seed}, [32]byte{seed + 32})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func lifecycleTestConfig(id *Identity, ip string) Config {
	return Config{
		NodeID:        id.NodeID,
		NetworkName:   "mesh-integration",
		PSK:           "integration-test-key",
		IdentitySeed:  id.IdentitySeed[:],
		TunnelPrivate: id.TunnelSeed[:],
		Listen:        "127.0.0.1:0",
		VirtualIP:     ip,
		RelayDomain:   "relay.test",
		StunServers:   []string{},
	}
}

func stopLifecycleWithin(t *testing.T, lifecycle *meshLifecycle) {
	t.Helper()
	stopped := make(chan error, 1)
	go func() { stopped <- lifecycle.Stop() }()
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("组网停止未能及时完成")
	}
}

func TestMeshLifecycleStartsAndStopsWithBlockedRoomDial(t *testing.T) {
	lifecycle := &meshLifecycle{cfg: lifecycleTestConfig(lifecycleTestIdentity(t, 11), "10.97.0.1"), tunOverride: newLifecycleTestTun()}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	t.Cleanup(func() { stopLifecycleWithin(t, lifecycle) })
	dialed := make(chan struct{})
	started := make(chan error, 1)
	go func() {
		started <- lifecycle.start(ctx, func(dialCtx context.Context) (*WssRoom, error) {
			close(dialed)
			<-dialCtx.Done()
			return nil, dialCtx.Err()
		})
	}()
	select {
	case <-dialed:
	case <-time.After(2 * time.Second):
		t.Fatal("未尝试连接中继")
	}
	select {
	case err := <-started:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("启动仍在等待盲中继")
	}
	if !lifecycle.Status().Running {
		t.Fatal("中继连接期间本地组网应已就绪")
	}
	stopLifecycleWithin(t, lifecycle)
	if lifecycle.Status().Running {
		t.Fatal("组网停止后仍报告在运行")
	}
}

func TestMeshLifecycleOneWayInviteRelaysAndPromotesBothPeers(t *testing.T) {
	stun, stunAddr := startFakeStun(t)
	defer stun.Close()
	sink, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer sink.Close()
	inviterID, joinerID := lifecycleTestIdentity(t, 12), lifecycleTestIdentity(t, 13)
	if lessNodeID(joinerID.NodeID, inviterID.NodeID) {
		inviterID, joinerID = joinerID, inviterID
	}
	inviterCfg := lifecycleTestConfig(inviterID, "10.97.0.1")
	link, err := BuildInvite(InvitePayload{
		Network: inviterCfg.NetworkName, PSK: inviterCfg.PSK, Addr: sink.LocalAddr().String(),
		NodeID: inviterID.NodeID.Hex(), TunnelPub: hex.EncodeToString(inviterID.TunnelPub),
		VirtualIP: inviterCfg.VirtualIP, RelayDomain: inviterCfg.RelayDomain,
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	invite, err := ParseInvite(link)
	if err != nil {
		t.Fatal(err)
	}
	inviterPeerID, err := ParseNodeIDHex(invite.NodeID)
	if err != nil {
		t.Fatal(err)
	}
	inviterPub, err := hex.DecodeString(invite.TunnelPub)
	if err != nil {
		t.Fatal(err)
	}
	joinerCfg := lifecycleTestConfig(joinerID, invite.Suggested)
	joinerCfg.NetworkName, joinerCfg.PSK, joinerCfg.RelayDomain = invite.Network, invite.PSK, invite.RelayDomain
	joinerCfg.Peers = []PeerConfig{{NodeID: inviterPeerID, Addr: invite.Addr, StaticPub: inviterPub, VirtualIP: invite.VirtualIP}}
	inviterCfg.StunServers, joinerCfg.StunServers = []string{stunAddr}, []string{stunAddr}
	inviterTun, joinerTun := newLifecycleTestTun(), newLifecycleTestTun()
	inviter := &meshLifecycle{cfg: inviterCfg, tunOverride: inviterTun}
	joiner := &meshLifecycle{cfg: joinerCfg, tunOverride: joinerTun}

	allowPunch := new(atomic.Bool)
	inviterConn, joinerConn := newMemoryWsConn(), newMemoryWsConn()
	inviterRoom := NewWssRoom(&lifecycleTestRelayConn{inviterConn, joinerConn, allowPunch}, inviterID.NodeID)
	joinerRoom := NewWssRoom(&lifecycleTestRelayConn{joinerConn, inviterConn, allowPunch}, joinerID.NodeID)
	if err := inviter.start(t.Context(), func(context.Context) (*WssRoom, error) { return inviterRoom, nil }); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopLifecycleWithin(t, inviter) })
	if err := joiner.start(t.Context(), func(context.Context) (*WssRoom, error) { return joinerRoom, nil }); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopLifecycleWithin(t, joiner) })

	waitForMeshPeerTransports(t, inviter, joiner, "wss")
	toJoiner := v4Packet([4]byte{10, 97, 0, 1}, [4]byte{10, 97, 0, 2})
	toInviter := v4Packet([4]byte{10, 97, 0, 2}, [4]byte{10, 97, 0, 1})
	assertMeshPacket(t, inviterTun, joinerTun, toJoiner)
	assertMeshPacket(t, joinerTun, inviterTun, toInviter)
	allowPunch.Store(true)

	waitForMeshPeerTransports(t, inviter, joiner, "udp4")
	if err := inviterRoom.Close(); err != nil {
		t.Fatal(err)
	}
	if err := joinerRoom.Close(); err != nil {
		t.Fatal(err)
	}
	assertMeshPacket(t, inviterTun, joinerTun, toJoiner)
	assertMeshPacket(t, joinerTun, inviterTun, toInviter)
}

func waitForMeshPeerTransports(t *testing.T, inviter, joiner *meshLifecycle, via string) {
	t.Helper()
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		inviterStatus, joinerStatus := inviter.Status(), joiner.Status()
		matches := func(status Status, vip string) bool {
			return status.HandshakeOK != 0 && len(status.Peers) == 1 && status.Peers[0].Online &&
				status.Peers[0].VirtualIP == vip && status.Peers[0].Via == via
		}
		if matches(inviterStatus, joinerStatus.VirtualIP) && matches(joinerStatus, inviterStatus.VirtualIP) {
			return
		}
		select {
		case <-tick.C:
		case <-deadline.C:
			t.Fatalf("两端未切换到 %s\n邀请方: %+v\n受邀方: %+v", via, inviterStatus, joinerStatus)
		}
	}
}

func assertMeshPacket(t *testing.T, from, to *lifecycleTestTun, packet []byte) {
	t.Helper()
	from.toMesh <- packet
	select {
	case received := <-to.fromMesh:
		if !bytes.Equal(received, packet) {
			t.Fatalf("待转发包 %x，接收包 %x", packet, received)
		}
	case <-time.After(time.Second):
		t.Fatal("未接收到对端隧道包")
	}
}
