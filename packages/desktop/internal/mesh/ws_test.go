package mesh

import (
	"context"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestParseWsUrl(t *testing.T) {
	u, err := ParseWsUrl("wss://relay.example.com/mesh/0123456789abcdef?peer_id=0011223344556677")
	if err != nil {
		t.Fatal(err)
	}
	if u.Host != "relay.example.com" || u.Port != 443 {
		t.Errorf("host/port = %s/%d", u.Host, u.Port)
	}
	if u.Path != "/mesh/0123456789abcdef" {
		t.Errorf("path = %s", u.Path)
	}
	if u.RawQuery != "peer_id=0011223344556677" {
		t.Errorf("query = %s", u.RawQuery)
	}

	// 显式端口
	u2, err := ParseWsUrl("wss://relay.example.com:8443/mesh/abc")
	if err != nil || u2.Port != 8443 {
		t.Errorf("显式端口解析失败: %v, %+v", err, u2)
	}

	// 拒绝 ws://
	if _, err := ParseWsUrl("ws://relay.example.com"); err == nil {
		t.Error("ws:// 应被拒绝")
	}
	// 拒绝空 host
	if _, err := ParseWsUrl("wss:///path"); err == nil {
		t.Error("空 host 应被拒绝")
	}
}

func TestConnectIPTarget(t *testing.T) {
	u, _ := ParseWsUrl("wss://relay.example.com:8443/mesh/abc")
	if got := u.tcpTarget(); got != "relay.example.com:8443" {
		t.Errorf("tcpTarget = %s", got)
	}
	withIP := u.WithConnectIP("198.51.100.7")
	if got := withIP.tcpTarget(); got != "198.51.100.7:8443" {
		t.Errorf("connect_ip tcpTarget = %s", got)
	}
	// 原域名不变（SNI/Host 用）
	if withIP.Host != "relay.example.com" {
		t.Errorf("connect_ip 不应改变原 host: %s", withIP.Host)
	}
}

func TestRelayRoomURL(t *testing.T) {
	url, err := RelayRoomURL("relay.example.com", "0123456789abcdef", "0011223344556677")
	if err != nil {
		t.Fatal(err)
	}
	if url != "wss://relay.example.com/mesh/0123456789abcdef?peer_id=0011223344556677" {
		t.Errorf("url = %s", url)
	}
	// 非法 hash
	for _, bad := range []string{"abc", "UPPERCASE", "xyz!@#$"} {
		if _, err := RelayRoomURL("x", bad, "0011223344556677"); err == nil {
			t.Errorf("非法 network_hash %q 应被拒绝", bad)
		}
	}
	// 非法 peer_id
	if _, err := RelayRoomURL("x", "0123456789abcdef", "short"); err == nil {
		t.Error("非法 peer_id 应被拒绝")
	}
}

func TestRelayRoomURLFromDeploymentTemplateUsesNetworkDerivedRoom(t *testing.T) {
	psk := DerivePSK("home", "shared-secret")
	tag := DeriveRoomTag(psk)
	expectedHash := hex.EncodeToString(tag[:])
	gotHash := ResolveRelayRoomHash("<network_hash>", psk)
	if gotHash != expectedHash {
		t.Fatalf("template room hash = %q, expected %q", gotHash, expectedHash)
	}
	got, err := RelayRoomURL("relay.example.com", gotHash, "0011223344556677")
	if err != nil {
		t.Fatal(err)
	}
	expected := fmt.Sprintf("wss://relay.example.com/mesh/%s?peer_id=0011223344556677", expectedHash)
	if got != expected {
		t.Fatalf("deployment template URL = %q, expected network-derived room %q", got, expected)
	}
}

func TestDialWssCancelsWhileWaitingForUpgrade(t *testing.T) {
	received := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		close(received)
		select {
		case <-request.Context().Done():
		case <-release:
		}
	}))
	defer server.Close()
	defer close(release)
	endpoint, err := ParseWsUrl("wss" + strings.TrimPrefix(server.URL, "https") + "/mesh")
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		conn, err := DialWss(ctx, endpoint, roots)
		if conn != nil {
			_ = conn.Close()
		}
		result <- err
	}()
	select {
	case <-received:
	case <-time.After(3 * time.Second):
		t.Fatal("未收到 HTTP Upgrade 请求")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("期望取消，实际错误 %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("取消后仍在等待 HTTP Upgrade")
	}
}

// TestFrameOverWebSocket 验证 1 WS Binary 消息 = 1 帧（契约 §6.3）。
// 用本地 httptest WS 服务回显，验证帧边界不丢。
func TestFrameOverWebSocket(t *testing.T) {
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		for {
			typ, data, err := c.ReadMessage()
			if err != nil {
				return
			}
			if typ != websocket.BinaryMessage {
				continue
			}
			if err := c.WriteMessage(websocket.BinaryMessage, data); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/echo" // wss→ws 测试用
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	f := sampleFrame()
	f.Type = MsgData
	f.Flags = FlagEncrypted
	frameBytes, _ := f.Encode()

	if err := c.WriteMessage(websocket.BinaryMessage, frameBytes); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	typ, got, err := c.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if typ != websocket.BinaryMessage {
		t.Errorf("回显类型 = %d", typ)
	}
	decoded, err := Decode(got)
	if err != nil {
		t.Fatalf("回显帧解码失败: %v", err)
	}
	if decoded.Type != f.Type || decoded.Counter != f.Counter {
		t.Errorf("回显帧字段不符: %+v", decoded)
	}
}
