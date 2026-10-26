package cfapi

import (
	"context"
	"encoding/json"
	"errors"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// mockCF 起一个假的 Cloudflare API，handler 按路径返回预设响应。
func mockCF(t *testing.T, handler http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	c := New(Options{Token: "test-token", APIBase: srv.URL})
	return c, srv
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// 正常响应：解出 result。
func TestRequestHappyPath(t *testing.T) {
	c, _ := mockCF(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization 头不对：%q", got)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"result": []map[string]string{
				{"id": "acc1", "name": "我的账号"},
			},
		})
	})

	accounts, err := c.ListAccounts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(accounts) != 1 || accounts[0].ID != "acc1" {
		t.Errorf("解析不对：%+v", accounts)
	}
}

// 关键：HTTP 200 但 success=false 必须当失败。
//
// 只看状态码会把这种情况当成成功，症状是「部署成功但页面还是旧的」。
func TestEnvelopeSuccessFalseIsError(t *testing.T) {
	c, _ := mockCF(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"success": false,
			"errors": []map[string]any{
				{"code": 8000119, "message": "项目数已达上限"},
			},
			"result": nil,
		})
	})

	_, err := c.ListAccounts(context.Background())
	if err == nil {
		t.Fatal("success=false 必须报错")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("应是 *APIError，实际 %T", err)
	}
	if apiErr.Code != 8000119 {
		t.Errorf("错误码应为 8000119，实际 %d", apiErr.Code)
	}
	if !apiErr.IsProjectLimit() {
		t.Error("IsProjectLimit 应返回 true")
	}
}

// 8000119 识别的正误判断。
func TestProjectLimitDetection(t *testing.T) {
	cases := []struct {
		code int
		want bool
	}{
		{8000119, true},
		{8000000, false},
		{0, false},
		{10000, false},
	}
	for _, tc := range cases {
		e := &APIError{Code: tc.code}
		if got := e.IsProjectLimit(); got != tc.want {
			t.Errorf("code=%d 期望 %v 实际 %v", tc.code, tc.want, got)
		}
	}
}

// 404 判定（用不会吞掉 404 的方法验证）。
func TestNotFoundDetection(t *testing.T) {
	c, _ := mockCF(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"success": false,
			"errors":  []map[string]any{{"code": 8000007, "message": "Project not found"}},
		})
	})

	// DeletePagesProject 不会把 404 转成 nil，能直接看到错误
	err := c.DeletePagesProject(context.Background(), "acc1", "nope")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || !apiErr.IsNotFound() {
		t.Fatalf("应识别为 404，实际 %v", err)
	}
}

// GetPagesProject 遇到 404 要返回 (nil, nil) 而不是报错 ——
// 部署流程靠这个判断「项目是否存在」，报错会被误当成网络故障。
func TestGetPagesProjectNotFoundReturnsNil(t *testing.T) {
	c, _ := mockCF(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"success": false,
			"errors":  []map[string]any{{"code": 8000007, "message": "not found"}},
		})
	})

	p, err := c.GetPagesProject(context.Background(), "acc1", "nope")
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if p != nil {
		t.Errorf("应为 nil，实际 %+v", p)
	}
}

// 空响应体（DELETE 成功的常见形态）不能报错。
func TestEmptyBodyDelete(t *testing.T) {
	c, _ := mockCF(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("应为 DELETE，实际 %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
	})

	if err := c.DeletePagesProject(context.Background(), "acc1", "proj"); err != nil {
		t.Fatalf("空响应体不该报错：%v", err)
	}
}

// 非法 JSON 响应要报错，不能静默成功。
func TestInvalidJSON(t *testing.T) {
	c, _ := mockCF(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("<html>502 Bad Gateway</html>"))
	})

	_, err := c.ListAccounts(context.Background())
	if err == nil {
		t.Fatal("非法 JSON 必须报错")
	}
	if !strings.Contains(err.Error(), "不是合法 JSON") {
		t.Errorf("错误信息应说明 JSON 非法，实际：%v", err)
	}
}

// 部署表单的**顶层字段**校验（嵌套结构由 deploy_form_test.go 负责）。
//
// ⚠️ 这个测试曾被写成「断言 metadata 是顶层字段」——那是**错误的结构**，
// 导致真实部署 100% 失败（8000096）却测试全绿。
// 现在改为断言正确的顶层字段：branch / manifest / _worker.bundle。
func TestDeployPagesWorkerTopLevelFields(t *testing.T) {
	var fields map[string]bool
	var manifest string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		mr := multipart.NewReader(r.Body, params["boundary"])
		form, _ := mr.ReadForm(16 << 20)

		fields = map[string]bool{}
		for k := range form.Value {
			fields[k] = true
		}
		for k := range form.File {
			fields[k] = true
		}
		if v := form.Value["manifest"]; len(v) > 0 {
			manifest = v[0]
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"result":  map[string]string{"id": "dep1"},
		})
	}))
	defer srv.Close()

	c := New(Options{Token: "t", APIBase: srv.URL})
	if _, err := c.DeployPagesWorker(context.Background(), PagesDeployOptions{
		AccountID: "acc",
		Project:   "proj",
		Script:    []byte("x"),
	}); err != nil {
		t.Fatal(err)
	}

	// manifest 是必需字段（缺了 8000096）
	if !fields["manifest"] {
		t.Error("缺少 manifest 字段 —— Pages API 会返回 8000096")
	}
	if manifest != "{}" {
		t.Errorf("manifest 应为 \"{}\"，实际 %q", manifest)
	}
	// 必须是 _worker.bundle 而不是裸 _worker.js
	if !fields["_worker.bundle"] {
		t.Error("缺少 _worker.bundle 字段")
	}
	if fields["_worker.js"] {
		t.Error("顶层不能直接放 _worker.js（必须包在 _worker.bundle 里）")
	}
	if fields["metadata"] {
		t.Error("顶层不能直接放 metadata（必须包在 _worker.bundle 里）")
	}
	if !fields["branch"] {
		t.Error("缺少 branch 字段")
	}
}

// 部署时命中 8000119 要能被识别（这是换项目名重试的触发条件）。
func TestDeployProjectLimit(t *testing.T) {
	c, _ := mockCF(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"success": false,
			"errors": []map[string]any{
				{"code": 8000119, "message": "You have exceeded your project limit"},
			},
		})
	})

	_, err := c.DeployPagesWorker(context.Background(), PagesDeployOptions{
		AccountID: "acc1",
		Project:   "proj",
		Script:    []byte("x"),
	})
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("应是 *APIError，实际 %T", err)
	}
	if !apiErr.IsProjectLimit() {
		t.Errorf("应识别为 8000119，实际 code=%d", apiErr.Code)
	}
}

// KV 读取失败要静默返回 false，不能报错（不该阻塞部署）。
func TestGetKVValueSilentFailure(t *testing.T) {
	c, _ := mockCF(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})

	_, ok := c.GetKVValue(context.Background(), "acc1", "ns1", "CONFIG")
	if ok {
		t.Error("403 时应返回 false")
	}
}

func TestGetKVValueSuccess(t *testing.T) {
	c, _ := mockCF(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/values/CONFIG") {
			t.Errorf("路径不对：%s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"uuid":"abc"}`))
	})

	val, ok := c.GetKVValue(context.Background(), "acc1", "ns1", "CONFIG")
	if !ok {
		t.Fatal("应读到值")
	}
	if val != `{"uuid":"abc"}` {
		t.Errorf("值不对：%q", val)
	}
}

// KV 写入用 text/plain，不能是 JSON。
func TestSetKVValueContentType(t *testing.T) {
	c, _ := mockCF(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("应为 PUT，实际 %s", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "text/plain" {
			t.Errorf("Content-Type 应为 text/plain，实际 %q", ct)
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
	})

	if err := c.SetKVValue(context.Background(), "acc1", "ns1", "CONFIG", `{"a":1}`); err != nil {
		t.Fatal(err)
	}
}

// 域名列表必须用 /domains 子接口（project.domains 会漏掉 initializing 的域名）。
func TestListPagesDomainsUsesSubresource(t *testing.T) {
	c, _ := mockCF(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/pages/projects/proj/domains") {
			t.Errorf("必须用 /domains 子接口，实际路径：%s", r.URL.Path)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"result": []map[string]string{
				{"name": "a.example.com", "status": "active"},
				{"name": "b.example.com", "status": "initializing"},
			},
		})
	})

	domains, err := c.ListPagesDomains(context.Background(), "acc1", "proj")
	if err != nil {
		t.Fatal(err)
	}
	if len(domains) != 2 {
		t.Fatalf("应列出 2 个域名（含 initializing），实际 %d", len(domains))
	}
	if domains[1].Status != "initializing" {
		t.Errorf("应保留 initializing 状态，实际 %q", domains[1].Status)
	}
}

// 域名解绑要用 DELETE + 路径里的域名。
func TestRemovePagesDomain(t *testing.T) {
	c, _ := mockCF(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("应为 DELETE，实际 %s", r.Method)
		}
		if !strings.HasSuffix(r.URL.Path, "/domains/cf.example.com") {
			t.Errorf("路径不对：%s", r.URL.Path)
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
	})

	if err := c.RemovePagesDomain(context.Background(), "acc1", "proj", "cf.example.com"); err != nil {
		t.Fatal(err)
	}
}

// account-owned Token 在 /user/tokens/verify 上 401 时，
// 要回退到 /accounts/{id}/tokens/verify。
func TestVerifyTokenFallbackToAccount(t *testing.T) {
	c, _ := mockCF(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/user/tokens/verify"):
			writeJSON(w, http.StatusUnauthorized, map[string]any{
				"success": false,
				"errors":  []map[string]any{{"code": 1000, "message": "Invalid API Token"}},
			})
		case strings.HasSuffix(r.URL.Path, "/accounts/acc1/tokens/verify"):
			writeJSON(w, http.StatusOK, map[string]any{
				"success": true,
				"result":  map[string]string{"id": "tok1", "status": "active"},
			})
		default:
			t.Errorf("意外路径：%s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})

	r, err := c.VerifyToken(context.Background(), "acc1")
	if err != nil {
		t.Fatalf("应回退成功：%v", err)
	}
	if r.Status != "active" {
		t.Errorf("状态不对：%q", r.Status)
	}
}

// 没有 accountId 时不回退，直接把用户维度的错误抛出来。
func TestVerifyTokenNoFallbackWithoutAccountID(t *testing.T) {
	calls := 0
	c, _ := mockCF(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"success": false,
			"errors":  []map[string]any{{"code": 1000, "message": "Invalid API Token"}},
		})
	})

	if _, err := c.VerifyToken(context.Background(), ""); err == nil {
		t.Fatal("应报错")
	}
	if calls != 1 {
		t.Errorf("无 accountId 时不该重试，实际调用了 %d 次", calls)
	}
}

// 网络错误要转成可读提示。
func TestNetworkErrorMessage(t *testing.T) {
	c := New(Options{Token: "t", APIBase: "http://127.0.0.1:1"})
	_, err := c.ListAccounts(context.Background())
	if err == nil {
		t.Fatal("应报错")
	}
	if !strings.Contains(err.Error(), "网络请求失败") {
		t.Errorf("错误信息应提示网络问题，实际：%v", err)
	}
}

// APIBase 末尾斜杠要能正确处理。
func TestAPIBaseTrailingSlash(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "//") {
			t.Errorf("路径出现双斜杠：%s", r.URL.Path)
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "result": []any{}})
	}))
	defer srv.Close()

	c := New(Options{Token: "t", APIBase: srv.URL + "/"})
	if _, err := c.ListAccounts(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// Token 两端空白在**构造时**就被裁掉。
//
// 注意：只有在 `New()` 里裁剪。直接改 c.token 字段（测试后门）不会被裁，
// 这是刻意的 —— 生产路径永远经过 New()。
func TestTokenTrimmed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer clean-token" {
			t.Errorf("Token 未裁剪：%q", got)
		}
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "result": []any{}})
	}))
	defer srv.Close()

	c := New(Options{Token: "  clean-token  ", APIBase: srv.URL})
	if _, err := c.ListAccounts(context.Background()); err != nil {
		t.Fatal(err)
	}
}
