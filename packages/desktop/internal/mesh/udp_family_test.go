//go:build mesh

package mesh

import (
	"testing"
)

// 真机回归：`Listen=0.0.0.0:51820` + `DisableListenDual=true` 曾仍绑 `[::]:51820`，
// 因为 net.ListenUDP("udp", 通配地址) 在支持 v4-mapped 的平台上总是建 AF_INET6 双栈
// socket。disableListenDual 必须真的落到 udp4 上。
func TestDisableListenDualBindsIPv4Only(t *testing.T) {
	hub, err := NewUdpHubWithDual("0.0.0.0:0", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	if hub.socketIsV6 {
		t.Fatalf("关双栈后仍是 IPv6 socket：listen=%s", hub.LocalAddr())
	}
	if a := hub.LocalAddr(); a.IP.To4() == nil {
		t.Fatalf("应绑 IPv4 通配，实际 %s", a)
	}
	if !hub.acceptsFamily(true) || hub.acceptsFamily(false) {
		t.Fatalf("IPv4 单栈 socket 的地址族判定错误：v4=%v v6=%v",
			hub.acceptsFamily(true), hub.acceptsFamily(false))
	}
}

func TestDefaultListenBindsDualStack(t *testing.T) {
	hub, err := NewUdpHubWithDual("0.0.0.0:0", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Close()
	if !hub.socketIsV6 {
		t.Skipf("本机不支持双栈 v6 socket，跳过：listen=%s", hub.LocalAddr())
	}
	if !hub.dualStack || !hub.acceptsFamily(true) || !hub.acceptsFamily(false) {
		t.Fatalf("双栈 socket 应同时接受 v4/v6：listen=%s dual=%v", hub.LocalAddr(), hub.dualStack)
	}
}

func TestAcceptsFamilyMatrix(t *testing.T) {
	cases := []struct {
		name string
		hub  *UdpHub
		v4   bool
		v6   bool
	}{
		{"无 hub（旧行为）", nil, true, true},
		{"IPv4 单栈", &UdpHub{socketIsV6: false}, true, false},
		{"IPv6 双栈", &UdpHub{socketIsV6: true, dualStack: true}, true, true},
		{"IPv6 单栈", &UdpHub{socketIsV6: true}, false, true},
	}
	for _, tc := range cases {
		if got := tc.hub.acceptsFamily(true); got != tc.v4 {
			t.Fatalf("%s: acceptsFamily(v4)=%v，期望 %v", tc.name, got, tc.v4)
		}
		if got := tc.hub.acceptsFamily(false); got != tc.v6 {
			t.Fatalf("%s: acceptsFamily(v6)=%v，期望 %v", tc.name, got, tc.v6)
		}
	}
}

// 候选与 punch 标签都必须跟着 socket 地址族走：IPv4-only 的 socket 若带上 IPv6
// 候选，探针发不出去，状态还会显示 punch=retrying/ipv6。
func TestLocalCandidatesFollowSocketFamily(t *testing.T) {
	v4hub, err := NewUdpHubWithDual("0.0.0.0:0", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer v4hub.Close()
	m := &meshLifecycle{cfg: Config{Listen: "0.0.0.0:0", VirtualIP: "10.97.0.1"}}
	m.hub = v4hub
	m.nat = NatAssessment{Reflexive: "1.2.3.4:5678", Reflexive6: "[2606:4700::1111]:5678"}
	cands := m.localCandidates()
	if len(cands) == 0 {
		t.Fatal("IPv4 socket 至少应有反射候选")
	}
	for _, c := range cands {
		a := candidateUDP(c)
		if a == nil || a.IP.To4() == nil {
			t.Fatalf("IPv4 socket 出现非 v4 候选：%v", c)
		}
	}
	if kind := punchKindForCandidates(cands); kind != "stun" {
		t.Fatalf("IPv4 socket 的 punch 标签应为 stun，实际 %q（候选 %d 个）", kind, len(cands))
	}

	v6hub, err := NewUdpHubWithDual("[::1]:0", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer v6hub.Close()
	if v6hub.acceptsFamily(true) {
		t.Fatalf("IPv6 单栈 socket 不应接受 v4：listen=%s", v6hub.LocalAddr())
	}
	m.hub = v6hub
	for _, c := range m.localCandidates() {
		if a := candidateUDP(c); a != nil && a.IP.To4() != nil {
			t.Fatalf("IPv6 单栈 socket 出现 v4 候选：%v", a)
		}
	}
}
