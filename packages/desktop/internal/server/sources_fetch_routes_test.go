package server

import (
	"net/http"
	"testing"
)

// 「加载数据源清单」弹窗的接口：不写池、不要求来源启用、按 ID 拉原文合并。
// 这里只覆盖不发真实网络请求的分支（空选择 / 不存在的 ID / 未鉴权），
// 真实拉取由 FetchSourceText 自身及其既有测试保证。

func TestSourcesFetchRejectsEmptySelection(t *testing.T) {
	_, client, base := newSourcesAPIServer(t)
	code, body := sourcesRequest(t, client, http.MethodPost, base+"/api/sources/fetch", `{"ids":[]}`)
	if code != 200 || body["ok"] != false {
		t.Fatalf("空选择应返回 ok=false：code=%d body=%v", code, body)
	}
}

func TestSourcesFetchUnknownIDIsReported(t *testing.T) {
	_, client, base := newSourcesAPIServer(t)
	code, body := sourcesRequest(t, client, http.MethodPost, base+"/api/sources/fetch", `{"ids":["no-such-source"]}`)
	if code != 200 {
		t.Fatalf("未知 ID 不应让接口报错：code=%d body=%v", code, body)
	}
	if body["ok"] != false || body["count"] != float64(0) {
		t.Fatalf("未知 ID 应返回空结果：%v", body)
	}
	errs, ok := body["errors"].([]any)
	if !ok || len(errs) != 1 {
		t.Fatalf("未知 ID 应逐条说明失败原因：%v", body["errors"])
	}
}

func TestSourcesFetchRequiresSession(t *testing.T) {
	ts, _, _ := newSourcesAPIServer(t)
	res, err := http.Post(ts.URL+"/api/sources/fetch", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("无会话应 401，实际 %d", res.StatusCode)
	}
}
