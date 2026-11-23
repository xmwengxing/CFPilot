//go:build mesh

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/mesh"
)

const meshConfigJSON = `{"networkName":"test","psk":"test","virtualIp":"10.97.0.2"}`

type gatedLifecycle struct {
	startGate chan struct{}
	stopGate  chan struct{}
	startCtx  context.Context
	stopErr   error
	running   atomic.Bool
}

func (lifecycle *gatedLifecycle) Start(ctx context.Context) error {
	lifecycle.startCtx = ctx
	if lifecycle.startGate != nil {
		<-lifecycle.startGate
	}
	lifecycle.running.Store(true)
	return nil
}

func (lifecycle *gatedLifecycle) Stop() error {
	if lifecycle.stopGate != nil {
		<-lifecycle.stopGate
	}
	if lifecycle.stopErr != nil {
		return lifecycle.stopErr
	}
	lifecycle.running.Store(false)
	return nil
}

func (lifecycle *gatedLifecycle) Status() mesh.Status {
	return mesh.Status{Running: lifecycle.running.Load()}
}

func TestMeshControlSerializesStartAndStop(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		lifecycle := &gatedLifecycle{startGate: make(chan struct{}), stopGate: make(chan struct{})}
		allowStart := sync.OnceFunc(func() { close(lifecycle.startGate) })
		allowStop := sync.OnceFunc(func() { close(lifecycle.stopGate) })
		defer allowStart()
		defer allowStop()
		control := &meshControl{newLifecycle: func(mesh.Config) mesh.Lifecycle { return lifecycle }}
		handler := control.handler(nil)

		requestCtx, cancelRequest := context.WithCancel(context.Background())
		defer cancelRequest()
		request := httptest.NewRequestWithContext(requestCtx, http.MethodPost, mesh.APIMeshStart, strings.NewReader(meshConfigJSON))
		startResult := httptest.NewRecorder()
		go handler.ServeHTTP(startResult, request)
		synctest.Wait()

		assertMeshStatus(t, handler, false, transitionStarting)
		assertMeshAction(t, meshRequest(handler, http.MethodPost, mesh.APIMeshStart, meshConfigJSON), http.StatusConflict)
		assertMeshAction(t, meshRequest(handler, http.MethodPost, mesh.APIMeshStop, ""), http.StatusConflict)
		cancelRequest()
		allowStart()
		synctest.Wait()
		assertMeshAction(t, startResult, http.StatusOK)
		assertMeshStatus(t, handler, true, "")
		if lifecycle.startCtx.Err() != nil {
			t.Fatal("HTTP 请求结束时不应取消运行中的组网")
		}

		stopResult := httptest.NewRecorder()
		go handler.ServeHTTP(stopResult, httptest.NewRequest(http.MethodPost, mesh.APIMeshStop, nil))
		synctest.Wait()
		assertMeshStatus(t, handler, true, transitionStopping)
		assertMeshAction(t, meshRequest(handler, http.MethodPost, mesh.APIMeshStart, meshConfigJSON), http.StatusConflict)
		assertMeshAction(t, meshRequest(handler, http.MethodPost, mesh.APIMeshStop, ""), http.StatusConflict)
		allowStop()
		synctest.Wait()
		assertMeshAction(t, stopResult, http.StatusOK)
		assertMeshStatus(t, handler, false, "")
	})
}

func TestMeshControlRetainsRunningNetworkOnError(t *testing.T) {
	lifecycle := &gatedLifecycle{}
	control := &meshControl{newLifecycle: func(mesh.Config) mesh.Lifecycle { return lifecycle }}
	handler := control.handler(nil)
	assertMeshAction(t, meshRequest(handler, http.MethodPost, mesh.APIMeshStart, meshConfigJSON), http.StatusOK)

	assertMeshAction(t, meshRequest(handler, http.MethodPost, mesh.APIMeshStart, `{}`), http.StatusBadRequest)
	assertMeshStatus(t, handler, true, "")

	lifecycle.stopErr = errors.New("测试设备关闭失败")
	assertMeshAction(t, meshRequest(handler, http.MethodPost, mesh.APIMeshStart, meshConfigJSON), http.StatusBadRequest)
	assertMeshAction(t, meshRequest(handler, http.MethodPost, mesh.APIMeshStop, ""), http.StatusBadRequest)
	assertMeshStatus(t, handler, true, "")
	lifecycle.stopErr = nil
	assertMeshAction(t, meshRequest(handler, http.MethodPost, mesh.APIMeshStop, ""), http.StatusOK)
}

func TestMeshControlAcceptsStatusDuringAutoRestore(t *testing.T) {
	profiles, err := mesh.NewProfileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := profiles.Save("test", mesh.Config{NetworkName: "test", PSK: "test", VirtualIP: "10.97.0.2"}); err != nil {
		t.Fatal(err)
	}
	synctest.Test(t, func(t *testing.T) {
		lifecycle := &gatedLifecycle{startGate: make(chan struct{})}
		allowStart := sync.OnceFunc(func() { close(lifecycle.startGate) })
		defer allowStart()
		control := &meshControl{newLifecycle: func(mesh.Config) mesh.Lifecycle { return lifecycle }}
		control.restore(profiles)
		handler := control.handler(profiles)
		assertMeshStatus(t, handler, false, transitionStarting)
		assertMeshAction(t, meshRequest(handler, http.MethodPost, mesh.APIMeshStart, meshConfigJSON), http.StatusConflict)
		allowStart()
		synctest.Wait()
		assertMeshStatus(t, handler, true, "")
		assertMeshAction(t, meshRequest(handler, http.MethodPost, mesh.APIMeshStop, ""), http.StatusOK)
	})
}

func meshRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, httptest.NewRequest(method, path, strings.NewReader(body)))
	return result
}

func assertMeshAction(t *testing.T, result *httptest.ResponseRecorder, code int) {
	t.Helper()
	if result.Code != code {
		t.Fatalf("响应码 = %d，期望 %d，响应 = %s", result.Code, code, result.Body)
	}
	var action mesh.ActionResult
	if err := json.Unmarshal(result.Body.Bytes(), &action); err != nil {
		t.Fatal(err)
	}
	if action.OK != (code == http.StatusOK) || (code >= 400 && action.Error == "") {
		t.Fatalf("操作响应 = %+v，响应码 = %d", action, code)
	}
}

func assertMeshStatus(t *testing.T, handler http.Handler, running bool, transition string) {
	t.Helper()
	result := meshRequest(handler, http.MethodGet, mesh.APIMeshStatus, "")
	if result.Code != http.StatusOK {
		t.Fatalf("状态响应码 = %d，响应 = %s", result.Code, result.Body)
	}
	var status mesh.Status
	if err := json.Unmarshal(result.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.Running != running || status.Transition != transition {
		t.Fatalf("状态 = %+v，期望 running=%t transition=%q", status, running, transition)
	}
}
