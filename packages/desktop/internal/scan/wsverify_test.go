package scan

// E1 回归测试：桌面版 PONG 内容校验与 VLESS/Trojan 隧道校验。
//
// 用本地原始 TLS listener 模拟数据面：它能精确控制「101 之后回什么帧」，
// 这是 http.Server 的 Handler 做不到的。不依赖外网。

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"
)

// ------------------------------------------------------------------
// 测试用原始 TLS 服务器
// ------------------------------------------------------------------

// newRawTLSServer 起一个自签 TLS listener，每个连接交给 handle 自行读写。
func newRawTLSServer(t *testing.T, handle func(conn net.Conn)) *testServer {
	t.Helper()
	cert := selfSignedCert(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	tlsLn := tls.NewListener(ln, &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"http/1.1"},
		MinVersion:   tls.VersionTLS12,
	})
	go func() {
		for {
			c, err := tlsLn.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = c.Close() }()
				handle(c)
			}()
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return &testServer{Addr: addr.IP.String(), Port: addr.Port, stop: func() { _ = ln.Close() }}
}

// readRequestHead 读到一个完整的 HTTP 请求头结束。
func readRequestHead(r *bufio.Reader) bool {
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return false
		}
		if line == "\r\n" || line == "\n" {
			return true
		}
	}
}

// readClientFrame 从测试服务器侧解一个客户端帧（必须带掩码）。
func readClientFrame(r *bufio.Reader) (opcode byte, payload []byte, ok bool) {
	head := make([]byte, 2)
	if _, err := readFull(r, head); err != nil {
		return 0, nil, false
	}
	opcode = head[0] & 0x0f
	masked := head[1]&0x80 != 0
	n := uint64(head[1] & 0x7f)
	switch n {
	case 126:
		ext := make([]byte, 2)
		if _, err := readFull(r, ext); err != nil {
			return 0, nil, false
		}
		n = uint64(binary.BigEndian.Uint16(ext))
	case 127:
		ext := make([]byte, 8)
		if _, err := readFull(r, ext); err != nil {
			return 0, nil, false
		}
		n = binary.BigEndian.Uint64(ext)
	}
	if n > 1<<20 {
		return 0, nil, false
	}
	var mask []byte
	if masked {
		mask = make([]byte, 4)
		if _, err := readFull(r, mask); err != nil {
			return 0, nil, false
		}
	}
	data := make([]byte, int(n))
	if _, err := readFull(r, data); err != nil {
		return 0, nil, false
	}
	if masked {
		for i := range data {
			data[i] ^= mask[i%4]
		}
	}
	return opcode, data, true
}

func readFull(r *bufio.Reader, b []byte) (int, error) {
	got := 0
	for got < len(b) {
		n, err := r.Read(b[got:])
		got += n
		if err != nil {
			return got, err
		}
	}
	return got, nil
}

// serverFrame 构造服务端帧（不带掩码）。
func serverFrame(opcode byte, payload []byte) []byte {
	out := make([]byte, 0, 10+len(payload))
	if len(payload) < 126 {
		out = append(out, 0x80|opcode, byte(len(payload)))
	} else {
		out = append(out, 0x80|opcode, 126, 0, 0)
		binary.BigEndian.PutUint16(out[len(out)-2:], uint16(len(payload)))
	}
	return append(out, payload...)
}

const upgrade101 = "HTTP/1.1 101 Switching Protocols\r\n" +
	"Upgrade: websocket\r\nConnection: Upgrade\r\nCf-Ray: abcdef-NRT\r\n\r\n"

// ------------------------------------------------------------------
// 帧编解码
// ------------------------------------------------------------------

func TestEncodeClientFrameIsMasked(t *testing.T) {
	for _, size := range []int{4, 200, 70000} {
		payload := make([]byte, size)
		for i := range payload {
			payload[i] = byte(i % 251)
		}
		frame, err := encodeClientFrame(payload, 0x01)
		if err != nil {
			t.Fatalf("size=%d: %v", size, err)
		}
		if frame[0]&0x0f != 0x01 || frame[0]&0x80 == 0 {
			t.Fatalf("size=%d: FIN/opcode 错误 %08b", size, frame[0])
		}
		if frame[1]&0x80 == 0 {
			t.Fatalf("size=%d: 客户端帧必须掩码", size)
		}
		// 掩码还原后必须与原 payload 一致
		_, decoded, ok := readClientFrame(bufio.NewReader(strings.NewReader(string(frame))))
		if !ok {
			t.Fatalf("size=%d: 帧无法解析", size)
		}
		if string(decoded) != string(payload) {
			t.Fatalf("size=%d: 掩码还原不一致", size)
		}
	}
}

func TestDecodeServerFrame(t *testing.T) {
	f := serverFrame(0x01, []byte(`{"pong":true}`))
	frame, rest, ok := decodeServerFrame(append(f, []byte("tail")...))
	if !ok || frame.opcode != 0x01 || string(frame.payload) != `{"pong":true}` {
		t.Fatalf("解析失败: ok=%v frame=%+v", ok, frame)
	}
	if string(rest) != "tail" {
		t.Fatalf("剩余字节错误: %q", rest)
	}
	if _, _, ok := decodeServerFrame(f[:3]); ok {
		t.Fatal("数据不足时不应返回完整帧")
	}
	// 畸形超大长度必须被挡住，不能拿去分配内存
	bad := []byte{0x82, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	if _, _, ok := decodeServerFrame(bad); ok {
		t.Fatal("畸形长度不应被接受")
	}
}

// ------------------------------------------------------------------
// 隧道首包构造
// ------------------------------------------------------------------

func TestBuildVlessTunnelPayload(t *testing.T) {
	uuid := "11111111-2222-3333-4444-555555555555"
	req := "GET / HTTP/1.1\r\n\r\n"
	b, err := BuildVlessTunnelPayload(uuid, "baidu.com", 80, req)
	if err != nil {
		t.Fatal(err)
	}
	// 1(version) + 16(uuid) + 6(addons/cmd/port/atyp/len) + host + request
	if len(b) != 1+16+6+len("baidu.com")+len(req) {
		t.Fatalf("长度错误: %d", len(b))
	}
	if b[0] != 0x00 || b[17] != 0x00 || b[18] != 0x01 {
		t.Fatalf("协议头错误: %v", b[:20])
	}
	if b[19] != 0 || b[20] != 80 || b[21] != 0x02 || b[22] != byte(len("baidu.com")) {
		t.Fatalf("地址段错误: %v", b[19:23])
	}
	if string(b[23:23+len("baidu.com")]) != "baidu.com" {
		t.Fatal("目标域名错误")
	}
	if _, err := BuildVlessTunnelPayload("not-a-uuid", "x.com", 80, req); err == nil {
		t.Fatal("非法 UUID 应报错")
	}
}

func TestBuildTrojanTunnelPayload(t *testing.T) {
	password := "trojan-pass"
	h := sha256.New224()
	_, _ = h.Write([]byte(password))
	wantDigest := hex.EncodeToString(h.Sum(nil))

	req := "GET / HTTP/1.1\r\n\r\n"
	b, err := BuildTrojanTunnelPayload(password, "baidu.com", 443, req)
	if err != nil {
		t.Fatal(err)
	}
	if len(wantDigest) != 56 || string(b[:56]) != wantDigest {
		t.Fatalf("sha224 口令错误: %q", b[:56])
	}
	rest := b[56:]
	if rest[0] != '\r' || rest[1] != '\n' {
		t.Fatal("口令后应有 CRLF")
	}
	if rest[2] != 0x01 || rest[3] != 0x03 || rest[4] != byte(len("baidu.com")) {
		t.Fatalf("命令/地址类型错误: %v", rest[2:5])
	}
	if binary.BigEndian.Uint16(rest[5+len("baidu.com"):7+len("baidu.com")]) != 443 {
		t.Fatal("端口错误")
	}
}

// ------------------------------------------------------------------
// PONG 内容校验
// ------------------------------------------------------------------

func TestProbeWSPingSuccess(t *testing.T) {
	srv := newRawTLSServer(t, func(conn net.Conn) {
		r := bufio.NewReader(conn)
		if !readRequestHead(r) {
			return
		}
		_, _ = conn.Write([]byte(upgrade101))
		opcode, payload, ok := readClientFrame(r)
		if !ok || opcode != 0x01 || string(payload) != "PING" {
			return
		}
		pong, _ := json.Marshal(map[string]any{"pong": true, "colo": "lax", "clientIp": "1.2.3.4"})
		_, _ = conn.Write(serverFrame(0x01, pong))
		time.Sleep(50 * time.Millisecond)
	})
	defer srv.stop()

	res := ProbeWSPing(context.Background(), srv.Addr, srv.Port, "test.example.com", 2*time.Second, "/__edge_probe")
	if !res.OK {
		t.Fatalf("应通过，实际 error=%q status=%d", res.Error, res.Status)
	}
	if res.PongVerified == nil || !*res.PongVerified {
		t.Fatal("PongVerified 应为 true")
	}
	// PONG 里的 colo 优先于 cf-ray 的 NRT
	if res.Colo != "LAX" || res.ProbeColo != "LAX" {
		t.Fatalf("机房应为 LAX，实际 Colo=%q ProbeColo=%q", res.Colo, res.ProbeColo)
	}
}

func TestProbeWSPingNoResponse(t *testing.T) {
	srv := newRawTLSServer(t, func(conn net.Conn) {
		r := bufio.NewReader(conn)
		if !readRequestHead(r) {
			return
		}
		_, _ = conn.Write([]byte(upgrade101))
		_, _, _ = readClientFrame(r)
		// 不回 PONG，直接关连接
	})
	defer srv.stop()

	res := ProbeWSPing(context.Background(), srv.Addr, srv.Port, "test.example.com", 2*time.Second, "/__edge_probe")
	if res.OK {
		t.Fatal("没有 PONG 不能判成功")
	}
	if res.PongVerified == nil || *res.PongVerified {
		t.Fatal("PongVerified 应为 false（做了校验但没通过）")
	}
}

func TestProbeWSPingCloseFrame(t *testing.T) {
	srv := newRawTLSServer(t, func(conn net.Conn) {
		r := bufio.NewReader(conn)
		if !readRequestHead(r) {
			return
		}
		_, _ = conn.Write([]byte(upgrade101))
		_, _, _ = readClientFrame(r)
		_, _ = conn.Write(serverFrame(0x08, []byte{0x03, 0xe8})) // close 1000
	})
	defer srv.stop()

	res := ProbeWSPing(context.Background(), srv.Addr, srv.Port, "test.example.com", 2*time.Second, "/__edge_probe")
	if res.OK || !strings.Contains(res.Error, "1000") {
		t.Fatalf("close 帧应给出明确原因，实际 %+v", res)
	}
}

func TestProbeWSPingRejects200(t *testing.T) {
	srv := newRawTLSServer(t, func(conn net.Conn) {
		r := bufio.NewReader(conn)
		if !readRequestHead(r) {
			return
		}
		_, _ = conn.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi"))
	})
	defer srv.stop()

	res := ProbeWSPing(context.Background(), srv.Addr, srv.Port, "test.example.com", 2*time.Second, "/__edge_probe")
	if res.OK || res.Status != 200 {
		t.Fatalf("HTTP 200 应判失败，实际 %+v", res)
	}
	if res.PongVerified != nil {
		t.Fatal("握手就失败时 PongVerified 应为 nil（未做内容校验）")
	}
}

// ------------------------------------------------------------------
// 真实隧道校验
// ------------------------------------------------------------------

func TestVerifyTunnelVlessStripsResponseHeader(t *testing.T) {
	srv := newRawTLSServer(t, func(conn net.Conn) {
		r := bufio.NewReader(conn)
		if !readRequestHead(r) {
			return
		}
		_, _ = conn.Write([]byte(upgrade101))
		opcode, payload, ok := readClientFrame(r)
		if !ok || opcode != 0x02 || len(payload) < 23 || payload[0] != 0x00 {
			return
		}
		// VLESS 回 [0,0] 响应头，后面才是目标站数据
		_, _ = conn.Write(serverFrame(0x02, append([]byte{0x00, 0x00}, []byte("HTTP/1.1 200 OK\r\n")...)))
		time.Sleep(50 * time.Millisecond)
	})
	defer srv.stop()

	res := VerifyTunnel(context.Background(), TunnelVerifyOptions{
		IP: srv.Addr, Port: srv.Port, Host: "test.example.com", WSPath: "/ws",
		UUID: "11111111-2222-3333-4444-555555555555", TargetHost: "baidu.com", TargetPort: 80,
		Timeout: 2 * time.Second,
	})
	if !res.OK {
		t.Fatalf("应通过，实际 %+v", res)
	}
	if !strings.HasPrefix(res.FirstBytes, "HTTP/1.1") {
		t.Fatalf("应剥掉 [0,0] 协议响应头，实际首字节 %q", res.FirstBytes)
	}
}

func TestVerifyTunnelTrojanNoResponseHeader(t *testing.T) {
	srv := newRawTLSServer(t, func(conn net.Conn) {
		r := bufio.NewReader(conn)
		if !readRequestHead(r) {
			return
		}
		_, _ = conn.Write([]byte(upgrade101))
		opcode, payload, ok := readClientFrame(r)
		if !ok || opcode != 0x02 || len(payload) < 60 {
			return
		}
		// Trojan 没有响应头，第一个字节就是目标站数据
		_, _ = conn.Write(serverFrame(0x02, []byte("HTTP/1.1 200 OK\r\n")))
		time.Sleep(50 * time.Millisecond)
	})
	defer srv.stop()

	res := VerifyTunnel(context.Background(), TunnelVerifyOptions{
		IP: srv.Addr, Port: srv.Port, Host: "test.example.com", WSPath: "/trojan",
		TrojanPassword: "trojan-pass", TargetHost: "baidu.com", TargetPort: 80,
		Timeout: 2 * time.Second,
	})
	if !res.OK || !strings.HasPrefix(res.FirstBytes, "HTTP/1.1") {
		t.Fatalf("Trojan 首字节不应被剥，实际 %+v", res)
	}
}

func TestVerifyTunnelMissingCredentials(t *testing.T) {
	res := VerifyTunnel(context.Background(), TunnelVerifyOptions{
		IP: "127.0.0.1", Port: 1, Host: "test.example.com", WSPath: "/ws",
	})
	if res.OK || res.Stage != "protocol" {
		t.Fatalf("无凭据应直接失败，实际 %+v", res)
	}
}

func TestDetectProbeEndpointUnknownOnNetworkError(t *testing.T) {
	found, known := DetectProbeEndpoint(context.Background(), "127.0.0.1:1", "/__edge_probe", 200*time.Millisecond)
	if found || known {
		t.Fatal("网络错误时结论必须是「未知」，不能据此降级")
	}
}
