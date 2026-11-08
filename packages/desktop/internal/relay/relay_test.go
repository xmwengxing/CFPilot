package relay

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"
)

/* ------------------------------ VLESS ------------------------------ */

func TestParseUUID(t *testing.T) {
	withDash, err := ParseUUID("11111111-2222-3333-4444-555555555555")
	if err != nil {
		t.Fatalf("带连字符的 UUID 应可解析：%v", err)
	}
	bare, err := ParseUUID("11111111222233334444555555555555")
	if err != nil {
		t.Fatalf("裸十六进制应可解析：%v", err)
	}
	if withDash != bare {
		t.Fatal("两种写法应解析出同一串字节")
	}
	if _, err := ParseUUID("xyz"); err == nil {
		t.Fatal("非法 UUID 应当报错")
	}
}

func TestBuildVLESSRequest(t *testing.T) {
	uuid, _ := ParseUUID("11111111-2222-3333-4444-555555555555")
	target, err := ParseIPv4("1.2.3.4")
	if err != nil {
		t.Fatal(err)
	}
	req := BuildVLESSRequest(uuid, target, 443)

	// 1 版本 + 16 UUID + 1 addons 长度 + 1 命令 + 2 端口 + 1 地址类型 + 4 地址
	if len(req) != 26 {
		t.Fatalf("VLESS 请求头应为 26 字节，实际 %d", len(req))
	}
	if req[0] != 0x00 {
		t.Errorf("版本应为 0，实际 %#x", req[0])
	}
	if req[17] != 0x00 {
		t.Errorf("addons 长度应为 0，实际 %#x", req[17])
	}
	if req[18] != 0x01 {
		t.Errorf("命令应为 TCP(0x01)，实际 %#x", req[18])
	}
	if req[19] != 0x01 || req[20] != 0xBB {
		t.Errorf("端口应为 443（0x01BB），实际 %#x%#x", req[19], req[20])
	}
	if req[21] != 0x01 {
		t.Errorf("地址类型应为 IPv4(0x01)，实际 %#x", req[21])
	}
	if req[22] != 1 || req[23] != 2 || req[24] != 3 || req[25] != 4 {
		t.Errorf("地址字节错误：%v", req[22:])
	}
}

func TestReadVLESSReplySkipsAddons(t *testing.T) {
	// 带 addons 时**必须**精确消费，否则残留字节会被 TLS 当成记录头
	reply := append([]byte{0x00, 0x03}, []byte("abc")...)
	reply = append(reply, []byte("DATA")...)
	r := strings.NewReader(string(reply))

	version, addons, err := ReadVLESSReply(r)
	if err != nil {
		t.Fatalf("应能解析响应头：%v", err)
	}
	if version != 0x00 || string(addons) != "abc" {
		t.Fatalf("解析结果不对：version=%#x addons=%q", version, addons)
	}
	rest, _ := io.ReadAll(r)
	if string(rest) != "DATA" {
		t.Fatalf("addons 之后的字节应保持原样，实际 %q", string(rest))
	}
}

// TestResolveProbeTarget IPv4 直通；域名取第一个 A 记录；解析失败 / 只有 IPv6 明确报错。
func TestResolveProbeTarget(t *testing.T) {
	if got, err := resolveProbeTarget(context.Background(), "1.2.3.4"); err != nil || got != [4]byte{1, 2, 3, 4} {
		t.Fatalf("IPv4 应直通、不走 DNS：%v %v", got, err)
	}

	old := probeLookupIP
	defer func() { probeLookupIP = old }()

	probeLookupIP = func(_ context.Context, _ string) ([]net.IPAddr, error) {
		return []net.IPAddr{
			{IP: net.ParseIP("2606:4700::1")},
			{IP: net.ParseIP("104.16.0.1")},
			{IP: net.ParseIP("104.16.0.2")},
		}, nil
	}
	got, err := resolveProbeTarget(context.Background(), "cf.example.com")
	if err != nil || got != [4]byte{104, 16, 0, 1} {
		t.Fatalf("域名应解析成第一个 IPv4：%v %v", got, err)
	}

	probeLookupIP = func(_ context.Context, _ string) ([]net.IPAddr, error) {
		return nil, errors.New("no such host")
	}
	if _, err := resolveProbeTarget(context.Background(), "bad.example.com"); err == nil {
		t.Fatal("解析失败必须明确报错")
	}

	probeLookupIP = func(_ context.Context, _ string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("2606:4700::1")}}, nil
	}
	if _, err := resolveProbeTarget(context.Background(), "v6.example.com"); err == nil {
		t.Fatal("只有 IPv6 记录、没有 IPv4 时必须报错")
	}
}

/* ------------------------------ WS 帧 ------------------------------ */

// writeRawFrame 按 RFC 6455 手工写一个**不加掩码**的帧（模拟服务端）。
func writeRawFrame(w io.Writer, opcode byte, payload []byte) error {
	header := []byte{0x80 | opcode}
	switch length := len(payload); {
	case length < 126:
		header = append(header, byte(length))
	case length <= 0xFFFF:
		header = append(header, 126, byte(length>>8), byte(length))
	default:
		header = append(header, 127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(length))
		header = append(header, ext[:]...)
	}
	if _, err := w.Write(append(header, payload...)); err != nil {
		return err
	}
	return nil
}

// readRawFrame 读一个帧并还原掩码（用于断言客户端发出的帧合法）。
func readRawFrame(r io.Reader) (opcode byte, payload []byte, masked bool, err error) {
	var head [2]byte
	if _, err = io.ReadFull(r, head[:]); err != nil {
		return 0, nil, false, err
	}
	opcode = head[0] & 0x0F
	masked = head[1]&0x80 != 0
	length := int64(head[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(r, ext[:]); err != nil {
			return
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(r, ext[:]); err != nil {
			return
		}
		length = int64(binary.BigEndian.Uint64(ext[:]))
	}
	var key [4]byte
	if masked {
		if _, err = io.ReadFull(r, key[:]); err != nil {
			return
		}
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(r, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= key[i%4]
		}
	}
	return opcode, payload, masked, nil
}

func TestClientFramesAreMaskedAndReadBack(t *testing.T) {
	a, b := net.Pipe()
	defer func() { _ = a.Close(); _ = b.Close() }()

	client := &Conn{conn: a, br: bufio.NewReader(a)}

	go func() {
		_, _ = client.Write([]byte("hello"))
	}()

	opcode, payload, masked, err := readRawFrame(b)
	if err != nil {
		t.Fatalf("读客户端帧失败：%v", err)
	}
	if opcode != opBinary {
		t.Errorf("应为二进制帧，实际 opcode=%#x", opcode)
	}
	if !masked {
		t.Error("客户端发出的帧必须加掩码（RFC 6455 §5.3）")
	}
	if string(payload) != "hello" {
		t.Errorf("负载不符：%q", payload)
	}
}

func TestPingIsAnsweredWithPongAndDataPassesThrough(t *testing.T) {
	a, b := net.Pipe()
	defer func() { _ = a.Close(); _ = b.Close() }()

	client := &Conn{conn: a, br: bufio.NewReader(a)}
	type readResult struct {
		n   int
		err error
		got []byte
	}
	done := make(chan readResult, 1)
	go func() {
		buf := make([]byte, 16)
		n, err := client.Read(buf)
		done <- readResult{n: n, err: err, got: append([]byte(nil), buf[:n]...)}
	}()

	if err := writeRawFrame(b, opPing, []byte("p")); err != nil {
		t.Fatal(err)
	}
	opcode, payload, _, err := readRawFrame(b)
	if err != nil {
		t.Fatalf("读 pong 失败：%v", err)
	}
	if opcode != opPong || string(payload) != "p" {
		t.Fatalf("应回 pong 且带回原负载，实际 opcode=%#x payload=%q", opcode, payload)
	}

	if err := writeRawFrame(b, opBinary, []byte("data")); err != nil {
		t.Fatal(err)
	}
	result := <-done
	if result.err != nil {
		t.Fatalf("读数据失败：%v", result.err)
	}
	if string(result.got) != "data" {
		t.Fatalf("数据不符：%q", result.got)
	}
}

func TestReadAcrossFragments(t *testing.T) {
	a, b := net.Pipe()
	defer func() { _ = a.Close(); _ = b.Close() }()

	client := &Conn{conn: a, br: bufio.NewReader(a)}
	done := make(chan string, 1)
	go func() {
		var sb strings.Builder
		buf := make([]byte, 32)
		for sb.Len() < 6 {
			n, err := client.Read(buf)
			if err != nil {
				break
			}
			sb.Write(buf[:n])
		}
		done <- sb.String()
	}()

	// 一个分片帧：FIN=0 的二进制 + FIN=1 的 continuation
	if _, err := b.Write([]byte{0x02, 0x03}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Write([]byte("abc")); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Write([]byte{0x80, 0x03}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Write([]byte("def")); err != nil {
		t.Fatal(err)
	}

	select {
	case got := <-done:
		if got != "abcdef" {
			t.Fatalf("分片应拼成 abcdef，实际 %q", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("读分片超时")
	}
}

/* ------------------------------ 汇总 ------------------------------ */

func TestAggregateAndPicked(t *testing.T) {
	results := []Result{
		{IP: "1.1.1.1", BuildOK: true, OK: true, TLSMs: 100, TunnelMs: 800, HTTPMs: 200},
		{IP: "1.1.1.1", BuildOK: true, OK: true, TLSMs: 120, TunnelMs: 820, HTTPMs: 210},
		{IP: "2.2.2.2", BuildOK: true, OK: true, TLSMs: 300, TunnelMs: 900, HTTPMs: 250},
		{IP: "2.2.2.2", BuildOK: false, OK: true, TLSMs: 320, Error: "build 不匹配"},
		{IP: "3.3.3.3", OK: false, Error: "TLS 握手失败"},
	}
	summary := &Summary{ExpectedBuild: "b1"}
	for _, ip := range []string{"1.1.1.1", "2.2.2.2", "3.3.3.3"} {
		var group []Result
		for _, r := range results {
			if r.IP == ip {
				group = append(group, r)
			}
		}
		summary.Aggregates = append(summary.Aggregates, aggregate(ip, group))
	}

	first := summary.Aggregates[0]
	if first.SuccessPct != 100 {
		t.Errorf("1.1.1.1 应两轮全通，实际 %d%%", first.SuccessPct)
	}
	if first.TLSMs != 110 {
		t.Errorf("TLS 中位应为 110，实际 %d", first.TLSMs)
	}
	if summary.Aggregates[1].SuccessPct != 50 {
		t.Errorf("2.2.2.2 应为 50%%，实际 %d%%", summary.Aggregates[1].SuccessPct)
	}
	if summary.Aggregates[2].SuccessPct != 0 {
		t.Errorf("3.3.3.3 应为 0%%，实际 %d%%", summary.Aggregates[2].SuccessPct)
	}

	// Picked 只取全通项
	picked := summary.Picked(5)
	if len(picked) != 1 || picked[0] != "1.1.1.1" {
		t.Fatalf("Picked 应只含全通项，实际 %v", picked)
	}
}

func TestPercentileAndMedian(t *testing.T) {
	values := []int64{10, 20, 30, 40, 50}
	if got := median(values); got != 30 {
		t.Errorf("中位应为 30，实际 %d", got)
	}
	if got := median([]int64{10, 20}); got != 15 {
		t.Errorf("偶数个应取平均，实际 %d", got)
	}
	if got := percentile(values, 95); got != 50 {
		t.Errorf("P95 应为 50，实际 %d", got)
	}
	if got := median(nil); got != 0 {
		t.Errorf("空集应为 0，实际 %d", got)
	}
}

/* --------------------------- 端到端（假数据面）--------------------------- */

// selfSignedCertForIP 生成一张只对 ip 有效的自签证书。
func selfSignedCertForIP(t *testing.T, ip net.IP) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: ip.String()},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IPAddresses:           []net.IP{ip},
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// fakeDataPlane 模拟「数据面」：TLS → WS 101 → 收 VLESS 头 → 回协议头 →
// 在隧道内再起一个 TLS 服务端 → 回 /__cfp_version。
func fakeDataPlane(t *testing.T, build string) (host string, port int, pool *x509.CertPool) {
	t.Helper()
	ip := net.ParseIP("127.0.0.1")
	cert := selfSignedCertForIP(t, ip)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	pool = x509.NewCertPool()
	parsed, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	pool.AddCert(parsed)

	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = raw.Close() }()
				_ = handleFakeConn(raw, cert, build)
			}()
		}
	}()

	addr := listener.Addr().(*net.TCPAddr)
	return "127.0.0.1", addr.Port, pool
}

func handleFakeConn(raw net.Conn, cert tls.Certificate, build string) error {
	outer := tls.Server(raw, &tls.Config{Certificates: []tls.Certificate{cert}})
	if err := outer.Handshake(); err != nil {
		return err
	}
	br := bufio.NewReader(outer)

	// ---- HTTP 升级请求 ----
	line, err := br.ReadString('\n')
	if err != nil {
		return err
	}
	if !strings.HasPrefix(line, "GET ") {
		return fmt.Errorf("期望 GET，实际 %q", line)
	}
	key := ""
	for {
		h, err := br.ReadString('\n')
		if err != nil {
			return err
		}
		h = strings.TrimRight(h, "\r\n")
		if h == "" {
			break
		}
		if idx := strings.Index(h, ":"); idx > 0 && strings.EqualFold(strings.TrimSpace(h[:idx]), "Sec-WebSocket-Key") {
			key = strings.TrimSpace(h[idx+1:])
		}
	}
	response := strings.Join([]string{
		"HTTP/1.1 101 Switching Protocols",
		"Upgrade: websocket",
		"Connection: Upgrade",
		"Sec-WebSocket-Accept: " + wsAccept(key),
		"",
		"",
	}, "\r\n")
	if _, err := outer.Write([]byte(response)); err != nil {
		return err
	}

	ws := &Conn{conn: outer, br: br, serverSide: true}

	// ---- VLESS 请求头（26 字节）----
	header := make([]byte, 26)
	if _, err := io.ReadFull(ws, header); err != nil {
		return err
	}
	if header[0] != 0x00 || header[21] != 0x01 {
		return fmt.Errorf("VLESS 头不合法：%v", header[:22])
	}
	if _, err := ws.Write([]byte{0x00, 0x00}); err != nil {
		return err
	}

	// ---- 隧道内再起 TLS ----
	inner := tls.Server(ws, &tls.Config{Certificates: []tls.Certificate{cert}})
	if err := inner.Handshake(); err != nil {
		return err
	}
	innerReader := bufio.NewReader(inner)
	if _, err := innerReader.ReadString('\n'); err != nil {
		return err
	}
	for {
		h, err := innerReader.ReadString('\n')
		if err != nil {
			return err
		}
		if strings.TrimRight(h, "\r\n") == "" {
			break
		}
	}
	body, _ := json.Marshal(map[string]any{"build": build, "version": "test"})
	fmt.Fprintf(inner, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len(body), body)
	return nil
}

func TestProbeEndToEnd(t *testing.T) {
	host, port, pool := fakeDataPlane(t, "build-abc")
	dialTLSConfigHook = func(cfg *tls.Config) *tls.Config {
		cfg.RootCAs = pool
		return cfg
	}
	defer func() { dialTLSConfigHook = nil }()

	opt := Options{
		Host:          host,
		Port:          port,
		WSPath:        "/ws",
		UUID:          "11111111-2222-3333-4444-555555555555",
		ExpectedBuild: "build-abc",
		Timeout:       5 * time.Second,
	}
	result := Probe(context.Background(), opt, "1.2.3.4")
	if result.Error != "" {
		t.Fatalf("端到端探测应成功，实际错误：%s", result.Error)
	}
	if !result.OK || !result.BuildOK {
		t.Fatalf("应判为通过：ok=%v buildOk=%v status=%d", result.OK, result.BuildOK, result.Status)
	}
	// 本机回环握手常常不到 1ms，取整后 TLSMs 可能是 0 —— 不能拿它当成功判据
	if result.Status != 200 || result.Build != "build-abc" {
		t.Errorf("状态与 build 应正确：status=%d build=%q", result.Status, result.Build)
	}

	// build 不匹配：TLS 通但落点不对 —— 必须判失败
	opt.ExpectedBuild = "another-build"
	mismatch := Probe(context.Background(), opt, "1.2.3.4")
	if !mismatch.OK {
		t.Fatalf("TLS 应通过，实际 %s", mismatch.Error)
	}
	if mismatch.BuildOK {
		t.Fatal("build 不匹配时不能判为通过")
	}
	if !strings.Contains(mismatch.Error, "build") {
		t.Errorf("错误应说明 build 不匹配，实际 %q", mismatch.Error)
	}
}
