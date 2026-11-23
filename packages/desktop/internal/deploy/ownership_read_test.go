package deploy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestOwnershipReadFailureIsBlocking 守护「读不到 ≠ 不存在」。
//
// ## 背景（2026-10-28 真机缺陷）
//
// 旧实现用 `GetKVValue`（不存在与读取失败都返回 false），
// 于是 KV 归属判定在下列情况下**全部**落到 `empty`（**不阻断**）：
//
//   - KV 属于别的账号
//   - Token 没有该 KV 的读权限（403）
//   - 网络抖动 / Cloudflare 5xx
//
// → 继续建项目、写 KV → **孤儿 Pages 项目 + 半成品实例**，
// 用户完全不知道发生了什么。
//
// 现在用三态读取：读不到时按 `occupied`（**不可放行**）处理，
// 且提示要说清「无法确认」而不是「已被占用」。
//
// ⚠️ 与 CLI 版 packages/cli/src/deploy/pages-deploy.ts 语义一致
// （AGENTS.md §1.3 / §2.2）。
func TestOwnershipReadFailureIsBlocking(t *testing.T) {
	// 假 Cloudflare API：所有 KV 读取都返回 403
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	opt := DefaultOptions()
	opt.Token = "test-token"
	opt.AccountID = "acc1"
	opt.KVNamespaceID = "ns1"
	opt.APIBase = srv.URL
	d := New(opt)

	verdict, detail := d.inspectKvOwnership(context.Background(), nil, "some-control-project")
	if verdict == OwnEmpty {
		t.Fatalf("读不到 KV 时绝不能判成 empty（会假放行），实际=%v detail=%q", verdict, detail)
	}
	if !strings.Contains(detail, "无法确认") {
		t.Errorf("提示应说明「无法确认归属」，实际=%q", detail)
	}
}

// writeKeys 让假 Cloudflare API 回应「列出 KV 键名」。
//
// 归属判定现在靠**键名集合**（见 inspectKvOwnership），
// 假服务器不实现这个端点的话所有归属用例都会走到「无法确认」分支。
func writeKeys(w http.ResponseWriter, names ...string) {
	type item struct {
		Name string `json:"name"`
	}
	list := make([]item, 0, len(names))
	for _, n := range names {
		list = append(list, item{Name: n})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": list})
}

// isKeysRequest 判断请求是不是「列键名」。
func isKeysRequest(path string) bool {
	return strings.Contains(path, "/storage/kv/namespaces/") && strings.HasSuffix(path, "/keys")
}

// TestOwnershipEmptyWhenReallyEmpty 确认「确实为空」时仍判 empty（不阻断）。
func TestOwnershipEmptyWhenReallyEmpty(t *testing.T) {
	// 假 Cloudflare API：键名列表为空，其余 KV 读取都是 404（键不存在）
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isKeysRequest(r.URL.Path) {
			writeKeys(w)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	opt := DefaultOptions()
	opt.Token = "test-token"
	opt.AccountID = "acc1"
	opt.KVNamespaceID = "ns1"
	opt.APIBase = srv.URL
	d := New(opt)

	verdict, detail := d.inspectKvOwnership(context.Background(), nil, "some-control-project")
	if verdict != OwnEmpty {
		t.Fatalf("空命名空间应判 empty，实际=%v detail=%q", verdict, detail)
	}
}

// TestOwnershipForeignDetected 确认小写 config 键仍能识别为 foreign。
func TestOwnershipForeignDetected(t *testing.T) {
	// 假 Cloudflare API：键名里有小写 config（CFPilot 自己从不写这个键）
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isKeysRequest(r.URL.Path) {
			writeKeys(w, "config")
			return
		}
		if strings.Contains(r.URL.Path, "/values/config") {
			_, _ = w.Write([]byte(`{"uuid":"someone-else"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	opt := DefaultOptions()
	opt.Token = "test-token"
	opt.AccountID = "acc1"
	opt.KVNamespaceID = "ns1"
	opt.APIBase = srv.URL
	d := New(opt)

	verdict, _ := d.inspectKvOwnership(context.Background(), nil, "some-control-project")
	if verdict != OwnForeign {
		t.Fatalf("含小写 config 键应判 foreign，实际=%v", verdict)
	}
}

// TestOwnershipThirdPartyKeysBlocked 是「别家 KVT 被误认为空」的回归。
//
// 另一个面板项目用的是自己的键名（c / c_ver / wk / rm），既不叫 config
// 也不叫 CONFIG。早前只探那两个键，于是这种命名空间被判成 `empty`
// （不阻断），用户一部署就把对方的配置覆盖掉。
func TestOwnershipThirdPartyKeysBlocked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isKeysRequest(r.URL.Path) {
			writeKeys(w, "c", "c_ver", "wk", "rm")
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	opt := DefaultOptions()
	opt.Token = "test-token"
	opt.AccountID = "acc1"
	opt.KVNamespaceID = "ns1"
	opt.APIBase = srv.URL
	d := New(opt)

	verdict, detail := d.inspectKvOwnership(context.Background(), nil, "some-control-project")
	if verdict != OwnForeign {
		t.Fatalf("含其它项目的键应判 foreign，实际=%v detail=%q", verdict, detail)
	}
	if !strings.Contains(detail, "c_ver") {
		t.Errorf("提示里应带上实际键名，实际=%q", detail)
	}
}

// TestOwnershipSessionResidueIsStale 确认只剩会话类键时仍认作本项目残留。
func TestOwnershipSessionResidueIsStale(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isKeysRequest(r.URL.Path) {
			writeKeys(w, "SESSION:abc", "ONETIME:def")
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	opt := DefaultOptions()
	opt.Token = "test-token"
	opt.AccountID = "acc1"
	opt.KVNamespaceID = "ns1"
	opt.APIBase = srv.URL
	d := New(opt)

	verdict, _ := d.inspectKvOwnership(context.Background(), nil, "some-control-project")
	if verdict != OwnStale {
		t.Fatalf("只剩会话键应判 stale，实际=%v", verdict)
	}
}
