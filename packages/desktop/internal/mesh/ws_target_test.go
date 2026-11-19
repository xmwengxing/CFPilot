//go:build mesh

package mesh

import "testing"

// connect_ip 允许带端口：第三方反代入口常监听非 443 端口。
// 旧实现硬拼 w.Port，填 IP:port 会拼出 "1.2.3.4:8443:443" 这种非法地址。
func TestTcpTargetConnectIPWithPort(t *testing.T) {
	cases := []struct {
		name      string
		host      string
		connectIP string
		want      string
	}{
		{"无 connect_ip 用域名", "relay.example.com", "", "relay.example.com:443"},
		{"裸 IPv4 用默认端口", "relay.example.com", "1.2.3.4", "1.2.3.4:443"},
		{"IPv4 带端口", "relay.example.com", "1.2.3.4:8443", "1.2.3.4:8443"},
		{"反代常见端口 2053", "relay.example.com", "1.2.3.4:2053", "1.2.3.4:2053"},
		{"IPv6 字面量", "relay.example.com", "2606:4700::1", "[2606:4700::1]:443"},
		{"IPv6 带端口需方括号", "relay.example.com", "[2606:4700::1]:2096", "[2606:4700::1]:2096"},
	}
	for _, c := range cases {
		w := &WsUrl{Host: c.host, Port: 443}
		if c.connectIP != "" {
			w = w.WithConnectIP(c.connectIP)
		}
		if got := w.tcpTarget(); got != c.want {
			t.Errorf("%s: tcpTarget() = %q, 期望 %q", c.name, got, c.want)
		}
	}
}
