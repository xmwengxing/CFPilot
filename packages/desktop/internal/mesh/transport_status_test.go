//go:build mesh

package mesh

import (
	"net"
	"testing"
)

func TestPeerTransportNameReportsActualLink(t *testing.T) {
	if got := peerTransportName(&WssRoomPeer{}); got != "wss" {
		t.Fatalf("WSS peer via = %q, want wss", got)
	}
	udpRelay := &hubLink{relayed: true, addr: &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 51820}}
	if got := peerTransportName(udpRelay); got != "relay" {
		t.Fatalf("UDP relay via = %q, want relay", got)
	}
	if got := peerTransportName(&fakeRelayLink{}); got != "udp4" {
		t.Fatalf("direct peer via = %q, want udp4", got)
	}
	if got := peerTransportName(&addrLink{addr: &net.UDPAddr{IP: net.ParseIP("2001:db8::1"), Port: 51820}}); got != "udp6" {
		t.Fatalf("IPv6 peer via = %q, want udp6", got)
	}
}
