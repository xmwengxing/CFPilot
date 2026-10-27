package cfapi

// Pages 部署表单结构的回归测试。
//
// ## 为什么单独测这个
//
// 早期实现发的表单是：
//
//	_worker.js = 脚本
//	metadata   = {...}
//
// 而 Pages 部署 API 要求的是**嵌套 multipart**：
//
//	外层：branch / manifest / _worker.bundle
//	内层（_worker.bundle 内容）：metadata / _worker.js
//
// 结果每一次部署都返回：
//
//	code 8000096
//	"A \"manifest\" field was expected in the request body but was not provided."
//
// 而这个错误被上层误判成 8000119（风控），导致：
//   - 反复换名重试 → 账号里堆积 8 个孤儿项目
//   - 部署永远不成功
//   - 数据面没部署 → 优选阶段二 101 全失败 → 用户以为「TLS 全挂」
//
// **一个字段名错误派生出三个用户可见的严重问题。**
//
// 本测试逐层解析 multipart，确保结构完全正确。

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 完整校验部署表单的嵌套结构。
func TestDeployPagesWorkerFormStructure(t *testing.T) {
	var gotBranch, gotManifest string
	var gotBundle []byte
	var gotBundleCT string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ct := r.Header.Get("Content-Type")
		mediaType, params, err := mime.ParseMediaType(ct)
		if err != nil || mediaType != "multipart/form-data" {
			t.Fatalf("外层 Content-Type 不对：%q", ct)
		}

		mr := multipart.NewReader(r.Body, params["boundary"])
		form, err := mr.ReadForm(16 << 20)
		if err != nil {
			t.Fatalf("解析外层 multipart 失败：%v", err)
		}

		gotBranch = form.Value["branch"][0]
		if v := form.Value["manifest"]; len(v) > 0 {
			gotManifest = v[0]
		}
		for name, fhs := range form.File {
			if name == "_worker.bundle" {
				f, _ := fhs[0].Open()
				gotBundle, _ = io.ReadAll(f)
				_ = f.Close()
				gotBundleCT = fhs[0].Header.Get("Content-Type")
			}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"result":  map[string]any{"id": "dep1", "environment": "production"},
		})
	}))
	defer srv.Close()

	c := New(Options{Token: "t", APIBase: srv.URL})
	_, err := c.DeployPagesWorker(context.Background(), PagesDeployOptions{
		AccountID: "acc",
		Project:   "proj",
		Script:    []byte("export default { async fetch() { return new Response('x') } }"),
	})
	if err != nil {
		t.Fatalf("部署失败：%v", err)
	}

	// ---- 外层字段 ----
	if gotBranch != "main" {
		t.Errorf("branch 应为 main，实际 %q", gotBranch)
	}
	if gotManifest != "{}" {
		t.Errorf("manifest 必须是 \"{}\"（缺失会 8000096），实际 %q", gotManifest)
	}
	if len(gotBundle) == 0 {
		t.Fatal("_worker.bundle 为空")
	}

	// ---- 内层结构 ----
	innerMT, innerParams, err := mime.ParseMediaType(gotBundleCT)
	if err != nil || innerMT != "multipart/form-data" {
		t.Fatalf("_worker.bundle 的 Content-Type 应是 multipart，实际 %q", gotBundleCT)
	}

	innerMR := multipart.NewReader(strings.NewReader(string(gotBundle)), innerParams["boundary"])
	innerForm, err := innerMR.ReadForm(16 << 20)
	if err != nil {
		t.Fatalf("解析内层 multipart 失败：%v", err)
	}

	// 内层必须有 metadata。
	// 注意：带 filename 的 part 会被 Go 归入 File 而不是 Value，
	// 所以两处都要看。
	var metaRaw string
	if v := innerForm.Value["metadata"]; len(v) > 0 {
		metaRaw = v[0]
	}
	if metaRaw == "" {
		if fhs := innerForm.File["metadata"]; len(fhs) > 0 {
			f, err := fhs[0].Open()
			if err == nil {
				b, _ := io.ReadAll(f)
				_ = f.Close()
				metaRaw = string(b)
			}
		}
	}
	if metaRaw == "" {
		t.Fatal("内层缺少 metadata 字段")
	}

	var meta map[string]any
	if err := json.Unmarshal([]byte(metaRaw), &meta); err != nil {
		t.Fatalf("metadata 不是合法 JSON：%v", err)
	}
	if meta["main_module"] != "_worker.js" {
		t.Errorf("main_module 应为 _worker.js，实际 %v", meta["main_module"])
	}
	// 绝不能带 compatibility_date（会让 Pages 忽略 _worker.js）
	if _, has := meta["compatibility_date"]; has {
		t.Error("metadata 绝不能带 compatibility_date")
	}

	// 内层必须有 _worker.js 文件
	if len(innerForm.File["_worker.js"]) == 0 {
		t.Error("内层缺少 _worker.js 文件字段")
	}
}

// 8000096（缺 manifest）必须能被识别成明确的错误，
// 而不是被当成 8000119 风控。
func TestDeployErrorCode8000096(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": false,
			"errors": []map[string]any{
				{"code": 8000096, "message": `A "manifest" field was expected in the request body but was not provided.`},
			},
		})
	}))
	defer srv.Close()

	c := New(Options{Token: "t", APIBase: srv.URL})
	_, err := c.DeployPagesWorker(context.Background(), PagesDeployOptions{
		AccountID: "acc",
		Project:   "proj",
		Script:    []byte("x"),
	})
	if err == nil {
		t.Fatal("应报错")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("应是 *APIError，实际 %T", err)
	}
	if apiErr.Code != 8000096 {
		t.Errorf("错误码应为 8000096，实际 %d", apiErr.Code)
	}
	// 关键：不能被当成项目级风控
	if apiErr.IsProjectLimit() {
		t.Error("8000096 不能被判定为 8000119 风控")
	}
}
