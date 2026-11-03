package server

// 账号用量与额度的服务端测试。
//
// 重点验证：
//   - GraphQL 响应能被正确解析成逐日用量
//   - 缓存命中时**不再发起任何调用**
//   - 本地风控达到上限后**停止调用** Cloudflare
//   - 响应头里的速率限制能被解析出来

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/store"
)

// fakeUsageCF 是用量查询用的假 Cloudflare API。
type fakeUsageCF struct {
	// calls 记录被调用的次数
	calls atomic.Int64
	// graphQLCalls 记录 GraphQL 调用次数
	graphQLCalls atomic.Int64
	// plan 是订阅接口返回的套餐
	plan string
	// workers 是返回的 Workers 行（日期 / 脚本 / 状态 / 请求数）
	workers []map[string]any
}

func (f *fakeUsageCF) handler(t *testing.T) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		// 官方速率限制响应头（解析用）
		w.Header().Set("Ratelimit", `"default";r=1199;t=1`)
		w.Header().Set("Ratelimit-Policy", `"default";q=1200;w=300`)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/graphql"):
			f.graphQLCalls.Add(1)
			// ⚠️ 日期必须**相对今天**生成，不能写死。
			//
			// 写死具体日期的后果：第二天开始 fixture 的「今日」就变成昨日，
			// series[6]（今天）取不到数据，测试从那天起一直红。
			// 服务端按 UTC 算「今天」（见 usage.go 的 time.Now().UTC()），这里同口径。
			today := time.Now().UTC().Format("2006-01-02")
			yesterday := time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")
			workers := f.workers
			if workers == nil {
				workers = []map[string]any{
					{"sum": map[string]any{"requests": 10, "errors": 1, "subrequests": 12}, "dimensions": map[string]any{"date": today, "scriptName": "vls", "status": "success"}},
					{"sum": map[string]any{"requests": 3, "errors": 0, "subrequests": 0}, "dimensions": map[string]any{"date": today, "scriptName": "vls", "status": "exceededResources"}},
					{"sum": map[string]any{"requests": 5, "errors": 0, "subrequests": 0}, "dimensions": map[string]any{"date": yesterday, "scriptName": "vls", "status": "success"}},
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{
					"viewer": map[string]any{
						"accounts": []map[string]any{{
							"workersInvocationsAdaptive": workers,
							"kvOperationsAdaptiveGroups": []map[string]any{
								{"sum": map[string]any{"requests": 40}, "dimensions": map[string]any{"date": today, "actionType": "read"}},
								{"sum": map[string]any{"requests": 7}, "dimensions": map[string]any{"date": today, "actionType": "write"}},
								{"sum": map[string]any{"requests": 20}, "dimensions": map[string]any{"date": yesterday, "actionType": "read"}},
							},
							"kvStorageAdaptiveGroups": []map[string]any{
								{"max": map[string]any{"keyCount": 9, "byteCount": 432522}, "dimensions": map[string]any{"date": today}},
							},
						}},
					},
				},
			})
		case strings.HasSuffix(r.URL.Path, "/subscriptions"):
			plan := f.plan
			if plan == "" {
				plan = "free"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": true,
				"result": []map[string]any{
					{"rate_plan": map[string]any{"id": plan, "public_name": "Cloudflare Free Plan"}},
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"success":false,"errors":[{"code":10404,"message":"No route for that URI"}]}`))
		}
	}
}

// newUsageTestServer 造一个带假 Cloudflare API 的服务。
func newUsageTestServer(t *testing.T) (*Server, string, *fakeUsageCF) {
	t.Helper()
	fake := &fakeUsageCF{}
	srv := httptest.NewServer(fake.handler(t))
	t.Cleanup(srv.Close)
	s, base := newTestServer(t)
	s.SetCFAPIBase(srv.URL + "/client/v4")
	return s, base, fake
}

// useTokenStore 给服务塞一个带令牌的激活账户。
func useTokenStore(t *testing.T, s *Server, accountID string) {
	t.Helper()
	st := newEmptyStore(t)
	if _, err := st.Create("测试账号", &store.Profile{CfToken: "tok-1", AccountID: accountID}); err != nil {
		t.Fatal(err)
	}
	s.SetStore(st)
}

// 有 Token 时能取到逐日用量。
func TestUsageSnapshotParsesGraphQL(t *testing.T) {
	s, base, fake := newUsageTestServer(t)
	useTokenStore(t, s, "acc-1")
	cookie := loginCookie(t, s, base)

	code, body := getJSON(t, base+"/api/usage", cookie)
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", code)
	}
	if body["ok"] != true {
		t.Fatalf("应成功：%v", body)
	}
	usage, ok := body["usage"].(map[string]any)
	if !ok {
		t.Fatalf("应返回 usage：%v", body)
	}
	days, _ := usage["days"].([]any)
	if len(days) != 7 {
		t.Fatalf("应有 7 天数据，实际 %d", len(days))
	}
	series, _ := usage["series"].([]any)
	if len(series) != 7 {
		t.Fatalf("series 应与 days 对齐，实际 %d", len(series))
	}
	today, _ := series[6].(map[string]any)
	if today["workersRequests"].(float64) != 13 {
		t.Errorf("今日请求数应为 13（10+3），实际 %v", today["workersRequests"])
	}
	if today["kvReads"].(float64) != 40 || today["kvWrites"].(float64) != 7 {
		t.Errorf("今日 KV 读写不对：%v / %v", today["kvReads"], today["kvWrites"])
	}
	storage, _ := usage["storage"].(map[string]any)
	if storage["bytes"].(float64) != 432522 {
		t.Errorf("存储量不对：%v", storage["bytes"])
	}
	limits, _ := usage["limits"].(map[string]any)
	if limits["workersRequests"].(float64) != 100000 || limits["kvWrites"].(float64) != 1000 {
		t.Errorf("Free 上限不对：%v", limits)
	}
	// 速率限制头要被解析出来
	rate, _ := usage["ratelimit"].(map[string]any)
	if rate["remoteRemaining"].(float64) != 1199 || rate["remoteLimit"].(float64) != 1200 {
		t.Errorf("速率限制解析不对：%v", rate)
	}
	if fake.calls.Load() == 0 {
		t.Error("应真的调用了 Cloudflare API")
	}
}

// 缓存命中时不再发请求。
func TestUsageSnapshotCached(t *testing.T) {
	s, base, fake := newUsageTestServer(t)
	useTokenStore(t, s, "acc-1")
	cookie := loginCookie(t, s, base)

	_, _ = getJSON(t, base+"/api/usage", cookie)
	first := fake.calls.Load()
	if first == 0 {
		t.Fatal("首次应发起调用")
	}
	_, body := getJSON(t, base+"/api/usage", cookie)
	if fake.calls.Load() != first {
		t.Errorf("缓存命中时不应再调用 API：%d → %d", first, fake.calls.Load())
	}
	usage, _ := body["usage"].(map[string]any)
	if usage["stale"] != false {
		t.Error("缓存内的数据不应标记为过期")
	}
}

// 本地风控达到上限后停止调用。
func TestUsageLocalGuardStopsCalls(t *testing.T) {
	s, base, fake := newUsageTestServer(t)
	useTokenStore(t, s, "acc-1")
	cookie := loginCookie(t, s, base)

	// 把风控调到只剩 1 次，再多要几次 → 达到上限后必须停手。
	state := s.usageState()
	state.guard = newUsageGuard(1, 5*time.Minute)

	_, _ = getJSON(t, base+"/api/usage", cookie)
	afterFirst := fake.calls.Load()
	// 让缓存过期，逼出一次刷新 → 此时应当被本地风控拦下。
	state.mu.Lock()
	state.fetched = time.Now().Add(-time.Hour)
	state.mu.Unlock()

	_, body := getJSON(t, base+"/api/usage", cookie)
	if fake.calls.Load() != afterFirst {
		t.Errorf("本地风控拦截后不应再调用 API：%d → %d", afterFirst, fake.calls.Load())
	}
	usage, _ := body["usage"].(map[string]any)
	if usage["throttled"] != true {
		t.Errorf("应标记为已拦截：%v", usage)
	}
	rate, _ := usage["ratelimit"].(map[string]any)
	if rate["localBlocked"] != true {
		t.Errorf("应标记本地风控已拦截：%v", rate)
	}
	if usage["stale"] != true {
		t.Error("被拦截时显示的应是旧数据（标记为过期）")
	}
}

// 切换账号后不能复用上一个账号的缓存。
func TestUsageCacheIsPerAccount(t *testing.T) {
	s, base, fake := newUsageTestServer(t)
	useTokenStore(t, s, "acc-1")
	cookie := loginCookie(t, s, base)

	// 先给 acc-1 采集一次
	_, body := getJSON(t, base+"/api/usage", cookie)
	usage, _ := body["usage"].(map[string]any)
	if usage == nil || usage["accountId"] != "acc-1" {
		t.Fatalf("应返回 acc-1 的用量：%v", body)
	}
	before := fake.calls.Load()

	// 换成另一个账号：缓存必须失效（不能拿 acc-1 的数据糊弄）
	st := s.store
	if _, err := st.SaveActive(patchTokenAndAccount("tok-1", "acc-2")); err != nil {
		t.Fatal(err)
	}
	_, body = getJSON(t, base+"/api/usage", cookie)
	usage, _ = body["usage"].(map[string]any)
	if usage != nil && usage["accountId"] == "acc-1" {
		t.Fatalf("切换账号后仍返回旧账号的数据：%v", usage["accountId"])
	}
	if fake.calls.Load() == before {
		t.Error("切换账号后应重新采集一次")
	}
}

// 本地 KV 写配额日风控：达到上限后拒绝继续写。
func TestUsageDailyWriteGuard(t *testing.T) {
	s, _, _ := newUsageTestServer(t)
	ok, used, limit := s.claimDailyWrite(1)
	if !ok || used != 1 || limit != usageDailyWriteLimit {
		t.Fatalf("首次申请应成功：%v %v %v", ok, used, limit)
	}
	// 直接把计数推到上限
	state := s.usageState()
	state.mu.Lock()
	state.writeCount = usageDailyWriteLimit
	state.writeDay = time.Now().UTC().Format("2006-01-02")
	state.mu.Unlock()
	if ok, used, limit := s.claimDailyWrite(1); ok {
		t.Fatal("达到上限后应拒绝")
	} else if used != usageDailyWriteLimit || limit != usageDailyWriteLimit {
		t.Fatalf("应回报当前用量与上限：%v %v", used, limit)
	}
	// 跨天自动归零
	state.mu.Lock()
	state.writeDay = "2000-01-01"
	state.mu.Unlock()
	if ok, _, _ := s.claimDailyWrite(1); !ok {
		t.Fatal("跨天后应重新放行")
	}
}
func TestUsageWithoutToken(t *testing.T) {
	s, base, _ := newUsageTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)
	code, body := getJSON(t, base+"/api/usage", cookie)
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", code)
	}
	if body["ok"] != false {
		t.Fatalf("无令牌时应返回失败：%v", body)
	}
	if body["error"] == "" {
		t.Error("应给出错误说明")
	}
}
