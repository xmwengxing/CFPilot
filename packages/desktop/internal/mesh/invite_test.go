package mesh

import (
	"encoding/base64"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"
)

func TestInviteRoundTrip(t *testing.T) {
	p := InvitePayload{
		Network:   "my-home",
		PSK:       "secret123456",
		Addr:      "10.0.0.1:51820",
		NodeID:    "0100000000000001",
		TunnelPub: strings.Repeat("ab", 32),
		VirtualIP: "10.97.0.1",
		Suggested: "10.97.0.2",
	}
	uri, err := BuildInvite(p, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(uri, InviteURIPrefix) {
		t.Errorf("链接前缀错误: %s", uri[:40])
	}
	got, err := ParseInvite(uri)
	if err != nil {
		t.Fatal(err)
	}
	if got.Network != p.Network || got.PSK != p.PSK || got.NodeID != p.NodeID || got.Addr != p.Addr {
		t.Errorf("往返字段不符: %+v", got)
	}
}

func TestInviteExpired(t *testing.T) {
	p := InvitePayload{Network: "n", PSK: "p"}
	uri, err := BuildInvite(p, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseInvite(uri); err != nil {
		t.Errorf("永久链接应可解析: %v", err)
	}
	// 手动构造已过期链接
	p.V = 1
	p.Exp = time.Now().Unix() - 10
	raw, _ := json.Marshal(p)
	expiredURI := InviteURIPrefix + base64.RawURLEncoding.EncodeToString(raw)
	if _, err := ParseInvite(expiredURI); err == nil || !strings.Contains(err.Error(), "过期") {
		t.Errorf("过期链接应被拒绝: %v", err)
	}
}

func TestInviteRejectsBad(t *testing.T) {
	for _, uri := range []string{
		"not-an-invite",
		InviteURIPrefix + "!!!bad-base64!!!",
		InviteURIPrefix + base64.RawURLEncoding.EncodeToString([]byte(`{"v":99}`)),
	} {
		if _, err := ParseInvite(uri); err == nil {
			t.Errorf("非法链接应被拒绝: %s", uri[:40])
		}
	}
}

func TestSensitiveWarning(t *testing.T) {
	w := SensitiveWarning()
	if !strings.Contains(w, "密钥") || !strings.Contains(w, "公开") {
		t.Errorf("敏感提示应包含密钥与公开警告: %s", w)
	}
}

// 建议对端虚拟 IP 必须落在**同一 /24**（生链接时自动顺延最后一段）。
// 这条守护「不同网段」的错误模型不再回来：TUN 固定 /24，跨网段默认不可达。
func TestBuildInviteSuggestsSameSubnet(t *testing.T) {
	p := InvitePayload{
		Network: "n", PSK: "s", NodeID: "0100000000000001",
		VirtualIP: "10.97.0.1",
	}
	uri, err := BuildInvite(p, 0)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseInvite(uri)
	if err != nil {
		t.Fatal(err)
	}
	if got.Suggested != "10.97.0.2" {
		t.Errorf("建议 IP = %q, 期望 10.97.0.2（同网段、末位顺延）", got.Suggested)
	}

	// 末位已到 254 时不能生成 .255（广播地址）
	p2 := InvitePayload{Network: "n", PSK: "s", VirtualIP: "10.97.0.254"}
	uri2, _ := BuildInvite(p2, 0)
	got2, _ := ParseInvite(uri2)
	if got2.Suggested == "10.97.0.255" || got2.Suggested == "" {
		t.Errorf("末位回绕不正确: %q", got2.Suggested)
	}
}

func TestReachableInterfaceFilters(t *testing.T) {
	for _, name := range []string{"cfpilot0", "easytier0", "Wintun", "vEthernet", "vmnet1"} {
		if reachableInterfaceName(name) {
			t.Errorf("虚拟网卡 %q 不应作为邀请地址来源", name)
		}
	}
	for _, name := range []string{"Ethernet", "以太网", "en0", "ens33"} {
		if !reachableInterfaceName(name) {
			t.Errorf("物理网卡 %q 被误排除", name)
		}
	}
	if reachableInterface(net.ParseIP("127.0.0.1")) || reachableInterface(net.ParseIP("100.64.1.2")) {
		t.Error("回环/CGNAT 地址不应作为对端地址")
	}
}

func TestBuildInviteKeepsExplicitAddr(t *testing.T) {
	p := InvitePayload{Network: "n", PSK: "s", Addr: "1.2.3.4:51820", VirtualIP: "10.97.0.1"}
	uri, err := BuildInvite(p, 0)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := ParseInvite(uri)
	if got.Addr != "1.2.3.4:51820" {
		t.Errorf("用户填写的具体地址不应被替换，实际 %q", got.Addr)
	}
}

func TestBuildInviteReplacesWildcardAddr(t *testing.T) {
	p := InvitePayload{Network: "n", PSK: "s", Addr: "0.0.0.0:51820", VirtualIP: "10.97.0.1"}
	uri, err := BuildInvite(p, 0)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := ParseInvite(uri)
	if strings.HasPrefix(got.Addr, "0.0.0.0:") {
		t.Skip("本机没有可用的非回环 IPv4，跳过（真实机器上应被替换）")
	}
	if !strings.Contains(got.Addr, ":51820") {
		t.Errorf("端口应保持不变: %q", got.Addr)
	}
}

func TestInviteCarriesMonitorConfig(t *testing.T) {
	p := InvitePayload{
		Network: "n", PSK: "s", VirtualIP: "10.97.0.1",
		MonitorEndpoint:   "https://monitor.example.com",
		MonitorToken:      "monitor-token-123",
		MonitorIntervalMS: 15000,
		MonitorAlias:      "joined-node",
	}
	uri, err := BuildInvite(p, 0)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseInvite(uri)
	if err != nil {
		t.Fatal(err)
	}
	if got.MonitorEndpoint != p.MonitorEndpoint || got.MonitorToken != p.MonitorToken {
		t.Errorf("监测地址/令牌未随邀请链接传递: %+v", got)
	}
	if got.MonitorIntervalMS != 15000 || got.MonitorAlias != "joined-node" {
		t.Errorf("监测间隔/设备名未传递: %+v", got)
	}
}
