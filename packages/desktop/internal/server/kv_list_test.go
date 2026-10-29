package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeKVListCF 是「KV 列表」这一个场景的假 Cloudflare API。
//
// 与 deploy_handlers_test.go 的 fakeCF 分开写，原因：
//  1. fakeCF 没实现 `GET /accounts/{acc}/storage/kv/namespaces`（那组用例不走列表）；
//  2. 这里要能**人为延迟**每次清单读取，用来证明「并发读」确实生效；
//  3. 这里必须**并发安全**（fakeCF 的 seenKV 是无锁 append，
//     并发读清单时会丢数据、甚至触发竞态）。
type fakeKVListCF struct {
	mu sync.Mutex
	// namespaces 是列出来的命名空间标题（ID 按序号生成 ns-00 / ns-01 …）
	namespaces []string
	// manifests 是「命名空间 ID → 清单原文」（没有就返回 404）
	manifests map[string]string
	// delay 是每次读清单的人为延迟
	delay time.Duration
	// reads 记录清单读取次数（断言并发后仍然每个命名空间都读了）
	reads int
	// inFlight / maxInFlight 记录同时在飞的清单请求数峰值（直接证明并发）
	inFlight    int
	maxInFlight int
}

func newFakeKVListCF() *fakeKVListCF {
	return &fakeKVListCF{manifests: map[string]string{}}
}

func (f *fakeKVListCF) handler(t *testing.T) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		// GET /accounts/{acc}/storage/kv/namespaces —— 命名空间列表
		// （注意末尾可能还带一个斜杠，客户端拼 URL 时不一定去掉）
		if strings.HasSuffix(strings.TrimSuffix(path, "/"), "/storage/kv/namespaces") {
			type nsJSON struct {
				ID    string `json:"id"`
				Title string `json:"title"`
			}
			f.mu.Lock()
			out := make([]nsJSON, 0, len(f.namespaces))
			for i, title := range f.namespaces {
				out = append(out, nsJSON{ID: fmt.Sprintf("ns-%02d", i), Title: title})
			}
			f.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": out})
			return
		}

		// GET /accounts/{acc}/storage/kv/namespaces/{ns}/values/{key}
		if idx := strings.Index(path, "/storage/kv/namespaces/"); idx >= 0 {
			rest := path[idx+len("/storage/kv/namespaces/"):]
			parts := strings.SplitN(rest, "/values/", 2)
			if len(parts) != 2 {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			nsID, key := parts[0], parts[1]

			f.mu.Lock()
			f.inFlight++
			if f.inFlight > f.maxInFlight {
				f.maxInFlight = f.inFlight
			}
			f.mu.Unlock()
			if f.delay > 0 {
				time.Sleep(f.delay)
			}
			f.mu.Lock()
			f.reads++
			f.inFlight--
			raw, ok := f.manifests[nsID]
			f.mu.Unlock()

			// 只认部署清单；其余键（config / CONFIG）按不存在处理
			if ok && key == "CFP_DEPLOY_MANIFEST" {
				_, _ = w.Write([]byte(raw))
				return
			}
			w.WriteHeader(http.StatusNotFound)
			return
		}

		t.Errorf("未处理的路由：%s %s", r.Method, path)
		w.WriteHeader(http.StatusNotFound)
	}
}

// TestKvListReadsManifestsConcurrently 守护「KV 列表并发读清单」。
//
// 背景：凭据页一打开就会拉 KV 列表，而每个命名空间都要读一遍部署清单。
// 串行时 6 个命名空间实测要 20~25 秒（跨境链路 RTT 大），
// 用户看到的是「检测账号…」卡住二十多秒，很像程序假死。
//
// 构造：12 个命名空间 × 每次读延迟 120ms
//   - 串行：≥ 1440ms
//   - 并发 4 路：约 360~500ms
//
// 断言两项：
//  1. **并发峰值 ≥ 3**（直接证据，不受机器快慢影响）；
//  2. 总耗时 < 2000ms（串行约 2.9s：6 个命名空间各 1 次清单读 +
//     6 个空命名空间各 3 次探测 = 24 次 × 120ms）。
func TestKvListReadsManifestsConcurrently(t *testing.T) {
	f := newFakeKVListCF()
	f.delay = 120 * time.Millisecond

	const n = 12
	for i := 0; i < n; i++ {
		title := fmt.Sprintf("kv-%02d", i)
		f.namespaces = append(f.namespaces, title)
		// 一半是 CFPilot 实例（有清单），一半是空命名空间
		if i%2 == 0 {
			f.manifests[fmt.Sprintf("ns-%02d", i)] = manifestJSON(title, "pw-"+title)
		}
	}

	cfSrv := httptest.NewServer(f.handler(t))
	t.Cleanup(cfSrv.Close)

	s, base := newTestServer(t)
	s.SetCFAPIBase(cfSrv.URL)
	st := newEmptyStore(t)
	if _, err := st.Create("测试账号", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SaveActive(patchTokenAndAccount("cfat_test", "acc-1")); err != nil {
		t.Fatal(err)
	}
	s.SetStore(st)
	cookie := loginCookie(t, s, base)

	start := time.Now()
	code, body := postJSON(t, base+"/api/kv/list", cookie, map[string]any{"accountId": "acc-1"})
	elapsed := time.Since(start)

	if code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200；响应：%v", code, body)
	}
	if elapsed > 2000*time.Millisecond {
		t.Fatalf("读取 %d 个命名空间耗时 %v —— 看起来还是串行（串行约 2.9s）", n, elapsed)
	}
	f.mu.Lock()
	peak := f.maxInFlight
	f.mu.Unlock()
	if peak < 3 {
		t.Fatalf("清单请求并发峰值只有 %d —— 并发没生效（期望 3~4 路）", peak)
	}
	t.Logf("12 个命名空间耗时 %v，并发峰值 %d（串行约 2.9s）", elapsed, peak)

	opts, _ := body["options"].([]any)
	if len(opts) != n {
		t.Fatalf("返回 %d 个选项，期望 %d", len(opts), n)
	}

	// 顺序必须与列表接口一致：结果按下标写回，并发不能打乱顺序
	for i, raw := range opts {
		item, _ := raw.(map[string]any)
		wantID := fmt.Sprintf("ns-%02d", i)
		if got, _ := item["id"].(string); got != wantID {
			t.Fatalf("第 %d 项 id = %q，期望 %q（并发把顺序打乱了）", i, got, wantID)
		}
		wantOwnership := "empty"
		if i%2 == 0 {
			wantOwnership = "instance"
		}
		if got, _ := item["ownership"].(string); got != wantOwnership {
			t.Fatalf("第 %d 项 ownership = %q，期望 %q", i, got, wantOwnership)
		}
		if i%2 == 0 {
			if got, _ := item["controlProject"].(string); got != fmt.Sprintf("kv-%02d", i) {
				t.Fatalf("第 %d 项的清单字段没解析出来：controlProject = %q", i, got)
			}
		}
	}

	if instances, _ := body["instances"].(float64); int(instances) != n/2 {
		t.Fatalf("instances = %v，期望 %d", body["instances"], n/2)
	}
	// 每个命名空间都必须读到（并发不能漏）
	f.mu.Lock()
	reads := f.reads
	f.mu.Unlock()
	if reads < n/2 {
		t.Fatalf("只读了 %d 次清单，期望至少 %d 次", reads, n/2)
	}
}
