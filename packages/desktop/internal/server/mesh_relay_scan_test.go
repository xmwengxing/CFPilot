//go:build mesh

package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 组网入口探测路由：方法与必填校验（不触达历史存储，避免测试依赖真实目录）。
func TestHandleMeshRelayScanValidation(t *testing.T) {
	s := &Server{}

	t.Run("非 POST 拒绝", func(t *testing.T) {
		rec := httptest.NewRecorder()
		s.handleMeshRelayScan(rec, httptest.NewRequest(http.MethodGet, "/api/mesh/relay-scan", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("状态 = %d, 期望 405", rec.Code)
		}
	})

	t.Run("缺中继域名拒绝", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/mesh/relay-scan", strings.NewReader(`{"room":"abcdef12"}`))
		s.handleMeshRelayScan(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("状态 = %d, 期望 400", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "盲中继域名") {
			t.Errorf("错误文案应提示缺少盲中继域名，实际 %s", rec.Body.String())
		}
	})

	t.Run("请求体非法拒绝", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/mesh/relay-scan", strings.NewReader(`not-json`))
		s.handleMeshRelayScan(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("状态 = %d, 期望 400", rec.Code)
		}
	})

	t.Run("旧版显式房间名非法拒绝", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/mesh/relay-scan",
			strings.NewReader(`{"relayDomain":"r.example.com","room":"zz","candidates":["1.2.3.4"]}`))
		s.handleMeshRelayScan(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("状态 = %d, 期望 400", rec.Code)
		}
	})

	t.Run("未提供房间和网络凭据拒绝", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/mesh/relay-scan",
			strings.NewReader(`{"relayDomain":"r.example.com","candidates":["1.2.3.4"]}`))
		s.handleMeshRelayScan(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("状态 = %d, 期望 400", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "网络名与网络密钥") {
			t.Errorf("应提示补充网络凭据，实际 %s", rec.Body.String())
		}
	})
}

// 组网候选源：内置清单可读、拉取路由的入参校验。
func TestHandleMeshEntrySourcesAndFetch(t *testing.T) {
	s := &Server{}

	t.Run("内置源清单可读", func(t *testing.T) {
		rec := httptest.NewRecorder()
		s.handleMeshEntrySources(rec, httptest.NewRequest(http.MethodGet, "/api/mesh/entry-sources", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("状态 = %d, 期望 200", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "tiancheng/hk.txt") {
			t.Errorf("清单里应包含内置香港源，实际 %s", rec.Body.String())
		}
	})

	t.Run("拉取只接受 POST", func(t *testing.T) {
		rec := httptest.NewRecorder()
		s.handleMeshEntryFetch(rec, httptest.NewRequest(http.MethodGet, "/api/mesh/entry-fetch", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("状态 = %d, 期望 405", rec.Code)
		}
	})

	t.Run("既无 sourceId 也无 url 拒绝", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/mesh/entry-fetch", strings.NewReader(`{}`))
		s.handleMeshEntryFetch(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("状态 = %d, 期望 400", rec.Code)
		}
	})

	t.Run("非 HTTPS 地址拒绝", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/mesh/entry-fetch",
			strings.NewReader(`{"url":"http://example.com/list.txt"}`))
		s.handleMeshEntryFetch(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("状态 = %d, 期望 400", rec.Code)
		}
	})
}
