//go:build mesh

package mesh

import (
	"net"
	"testing"
)

func TestPeerTransportNamePrefersWSSOverGenericRelay(t *testing.T) {
	link := &fakeRelayLink{relayed: true}
	if got := peerTransportName(link, TransportWSS); got != "wss" {
		t.Fatalf("WSS peer via = %q, want wss", got)
	}
	if got := peerTransportName(link, TransportUDP); got != "relay" {
		t.Fatalf("UDP peer via = %q, want relay", got)
	}
	if got := peerTransportName(&fakeRelayLink{}, TransportUDP); got != "udp4" {
		t.Fatalf("direct peer via = %q, want udp4", got)
	}
	if got := peerTransportName(&addrLink{addr: &net.UDPAddr{IP: net.ParseIP("240e::1"), Port: 51820}}, TransportUDP); got != "udp6" {
		t.Fatalf("IPv6 peer via = %q, want udp6", got)
	}
}
