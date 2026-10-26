package server

// 账户类 API 的端到端测试。
//
// 这些测试直接打真实 HTTP 端口（不是直接调 handler），
// 目的是同时验证三件事：
//   1. 路由挂对了
//   2. 鉴权生效了（未登录 401、登录后 200）
//   3. 返回结构正是渲染层期望的字段名

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/store"
)

// newAuthedServer 起一个带临时凭据库的服务，并返回登录后的 Cookie。
func newAuthedServer(t *testing.T) (*Server, string, *http.Cookie) {
	t.Helper()
	s, base := newTestServer(t)
	s.SetStore(store.New(t.TempDir()))
	cookie := loginCookie(t, s, base)
	return s, base, cookie
}

// 未登录时账户 API 必须 401（与其它 API 一致）。
func TestCredRoutesRequireSession(t *testing.T) {
	_, base := newTestServer(t)

	paths := []string{
		"/api/cred/state",
		"/api/profile/list",
		"/api/profile/current",
	}
	for _, p := range paths {
		if code := doGet(t, base+p, nil); code != http.StatusUnauthorized {
			t.Errorf("%s 未登录应 401，实际 %d", p, code)
		}
	}
}

// EMPTY（无任何账户）时，各接口要返回合理的空值而不是报错。
func TestCredStateEmpty(t *testing.T) {
	_, base, cookie := newAuthedServer(t)

	code, body := getJSON(t, base+"/api/cred/state", cookie)
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d (%v)", code, body)
	}
	if body["hasToken"] != false {
		t.Errorf("空库 hasToken 应为 false，实际 %v", body["hasToken"])
	}
	if body["accountId"] != "" {
		t.Errorf("空库 accountId 应为空串，实际 %v", body["accountId"])
	}

	// profile/list 应为空数组 + 空 activeId
	code, listBody := getJSON(t, base+"/api/profile/list", cookie)
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", code)
	}
	profiles, ok := listBody["profiles"].([]any)
	if !ok {
		t.Fatalf("profiles 应是数组，实际 %T", listBody["profiles"])
	}
	if len(profiles) != 0 {
		t.Errorf("应为空数组，实际 %d 条", len(profiles))
	}
	if listBody["activeId"] != "" {
		t.Errorf("activeId 应为空串，实际 %v", listBody["activeId"])
	}
}

// 新建账户 → 列表 → 切换 → 删除，走完整生命周期。
func TestProfileLifecycle(t *testing.T) {
	_, base, cookie := newAuthedServer(t)

	// 新建（带 Token）
	code, created := postJSON(t, base+"/api/profile/create", cookie, map[string]any{
		"name":    "第一个账户",
		"cfToken": "cfat_AAA",
	})
	if code != http.StatusOK {
		t.Fatalf("新建失败：%d %v", code, created)
	}
	profile, _ := created["profile"].(map[string]any)
	id1, _ := profile["id"].(string)
	if id1 == "" {
		t.Fatal("新建后应返回 id")
	}
	// Token 明文绝不能出现在响应里
	if _, leaked := profile["cfToken"]; leaked {
		t.Error("响应里泄露了 cfToken 字段")
	}
	if profile["hasToken"] != true {
		t.Errorf("应报告 hasToken=true，实际 %v", profile["hasToken"])
	}

	// 再建一个
	code, created2 := postJSON(t, base+"/api/profile/create", cookie, map[string]any{
		"name":    "第二个账户",
		"cfToken": "cfat_BBB",
	})
	if code != http.StatusOK {
		t.Fatal("第二个新建失败")
	}
	profile2, _ := created2["profile"].(map[string]any)
	id2, _ := profile2["id"].(string)
	if id2 == id1 {
		t.Fatal("两个账户的 id 不能相同")
	}

	// 列表应有 2 条，且 activeId = id2（最后建的自动激活）
	code, listBody := getJSON(t, base+"/api/profile/list", cookie)
	if code != http.StatusOK {
		t.Fatal("列表失败")
	}
	profiles, _ := listBody["profiles"].([]any)
	if len(profiles) != 2 {
		t.Fatalf("应有 2 条，实际 %d", len(profiles))
	}
	if listBody["activeId"] != id2 {
		t.Errorf("新建后应自动激活最新账户，期望 %s 实际 %v", id2, listBody["activeId"])
	}

	// 切回第一个
	code, switched := postJSON(t, base+"/api/profile/switch", cookie, map[string]any{"id": id1})
	if code != http.StatusOK {
		t.Fatal("切换失败")
	}
	if switched["ok"] != true || switched["activeId"] != id1 {
		t.Errorf("切换结果不对：%v", switched)
	}

	// current 应返回第一个
	code, cur := getJSON(t, base+"/api/profile/current", cookie)
	if code != http.StatusOK {
		t.Fatal("取当前账户失败")
	}
	curProfile, _ := cur["profile"].(map[string]any)
	if curProfile["id"] != id1 {
		t.Errorf("当前账户应为 %s，实际 %v", id1, curProfile["id"])
	}

	// 删除第一个（当前激活的），应顺延到第二个
	code, del := postJSON(t, base+"/api/profile/delete", cookie, map[string]any{"id": id1})
	if code != http.StatusOK {
		t.Fatal("删除失败")
	}
	if del["deleted"] != true {
		t.Error("应报告已删除")
	}
	if del["activeId"] != id2 {
		t.Errorf("删激活项后应顺延到 %s，实际 %v", id2, del["activeId"])
	}
}

// 更新账户：只改传了的字段。
func TestProfileUpdate(t *testing.T) {
	_, base, cookie := newAuthedServer(t)

	_, created := postJSON(t, base+"/api/profile/create", cookie, map[string]any{
		"name":    "原名字",
		"cfToken": "cfat_OLD",
	})
	profile, _ := created["profile"].(map[string]any)
	id, _ := profile["id"].(string)

	// 只改名字（不传 cfToken）
	code, updated := postJSON(t, base+"/api/profile/update", cookie, map[string]any{
		"id":   id,
		"name": "新名字",
	})
	if code != http.StatusOK {
		t.Fatalf("更新失败：%d %v", code, updated)
	}
	p, _ := updated["profile"].(map[string]any)
	if p["name"] != "新名字" {
		t.Errorf("名字应改成「新名字」，实际 %v", p["name"])
	}
	// 没传的 Token 必须保留
	if p["hasToken"] != true {
		t.Error("没传 cfToken 时不该清空 Token")
	}
}

// 保存当前账户凭据（对应界面的「保存 Token」按钮）。
func TestCredSave(t *testing.T) {
	_, base, cookie := newAuthedServer(t)

	// 空库直接保存 → 自动新建一份
	code, saved := postJSON(t, base+"/api/cred/save", cookie, map[string]any{
		"cfToken":       "cfat_SAVED",
		"accountId":     "acct123",
		"kvNamespaceId": "kv456",
		"panelPassword": "pw",
	})
	if code != http.StatusOK {
		t.Fatalf("保存失败：%d %v", code, saved)
	}

	// state 应反映出来
	code, state := getJSON(t, base+"/api/cred/state", cookie)
	if code != http.StatusOK {
		t.Fatal("取状态失败")
	}
	if state["hasToken"] != true {
		t.Error("应报告 hasToken=true")
	}
	if state["accountId"] != "acct123" {
		t.Errorf("accountId 不对：%v", state["accountId"])
	}
	if state["kvNamespaceId"] != "kv456" {
		t.Errorf("kvNamespaceId 不对：%v", state["kvNamespaceId"])
	}
}

// 清除凭据。
func TestCredWipe(t *testing.T) {
	_, base, cookie := newAuthedServer(t)

	postJSON(t, base+"/api/cred/save", cookie, map[string]any{"cfToken": "cfat_X"})

	code, wiped := postJSON(t, base+"/api/cred/wipe", cookie, map[string]any{})
	if code != http.StatusOK {
		t.Fatalf("清除失败：%d %v", code, wiped)
	}

	// 清完应回到空状态
	_, state := getJSON(t, base+"/api/cred/state", cookie)
	if state["hasToken"] != false {
		t.Error("清除后 hasToken 应为 false")
	}
}

// 方法限制：写接口不接受 GET。
func TestCredWriteMethodsRejectGET(t *testing.T) {
	_, base, cookie := newAuthedServer(t)

	for _, p := range []string{"/api/cred/save", "/api/cred/wipe", "/api/profile/create"} {
		if code := doGetWithCookie(t, base+p, cookie); code != http.StatusMethodNotAllowed {
			t.Errorf("%s GET 应 405，实际 %d", p, code)
		}
	}
}

// 更新不存在的账户 → 400。
func TestProfileUpdateMissing(t *testing.T) {
	_, base, cookie := newAuthedServer(t)

	code, body := postJSON(t, base+"/api/profile/update", cookie, map[string]any{
		"id":   "acc_does_not_exist",
		"name": "x",
	})
	if code != http.StatusBadRequest {
		t.Errorf("应 400，实际 %d (%v)", code, body)
	}
}

// ---------- 测试辅助 ----------

func getJSON(t *testing.T, url string, cookie *http.Cookie) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var body map[string]any
	_ = json.NewDecoder(res.Body).Decode(&body)
	return res.StatusCode, body
}

func doGetWithCookie(t *testing.T, url string, cookie *http.Cookie) int {
	t.Helper()
	code, _ := getJSON(t, url, cookie)
	return code
}
