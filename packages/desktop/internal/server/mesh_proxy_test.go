//go:build mesh

package server

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/mesh"
)

type meshTestTransport func(*http.Request) (*http.Response, error)

func (transport meshTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return transport(req)
}

func TestMeshProxyDistinguishesTimeoutFromStoppedService(t *testing.T) {
	for _, test := range []struct {
		name, method, path string
		upstreamErr        error
		code               int
		message            string
	}{
		{"启动响应超时", http.MethodPost, mesh.APIMeshStart, context.DeadlineExceeded, http.StatusGatewayTimeout, "响应超时"},
		{"状态响应超时", http.MethodGet, mesh.APIMeshStatus, context.DeadlineExceeded, http.StatusGatewayTimeout, "响应超时"},
		{"服务未监听", http.MethodPost, mesh.APIMeshStop, &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}, http.StatusServiceUnavailable, "组网服务未运行"},
		{"未监听时的状态", http.MethodGet, mesh.APIMeshStatus, &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}, http.StatusOK, `"daemon":false`},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &http.Client{Transport: meshTestTransport(func(req *http.Request) (*http.Response, error) {
				deadline, ok := req.Context().Deadline()
				if !ok || (test.method == http.MethodPost && time.Until(deadline) < 20*time.Second) {
					t.Fatal("启停请求需要单独的超时预算")
				}
				return nil, test.upstreamErr
			})}
			request := httptest.NewRequest(test.method, test.path, nil)
			response := httptest.NewRecorder()
			proxyMeshRequest(response, request, client, "http://127.0.0.1:19727")
			if response.Code != test.code || !strings.Contains(response.Body.String(), test.message) {
				t.Fatalf("响应 = %d %s, 期望 %d %q", response.Code, response.Body.String(), test.code, test.message)
			}
		})
	}
}

func TestMeshProxyForwardsBusyResponse(t *testing.T) {
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		writeJSON(w, http.StatusConflict, mesh.ActionResult{Error: "组网正在启动"})
	}))
	defer daemon.Close()
	request := httptest.NewRequest(http.MethodPost, mesh.APIMeshStop, nil)
	response := httptest.NewRecorder()
	proxyMeshRequest(response, request, daemon.Client(), daemon.URL)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "组网正在启动") {
		t.Fatalf("响应 = %d %s", response.Code, response.Body.String())
	}
}

func TestMeshProxyClosedLoopbackPort(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := "http://" + listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{}
	t.Cleanup(transport.CloseIdleConnections)
	client := &http.Client{Transport: transport}
	for _, test := range []struct {
		method, path string
		code         int
		message      string
	}{
		{http.MethodGet, mesh.APIMeshStatus, http.StatusOK, `"daemon":false`},
		{http.MethodPost, mesh.APIMeshStop, http.StatusServiceUnavailable, "组网服务未运行"},
	} {
		request := httptest.NewRequest(test.method, test.path, nil)
		response := httptest.NewRecorder()
		proxyMeshRequest(response, request, client, address)
		if response.Code != test.code || !strings.Contains(response.Body.String(), test.message) {
			t.Errorf("%s %s 响应 = %d %s，期望 %d %q", test.method, test.path, response.Code, response.Body.String(), test.code, test.message)
		}
	}
}
