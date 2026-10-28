package server

// 部署类接口的**串号 / 语义漂移**回归测试。
//
// 覆盖四个真实踩过的坑：
//
//  1. **B5 账号串号**：用外部 Token 探测账号，却把账号 ID 写进当前 profile
//     → profile 变成「token A + accountId B」的混合体
//     → 之后拿 token A 去列 account B 的 KV → 403 / 空。
//
//  2. **B6 KV 串号**：凭据接口无视请求里的 kvNamespaceId，
//     只用 profile 里保存的 KV → 返回的是**另一个 KV** 的面板密码。
//
//  3. **B8 死字段**：界面的「强制重新部署」复选框完全无效。
//
//  4. KV 选择规则必须**两个接口一致**（请求优先于 profile）。
//
// 这些接口都要访问 Cloudflare API，所以测试把 s.cfBase 指向
// httptest 服务器（见 Server.SetCFAPIBase）。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/store"
)

// fakeCF 是一台假的 Cloudflare API。
type fakeCF struct {
	// accounts 是「按 Token 区分」的账号列表。
	accounts map[string][]map[string]string
	// kv 是「命名空间 ID → 键 → 值」。
	kv map[string]map[string]string
	// seenKV 记录被读过的 KV 命名空间（用来断言「用对了 KV」）。
	seenKV []string
	// seenToken 记录请求带的 Token。
	seenToken []string
}

func newFakeCF() *fakeCF {
	return &fakeCF{
		accounts: map[string][]map[string]string{},
		kv:       map[string]map[string]string{},
	}
}

func (f *fakeCF) handler(t *testing.T) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		f.seenToken = append(f.seenToken, token)

		// ---- 账号列表 ----
		if r.URL.Path == "/accounts" {
			list := f.accounts[token]
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": list})
			return
		}

		// ---- KV 值 ----
		// 路径：/accounts/{acc}/storage/kv/namespaces/{ns}/values/{key}
		if strings.Contains(r.URL.Path, "/storage/kv/namespaces/") {
			parts := strings.Split(r.URL.Path, "/values/")
			if len(parts) == 2 {
				ns := parts[0][strings.LastIndex(parts[0], "/")+1:]
				key := parts[1]
				f.seenKV = append(f.seenKV, ns)
				if v, has := f.kv[ns][key]; has {
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(v))
					return
				}
				w.WriteHeader(http.StatusNotFound)
				return
			}
		}

		t.Errorf("未处理的路由：%s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	}
}

// manifestJSON 造一份部署清单。
func manifestJSON(controlProject, panelPassword string) string {
	m := map[string]any{
		"v":                1,
		"controlProject":   controlProject,
		"dataProject":      controlProject + "-data",
		"controlSubdomain": controlProject + ".pages.dev",
		"dataSubdomain":    controlProject + "-data.pages.dev",
		"build":            "abc1234-deadbeef",
		"at":               "2026-10-27T00:00:00.000Z",
		"credentials": map[string]any{
			"panelPath":     "/panel-" + controlProject,
			"panelPassword": panelPassword,
			"uuid":          "11111111-2222-3333-4444-555555555555",
			"wsPath":        "/ws-" + controlProject,
		},
	}
	raw, _ := json.Marshal(m)
	return string(raw)
}

// ---------- B5：外部 Token 探测账号不得落盘 ----------

// 用**外部 Token** 探测账号时，探测结果只回显，**不写进当前 profile**。
//
// 否则当前 profile 会变成「token A（没更新）+ accountId B（外部 token 的账号）」，
// 之后拿 token A 去列 account B 的 KV → 403 / 空列表。
func TestAccountDetectExternalTokenNotPersisted(t *testing.T) {
	f := newFakeCF()
	f.accounts["external-token"] = []map[string]string{
		{"id": "acc-external", "name": "外部账号"},
	}
	cfSrv := httptest.NewServer(f.handler(t))
	t.Cleanup(cfSrv.Close)

	s, base := newTestServer(t)
	s.SetCFAPIBase(cfSrv.URL)
	st := newEmptyStore(t)
	if _, err := st.Create("a", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SaveActive(patchTokenAndAccount("profile-token", "acc-original")); err != nil {
		t.Fatal(err)
	}
	s.SetStore(st)
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/account/detect", cookie, map[string]any{
		"token": "external-token",
	})
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d (%v)", code, body)
	}
	// 探测结果要照常回显
	if body["accountId"] != "acc-external" {
		t.Errorf("应回显探测到的账号，实际 %v", body["accountId"])
	}
	// ⚠️ 但绝不能落盘
	p, err := st.Active()
	if err != nil || p == nil {
		t.Fatalf("读取 profile 失败：%v", err)
	}
	if p.AccountID != "acc-original" {
		t.Errorf("外部 Token 探测不该改写 profile 的账号 ID，实际 %q（应仍是 acc-original）", p.AccountID)
	}
	if p.CfToken != "profile-token" {
		t.Errorf("profile 的 Token 不该变，实际 %q", p.CfToken)
	}
}

// 用**当前 profile 自己的 Token** 探测账号时，结果要写回 profile。
//
// （这是界面「检测账号」按钮走的路径 —— 它不传 token。）
func TestAccountDetectProfileTokenPersisted(t *testing.T) {
	f := newFakeCF()
	f.accounts["profile-token"] = []map[string]string{
		{"id": "acc-detected", "name": "检测到的账号"},
	}
	cfSrv := httptest.NewServer(f.handler(t))
	t.Cleanup(cfSrv.Close)

	s, base := newTestServer(t)
	s.SetCFAPIBase(cfSrv.URL)
	st := newEmptyStore(t)
	if _, err := st.Create("a", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SaveActive(patchTokenAndAccount("profile-token", "acc-original")); err != nil {
		t.Fatal(err)
	}
	s.SetStore(st)
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/account/detect", cookie, map[string]any{})
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d (%v)", code, body)
	}
	if body["accountId"] != "acc-detected" {
		t.Errorf("应回显探测到的账号，实际 %v", body["accountId"])
	}
	p, err := st.Active()
	if err != nil || p == nil {
		t.Fatalf("读取 profile 失败：%v", err)
	}
	if p.AccountID != "acc-detected" {
		t.Errorf("用 profile 自己的 Token 探测时应写回账号 ID，实际 %q", p.AccountID)
	}
}

// ---------- B6：凭据接口必须用请求里的 KV ----------

// 凭据接口必须用**请求里的** kvNamespaceId，而不是 profile 里保存的。
//
// 否则下拉框选中的 KV 与 profile 不一致时，
// 返回的是另一个 KV 的面板密码 / UUID / WS 路径
// → 用户拿错密码去登别的实例。
func TestDeployCredentialsUsesRequestedKV(t *testing.T) {
	f := newFakeCF()
	f.kv["kv-profile"] = map[string]string{
		"CFP_DEPLOY_MANIFEST": manifestJSON("control-profile", "PASSWORD-FOR-PROFILE-KV"),
	}
	f.kv["kv-selected"] = map[string]string{
		"CFP_DEPLOY_MANIFEST": manifestJSON("control-selected", "PASSWORD-FOR-SELECTED-KV"),
	}
	cfSrv := httptest.NewServer(f.handler(t))
	t.Cleanup(cfSrv.Close)

	s, base := newTestServer(t)
	s.SetCFAPIBase(cfSrv.URL)
	st := newEmptyStore(t)
	if _, err := st.Create("a", nil); err != nil {
		t.Fatal(err)
	}
	// profile 里存的是 kv-profile
	if _, err := st.SaveActive(store.Patch{
		CfToken:       ptr("cfat_testtoken"),
		AccountID:     ptr("acc123"),
		KVNamespaceID: ptr("kv-profile"),
	}); err != nil {
		t.Fatal(err)
	}
	s.SetStore(st)
	cookie := loginCookie(t, s, base)

	// 界面传的是当前选中的 KV（kv-selected）
	_, body := postJSON(t, base+"/api/deploy/credentials", cookie, map[string]any{
		"kvNamespaceId": "kv-selected",
	})
	if ok, _ := body["ok"].(bool); !ok {
		t.Fatalf("应返回 ok=true，实际 %v", body)
	}
	if got := body["panelPassword"]; got != "PASSWORD-FOR-SELECTED-KV" {
		t.Errorf("应返回所选 KV 的面板密码，实际 %v", got)
	}
	if got := body["panelPath"]; got != "/panel-control-selected" {
		t.Errorf("应返回所选 KV 的面板路径，实际 %v", got)
	}
}

// 不传 kvNamespaceId 时，回落到 profile 里保存的 KV。
func TestDeployCredentialsFallsBackToProfileKV(t *testing.T) {
	f := newFakeCF()
	f.kv["kv-profile"] = map[string]string{
		"CFP_DEPLOY_MANIFEST": manifestJSON("control-profile", "PASSWORD-FOR-PROFILE-KV"),
	}
	f.kv["kv-selected"] = map[string]string{
		"CFP_DEPLOY_MANIFEST": manifestJSON("control-selected", "PASSWORD-FOR-SELECTED-KV"),
	}
	cfSrv := httptest.NewServer(f.handler(t))
	t.Cleanup(cfSrv.Close)

	s, base := newTestServer(t)
	s.SetCFAPIBase(cfSrv.URL)
	st := newEmptyStore(t)
	if _, err := st.Create("a", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SaveActive(store.Patch{
		CfToken:       ptr("cfat_testtoken"),
		AccountID:     ptr("acc123"),
		KVNamespaceID: ptr("kv-profile"),
	}); err != nil {
		t.Fatal(err)
	}
	s.SetStore(st)
	cookie := loginCookie(t, s, base)

	_, body := postJSON(t, base+"/api/deploy/credentials", cookie, map[string]any{})
	if got := body["panelPassword"]; got != "PASSWORD-FOR-PROFILE-KV" {
		t.Errorf("不传 KV 时应回落到 profile 的 KV，实际 %v", got)
	}
}

// 两个接口的 KV 选择规则必须一致（请求优先，留空才回落 profile）。
func TestResolveKVNamespaceID(t *testing.T) {
	cases := []struct {
		name      string
		requested string
		profileKV string
		want      string
	}{
		{"请求优先", "kv-selected", "kv-profile", "kv-selected"},
		{"请求留空回落", "", "kv-profile", "kv-profile"},
		{"请求只有空格也回落", "   ", "kv-profile", "kv-profile"},
		{"两边都空", "", "", ""},
	}
	for _, tc := range cases {
		if got := resolveKVNamespaceID(tc.requested, tc.profileKV); got != tc.want {
			t.Errorf("%s：期望 %q，实际 %q", tc.name, tc.want, got)
		}
	}
}

// ---------- B8：「强制重新部署」必须真的生效 ----------

// 「强制重新部署」= 忽略「版本相同则跳过」。
//
// 之前 req.Force 是死字段（声明了但一次都没用），
// 勾了复选框但线上版本相同时照样跳过。
func TestDeploySkipSameVersion(t *testing.T) {
	cases := []struct {
		name  string
		mode  string
		force bool
		want  bool
	}{
		{"默认 auto 跳过", "auto", false, true},
		{"auto + 强制 → 不跳过", "auto", true, false},
		{"空 mode + 强制 → 不跳过", "", true, false},
		{"update 永不跳过", "update", false, false},
		{"update + 强制 → 不跳过", "update", true, false},
	}
	for _, tc := range cases {
		if got := deploySkipSameVersion(tc.mode, tc.force); got != tc.want {
			t.Errorf("%s：期望 %v，实际 %v", tc.name, tc.want, got)
		}
	}
}

// ptr 返回指向 v 的指针（构造 store.Patch 用）。
func ptr(v string) *string { return &v }
