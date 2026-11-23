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

// 中性页：数据面对未认证的入站请求回的就是这张页（不是 400）。
const testNeutralPage = `<!DOCTYPE html><html><head><title>Welcome</title></head>` +
	`<body><h1>Welcome</h1><p>This site is up and running.</p></body></html>`

func TestProbeXHTTPEndpoint(t *testing.T) {
	srv := newH2TLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cf-Ray", "abc-SJC")
		if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/xhttp/") {
			// 真实数据面的行为：未认证 → 中性页 200
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(testNeutralPage))
			return
		}
		w.WriteHeader(404)
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

// 200 但不是本站中性页 → 该 IP 指向别的站点，必须判失败。
func TestProbeXHTTPForeignPage(t *testing.T) {
	srv := newH2TLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<html><body>some other site</body></html>"))
	}))
	defer srv.stop()
	r := ProbeXHTTP(context.Background(), srv.Addr, srv.Port, "test.example.com", "/xhttp", 2*time.Second)
	if r.OK {
		t.Fatal("非本站中性页应判失败")
	}
	if !strings.Contains(r.Error, "不是本站数据面") {
		t.Fatalf("错误应说明不是本站数据面，实际 %q", r.Error)
	}
}

// 200 + text/event-stream → 认证已通过（packet-up 的响应头特征）。
func TestProbeXHTTPEventStream(t *testing.T) {
	srv := newH2TLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
	}))
	defer srv.stop()
	r := ProbeXHTTP(context.Background(), srv.Addr, srv.Port, "test.example.com", "/xhttp", 2*time.Second)
	if !r.OK {
		t.Fatalf("event-stream 应判成功：%v", r.Error)
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
