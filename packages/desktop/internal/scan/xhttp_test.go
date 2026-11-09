package scan

import (
	"context"
	"crypto/tls"
	"log"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// newH2TLSServer 起一个只协商 h2 的 TLS 服务器（XHTTP 探针用）。
func newH2TLSServer(t *testing.T, handler http.Handler) *testServer {
	t.Helper()
	cert := selfSignedCert(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	tlsLn := tls.NewListener(ln, &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"h2"},
		MinVersion:   tls.VersionTLS12,
	})
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ErrorLog: log.New(discard{}, "", 0)}
	go func() { _ = srv.Serve(tlsLn) }()
	addr := ln.Addr().(*net.TCPAddr)
	return &testServer{Addr: addr.IP.String(), Port: addr.Port, stop: func() { _ = srv.Close() }}
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

func TestProbeTLSWithALPN(t *testing.T) {
	srv := newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.stop()
	// H1 服务器用 h2 探必失败，http/1.1 必成功。
	r1 := ProbeTLSWithALPN(context.Background(), srv.Addr, srv.Port, "test.example.com", time.Second, "http/1.1")
	if !r1.OK {
		t.Fatalf("http/1.1 应成功：%v", r1.Error)
	}
	r2 := ProbeTLSWithALPN(context.Background(), srv.Addr, srv.Port, "test.example.com", time.Second, "h2")
	if r2.OK {
		t.Fatal("h2 探 H1 服务器应失败")
	}
}

func TestProbeXHTTPEndpoint(t *testing.T) {
	srv := newH2TLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cf-Ray", "abc-SJC")
		if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/xhttp/") {
			w.WriteHeader(400)
			_, _ = w.Write([]byte("VLESS 头解析失败"))
			return
		}
		w.WriteHeader(200)
		_, _ = w.Write([]byte("<html>Welcome</html>"))
	}))
	defer srv.stop()
	r := ProbeXHTTP(context.Background(), srv.Addr, srv.Port, "test.example.com", "/xhttp", 2*time.Second)
	if !r.OK {
		t.Fatalf("应成功：%v status=%d", r.Error, r.Status)
	}
	if r.Colo != "SJC" {
		t.Fatalf("colo 应为 SJC，实际 %q", r.Colo)
	}
}

func TestProbeXHTTPForbidden(t *testing.T) {
	srv := newH2TLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		_, _ = w.Write([]byte("forbidden"))
	}))
	defer srv.stop()
	r := ProbeXHTTP(context.Background(), srv.Addr, srv.Port, "test.example.com", "/xhttp", 2*time.Second)
	if r.OK {
		t.Fatal("403 应失败")
	}
}

func TestVerifyXHTTPTunnel(t *testing.T) {
	// 模拟 packet-up：POST 200，GET 回 [0,0]+HTTP
	srv := newH2TLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cf-Ray", "abc-SJC")
		if r.Method == http.MethodPost {
			w.WriteHeader(200)
			_, _ = w.Write([]byte{})
			return
		}
		if r.Method == http.MethodGet {
			w.WriteHeader(200)
			fl, _ := w.(http.Flusher)
			_, _ = w.Write([]byte{0, 0})
			if fl != nil {
				fl.Flush()
			}
			_, _ = w.Write([]byte("HTTP/1.1 200 OK\r\n\r\nhello"))
			return
		}
		w.WriteHeader(404)
	}))
	defer srv.stop()
	r := VerifyXHTTPTunnel(context.Background(), srv.Addr, srv.Port, "test.example.com", "/xhttp",
		"11111111-2222-3333-4444-555555555555", "baidu.com", 80, 5*time.Second)
	if !r.OK {
		t.Fatalf("应成功：%v stage=%s", r.Error, r.Stage)
	}
	if !strings.Contains(r.FirstByte, "HTTP") {
		t.Fatalf("应含 HTTP，实际 %q", r.FirstByte)
	}
}
