package mesh

import (
	"encoding/base64"
	"encoding/json"
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
