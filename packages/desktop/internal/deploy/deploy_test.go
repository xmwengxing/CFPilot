package deploy

// 部署流程的测试。
//
// ## 测试重点
//
// 这里不测「能不能连通 Cloudflare」（那是 live_test 的事），
// 而是测**那些踩过坑才写对的规则**：
//
//   - KV 归属校验必须在写入任何键之前
//   - 8000119 要先同名重试 3 次，再换名
//   - 换名后域名迁移顺序必须是「旧解绑 → 新绑定 → 删旧项目」
//   - 域名迁移失败时**不能**删旧项目（旧项目还挂着用户唯一入口）
//   - 先部署数据面，再部署控制面
//   - 数据面换名后要重配控制面 DATA_HOST
//   - 写 KV 用大写 CONFIG，不碰小写 config
//   - 清单里 build 读不到就写空串，不写 "unknown"

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeCF 是一个可编程的假 Cloudflare API。
type fakeCF struct {
	mu sync.Mutex

	// 已部署的项目名 → 部署次数
	deployCalls map[string]int
	// 每次部署请求的项目名（按顺序）
	deployOrder []string
	// 创建过的项目名
	created []string
	// 删除过的项目名
	deleted []string
	// 域名操作顺序（用于验证「旧解绑 → 新绑 → 删旧」）
	domainOps []string
	// KV 写入记录：key → value
	kvWrites map[string]string
	// 已存在的 KV 值
	kvSeed map[string]string

	// deployFailPlan: 项目名 → 前 N 次返回 8000119
	deployFailPlan map[string]int
	// addDomainFail 为 true 时绑定域名失败
	addDomainFail bool
	// existingProject 返回 404 表示不存在
	existingProject map[string]bool
	// subdomainOf 项目名 → 子域名
	subdomainOf map[string]string
	// manifestInKV 是预置的清单
	manifestInKV string
	// envVars 记录控制面最后一次配置的 DATA_HOST
	dataHost string
}

func newFakeCF() *fakeCF {
	return &fakeCF{
		deployCalls:     map[string]int{},
		kvWrites:        map[string]string{},
		kvSeed:          map[string]string{},
		deployFailPlan:  map[string]int{},
		existingProject: map[string]bool{},
		subdomainOf:     map[string]string{},
	}
}

func (f *fakeCF) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()

		path := r.URL.Path
		ok := func(result any) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "result": result})
		}
		fail := func(code int, msg string) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(code)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": false,
				"errors":  []map[string]any{{"code": code, "message": msg}},
			})
		}

		// ---- KV ----
		if strings.Contains(path, "/storage/kv/namespaces/") && strings.Contains(path, "/values/") {
			parts := strings.Split(path, "/values/")
			key := parts[len(parts)-1]
			if r.Method == http.MethodGet {
				if v, has := f.kvSeed[key]; has {
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(v))
					return
				}
				if v, has := f.kvWrites[key]; has {
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(v))
					return
				}
				w.WriteHeader(http.StatusNotFound)
				return
			}
			if r.Method == http.MethodPut {
				buf := make([]byte, r.ContentLength)
				_, _ = r.Body.Read(buf)
				if len(buf) == 0 {
					var sb strings.Builder
					b := make([]byte, 4096)
					for {
						n, err := r.Body.Read(b)
						if n > 0 {
							sb.Write(b[:n])
						}
						if err != nil {
							break
						}
					}
					f.kvWrites[key] = sb.String()
				} else {
					f.kvWrites[key] = string(buf)
				}
				ok(nil)
				return
			}
		}

		// ---- Pages 项目 ----
		if strings.Contains(path, "/pages/projects") {
			// 部署
			if strings.HasSuffix(path, "/deployments") && r.Method == http.MethodPost {
				seg := strings.Split(path, "/pages/projects/")
				proj := strings.Split(seg[len(seg)-1], "/")[0]
				f.deployOrder = append(f.deployOrder, proj)
				f.deployCalls[proj]++

				if n, has := f.deployFailPlan[proj]; has && f.deployCalls[proj] <= n {
					fail(http.StatusBadRequest, "You have been blocked（8000119）")
					return
				}
				ok(map[string]any{"id": "dep-" + proj, "environment": "production"})
				return
			}

			// 列部署（轮询状态）
			if strings.HasSuffix(path, "/deployments") && r.Method == http.MethodGet {
				ok([]map[string]any{
					{"id": "dep1", "latest_stage": map[string]any{"name": "deploy", "status": "success"}},
				})
				return
			}

			// 域名子接口
			if strings.Contains(path, "/domains") {
				seg := strings.Split(path, "/pages/projects/")
				rest := seg[len(seg)-1]
				if r.Method == http.MethodGet {
					ok([]map[string]any{
						{"name": "cf.example.com", "status": "active"},
					})
					return
				}
				if r.Method == http.MethodDelete {
					proj := strings.Split(rest, "/")[0]
					domain := rest[strings.LastIndex(rest, "/")+1:]
					f.domainOps = append(f.domainOps, "unbind:"+proj+":"+domain)
					ok(nil)
					return
				}
				if r.Method == http.MethodPost {
					proj := strings.Split(rest, "/")[0]
					var body map[string]string
					_ = json.NewDecoder(r.Body).Decode(&body)
					if f.addDomainFail {
						f.domainOps = append(f.domainOps, "bindfail:"+proj)
						fail(http.StatusBadRequest, "You have already added this custom domain")
						return
					}
					f.domainOps = append(f.domainOps, "bind:"+proj+":"+body["name"])
					ok(map[string]any{"name": body["name"]})
					return
				}
			}

			// 项目详情 / PATCH / DELETE
			seg := strings.Split(path, "/pages/projects/")
			if len(seg) == 2 && r.Method == http.MethodGet {
				proj := seg[1]
				sub := f.subdomainOf[proj]
				if sub == "" {
					sub = proj + ".pages.dev"
				}
				ok(map[string]any{
					"id":        "pid-" + proj,
					"name":      proj,
					"subdomain": sub,
					"domains":   []string{},
					"deployment_configs": map[string]any{
						"production": map[string]any{
							"env_vars": map[string]any{
								"DATA_HOST": map[string]any{"value": f.dataHost, "type": "plain_text"},
							},
						},
					},
				})
				return
			}
			if len(seg) == 2 && r.Method == http.MethodDelete {
				f.deleted = append(f.deleted, seg[1])
				f.domainOps = append(f.domainOps, "delete:"+seg[1])
				ok(nil)
				return
			}
			// PATCH（配置变量 / KV 绑定）
			if len(seg) == 2 && r.Method == http.MethodPatch {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if dc, has := body["deployment_configs"].(map[string]any); has {
					if prod, has2 := dc["production"].(map[string]any); has2 {
						if env, has3 := prod["env_vars"].(map[string]any); has3 {
							if dh, has4 := env["DATA_HOST"].(map[string]any); has4 {
								f.dataHost = fmt.Sprint(dh["value"])
							}
						}
					}
				}
				ok(nil)
				return
			}
			// 创建项目
			if strings.HasSuffix(path, "/pages/projects") && r.Method == http.MethodPost {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				name := fmt.Sprint(body["name"])
				f.created = append(f.created, name)
				ok(map[string]any{
					"id":        "pid-" + name,
					"name":      name,
					"subdomain": name + ".pages.dev",
				})
				return
			}
			// 列项目
			if r.Method == http.MethodGet {
				ok([]any{})
				return
			}
		}

		t.Errorf("未处理的路由：%s %s", r.Method, path)
		w.WriteHeader(http.StatusNotFound)
	}
}

// newTestDeployer 用假 API 构造部署器。
func newTestDeployer(t *testing.T, f *fakeCF, mutate func(*Options)) (*Deployer, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(f.handler(t))
	t.Cleanup(srv.Close)

	opt := DefaultOptions()
	opt.Token = "test-token"
	opt.AccountID = "acc1"
	opt.KVNamespaceID = "kv1"
	opt.ControlScript = []byte("// control")
	opt.DataScript = []byte("// data")
	opt.APIBase = srv.URL
	if mutate != nil {
		mutate(&opt)
	}

	d := New(opt)
	return d, srv
}

// ---------- 测试 ----------

// 首次部署：两个项目都建、都配、都部署。
func TestFirstDeploy(t *testing.T) {
	f := newFakeCF()
	d, _ := newTestDeployer(t, f, nil)

	res, err := d.Run(context.Background())
	if err != nil {
		t.Fatalf("部署失败：%v", err)
	}

	if res.Control.Name == "" || res.Data.Name == "" {
		t.Error("应生成两个项目名")
	}
	if len(f.created) != 2 {
		t.Errorf("应创建 2 个项目，实际 %d（%v）", len(f.created), f.created)
	}
	if len(f.deployOrder) != 2 {
		t.Errorf("应触发 2 次部署，实际 %d（%v）", len(f.deployOrder), f.deployOrder)
	}
	// 凭据都要生成
	if res.UUID == "" || res.WSPath == "" || res.PanelPassword == "" || res.PanelPath == "" {
		t.Error("首次部署应生成全部凭据")
	}
	if !strings.HasPrefix(res.WSPath, "/") {
		t.Errorf("WS 路径应带前导斜杠，实际 %q", res.WSPath)
	}
}

// 部署顺序：必须**先数据面，再控制面**（控制面的 DATA_HOST 要用数据面域名）。
func TestDeployOrderDataBeforeControl(t *testing.T) {
	f := newFakeCF()
	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.ControlProject = "mycontrol"
		o.DataProject = "mydata"
	})

	if _, err := d.Run(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(f.deployOrder) < 2 {
		t.Fatalf("应至少 2 次部署，实际 %v", f.deployOrder)
	}
	if f.deployOrder[0] != "mydata" {
		t.Errorf("第一次部署应为数据面，实际 %q（顺序：%v）", f.deployOrder[0], f.deployOrder)
	}
	if f.deployOrder[1] != "mycontrol" {
		t.Errorf("第二次部署应为控制面，实际 %q（顺序：%v）", f.deployOrder[1], f.deployOrder)
	}
}

// 写 KV 必须用大写 CONFIG，绝不能写小写 config。
func TestWritesUppercaseConfigKey(t *testing.T) {
	f := newFakeCF()
	d, _ := newTestDeployer(t, f, nil)

	if _, err := d.Run(context.Background()); err != nil {
		t.Fatal(err)
	}

	if _, has := f.kvWrites["CONFIG"]; !has {
		t.Error("必须写入大写 CONFIG 键")
	}
	if _, has := f.kvWrites["config"]; has {
		t.Error("绝不能写入小写 config 键（那是旧版第三方实现的，会覆盖共栖项目配置）")
	}

	// CONFIG 里要有 UUID 与 WS 路径
	var cfg map[string]any
	if err := json.Unmarshal([]byte(f.kvWrites["CONFIG"]), &cfg); err != nil {
		t.Fatalf("CONFIG 不是合法 JSON：%v", err)
	}
	for _, k := range []string{"uuid", "wsPath", "trojanPassword"} {
		if _, has := cfg[k]; !has {
			t.Errorf("CONFIG 缺少 %s", k)
		}
	}
}

// 清单里 build 必须是真实版本号，不是 "unknown"。
func TestManifestBuildNotUnknown(t *testing.T) {
	f := newFakeCF()
	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.LocalBuild = "" // 故意留空（读不到版本号）
	})

	if _, err := d.Run(context.Background()); err != nil {
		t.Fatal(err)
	}

	raw := f.kvWrites["CFP_DEPLOY_MANIFEST"]
	if raw == "" {
		t.Fatal("应写入部署清单")
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	if m["build"] == "unknown" {
		t.Error("读不到版本号时应写空串，绝不能写 \"unknown\"")
	}
	if m["build"] != "" {
		t.Errorf("build 应为空串，实际 %v", m["build"])
	}
}

// 清单里要记「本次实际部署的内核版本」（semver）。
//
// ⚠️ 它与 build 指纹是**两回事**，两个字段都要写：
//   - build        构建指纹（`<hash>-<hash>`），精确但比不出新旧
//   - kernelVersion semver（如 "0.7.6"），能判断「谁更新」
func TestManifestRecordsKernelVersion(t *testing.T) {
	f := newFakeCF()
	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.LocalBuild = "abc1234-deadbeef"
		o.LocalKernelVersion = "0.7.6"
	})

	if _, err := d.Run(context.Background()); err != nil {
		t.Fatal(err)
	}

	raw := f.kvWrites["CFP_DEPLOY_MANIFEST"]
	if raw == "" {
		t.Fatal("应写入部署清单")
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	if m["kernelVersion"] != "0.7.6" {
		t.Errorf("清单里的 kernelVersion 应是 0.7.6，实际 %v", m["kernelVersion"])
	}
	// build 指纹必须保留（两个字段语义不同）
	if m["build"] != "abc1234-deadbeef" {
		t.Errorf("清单里的 build 应保留，实际 %v", m["build"])
	}
}

// 读不到内核版本时写空串（绝不写 "unknown"）。
func TestManifestKernelVersionNotUnknown(t *testing.T) {
	f := newFakeCF()
	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.LocalKernelVersion = "" // 故意留空
	})

	if _, err := d.Run(context.Background()); err != nil {
		t.Fatal(err)
	}

	raw := f.kvWrites["CFP_DEPLOY_MANIFEST"]
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	if m["kernelVersion"] == "unknown" {
		t.Error("读不到内核版本时应写空串，绝不能写 \"unknown\"")
	}
	if m["kernelVersion"] != "" {
		t.Errorf("kernelVersion 应为空串，实际 %v", m["kernelVersion"])
	}
}

// 旧清单没有 kernelVersion 字段 → 读出来是空串（视为「版本未知」）。
func TestReadLegacyManifestWithoutKernelVersion(t *testing.T) {
	f := newFakeCF()
	f.kvSeed["CFP_DEPLOY_MANIFEST"] = `{
		"v": 1,
		"controlProject": "mycontrol",
		"dataProject": "mydata",
		"build": "old-build",
		"at": "2026-10-20T00:00:00.000Z",
		"credentials": {}
	}`

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.ControlProject = "mycontrol"
		o.DataProject = "mydata"
	})

	m, err := d.readManifest(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if m == nil {
		t.Fatal("应读到清单")
	}
	if m.KernelVersion != "" {
		t.Errorf("旧清单的 kernelVersion 应为空串（版本未知），实际 %q", m.KernelVersion)
	}
	// build 指纹照旧能读到
	if m.Build != "old-build" {
		t.Errorf("build 应为 old-build，实际 %q", m.Build)
	}
}

// KV 归属校验：清单属于别的实例时要拒绝部署。
//
// ⚠️ 必须是 **fresh 模式**才能触发 occupied：
//
// 更新模式（auto / update）会**复用清单里的项目名**（对照 CLI 的
// deployPagesSplit：「同源项目名：有清单就按清单来」），
// 因此同一个实例的原地更新判为 owned，不会被误拒。
// occupied 只在「本次要用的项目名 ≠ 清单里的项目名」时出现 ——
// 也就是全新部署复用了一个已存在的 KV。
func TestOwnershipConflictRejected(t *testing.T) {
	f := newFakeCF()
	f.kvSeed["CFP_DEPLOY_MANIFEST"] = `{
		"v": 1,
		"controlProject": "someone-elses-project",
		"dataProject": "other-data",
		"credentials": {}
	}`

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.Mode = "fresh"
		o.ControlProject = "mycontrol"
		o.DataProject = "mydata"
	})

	_, err := d.Run(context.Background())
	if err == nil {
		t.Fatal("归属冲突必须中止部署")
	}
	// 文案与 Electron 版对齐：说明「已被另一个实例占用」
	if !strings.Contains(err.Error(), "已被另一个 CFPilot 实例占用") {
		t.Errorf("错误信息应说明被另一实例占用，实际：%v", err)
	}
	// 关键：不能创建任何项目
	if len(f.created) != 0 {
		t.Errorf("归属冲突时不该创建项目，实际创建了 %v", f.created)
	}
	if len(f.kvWrites) != 0 {
		t.Errorf("归属冲突时不该写任何 KV，实际写了 %v", keysOf(f.kvWrites))
	}
}

// Force 可以跳过 occupied（另一实例占用）。
func TestOwnershipForceSkips(t *testing.T) {
	f := newFakeCF()
	f.kvSeed["CFP_DEPLOY_MANIFEST"] = `{"v":1,"controlProject":"other","dataProject":"otherdata","credentials":{}}`

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.Mode = "fresh"
		o.ControlProject = "mycontrol"
		o.DataProject = "mydata"
		o.Force = true
	})

	if _, err := d.Run(context.Background()); err != nil {
		t.Fatalf("Force 时应允许部署：%v", err)
	}
}

// KV 里有旧版第三方实现的小写 config 键 → 硬阻断。
//
// CFPilot 是纯自研数据面，不与旧版第三方实现共用 KV。
func TestOwnershipForeignBlocked(t *testing.T) {
	f := newFakeCF()
	f.kvSeed["config"] = `{"uuid":"third-party-uuid"}`

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.ControlProject = "mycontrol"
		o.DataProject = "mydata"
	})

	_, err := d.Run(context.Background())
	if err == nil {
		t.Fatal("含旧版第三方实现的 config 键时必须阻断")
	}
	if !strings.Contains(err.Error(), "第三方") {
		t.Errorf("错误信息应提到第三方实现，实际：%v", err)
	}
	if !strings.Contains(err.Error(), "独立的 KV") {
		t.Errorf("错误信息应指导新建独立 KV，实际：%v", err)
	}
	// 不能创建任何项目、不能写任何 KV
	if len(f.created) != 0 {
		t.Errorf("阻断时不该创建项目，实际 %v", f.created)
	}
	if len(f.kvWrites) != 0 {
		t.Errorf("阻断时不该写 KV，实际 %v", keysOf(f.kvWrites))
	}
}

// foreign 是硬约束：连 Force 也不放行。
func TestOwnershipForeignIgnoresForce(t *testing.T) {
	f := newFakeCF()
	f.kvSeed["config"] = `{"uuid":"third-party-uuid"}`

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.ControlProject = "mycontrol"
		o.DataProject = "mydata"
		o.Force = true // 即使强制也不行
	})

	_, err := d.Run(context.Background())
	if err == nil {
		t.Fatal("foreign 判定下 Force 也不能绕过")
	}
	if !strings.Contains(err.Error(), "第三方") {
		t.Errorf("错误信息应提到第三方实现，实际：%v", err)
	}
	if len(f.created) != 0 {
		t.Errorf("不该创建项目，实际 %v", f.created)
	}
}

// KV 里有大写 CONFIG 但无清单 → stale，默认阻断。
func TestOwnershipStaleBlocked(t *testing.T) {
	f := newFakeCF()
	f.kvSeed["CONFIG"] = `{"uuid":"residual-uuid"}`

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.ControlProject = "mycontrol"
		o.DataProject = "mydata"
	})

	_, err := d.Run(context.Background())
	if err == nil {
		t.Fatal("含残留 CONFIG 但无清单时必须阻断")
	}
	if !strings.Contains(err.Error(), "残留配置") {
		t.Errorf("错误信息应说明是残留配置，实际：%v", err)
	}
	if len(f.created) != 0 {
		t.Errorf("阻断时不该创建项目，实际 %v", f.created)
	}
}

// stale 可以用 Force 接管（与 Electron 版一致）。
func TestOwnershipStaleAllowsForce(t *testing.T) {
	f := newFakeCF()
	f.kvSeed["CONFIG"] = `{"uuid":"residual-uuid"}`

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.ControlProject = "mycontrol"
		o.DataProject = "mydata"
		o.Force = true
		o.WaitTimeout = 2 * time.Second
		o.WaitInterval = 10 * time.Millisecond
	})

	if _, err := d.Run(context.Background()); err != nil {
		t.Fatalf("Force 时应允许接管残留配置：%v", err)
	}
}

// 空 KV → empty，正常部署。
func TestOwnershipEmptyPasses(t *testing.T) {
	f := newFakeCF()

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.ControlProject = "mycontrol"
		o.DataProject = "mydata"
		o.WaitTimeout = 2 * time.Second
		o.WaitInterval = 10 * time.Millisecond
	})

	verdict, detail := d.inspectKvOwnership(context.Background(), nil, "mycontrol")
	if verdict != OwnEmpty {
		t.Errorf("空 KV 应判定 empty，实际 %s（%s）", verdict, detail)
	}
}

// 回归测试（B2）：清单里 controlProject=X、用户输入为空（→ 随机名）时，
// fresh 模式必须判为 **occupied** 而不是 owned。
//
// ## 这个 bug 的实际后果
//
// 账户 A 已在 KV1 部署了现役实例（清单里 controlProject=X），
// GUI 又选「全新部署」且 KV 下拉框仍是 KV1：
// 归属校验因「用户输入为空 ⇒ 认领」被放行 → 用**全新**的
// UUID / WS 路径 / 面板密码覆盖 KV1 的 CFP_DEPLOY_MANIFEST 与 CONFIG
// → 老实例的客户端节点全部失效，一个 KV 挂着两套 Pages 项目。
//
// ## 与 CLI 的对齐
//
// CLI 的 deployPagesSplit 先把控制面项目名补成随机名，**再**做归属校验，
// 比对用的是「即将实际使用的项目名」，因此这里必须是 occupied。
func TestOwnershipFreshRandomNameIsOccupied(t *testing.T) {
	f := newFakeCF()
	f.kvSeed["CFP_DEPLOY_MANIFEST"] = `{
		"v": 1,
		"kvNamespaceId": "kv1",
		"controlProject": "existing-control",
		"dataProject": "existing-data",
		"controlSubdomain": "existing-control.pages.dev",
		"dataSubdomain": "existing-data.pages.dev",
		"build": "old-build",
		"at": "2026-10-20T00:00:00.000Z",
		"credentials": {"uuid":"OLD-UUID","wsPath":"/old-ws","panelPath":"/old-panel","panelPassword":"OLD-PW","trojanPassword":"OLD-TP"}
	}`

	// 关键：用户**没有**填项目名（GUI 的项目名框是可选的，默认空）
	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.Mode = "fresh"
		o.ControlProject = "" // 留空 → 走随机名兜底
		o.DataProject = ""
		o.WaitTimeout = 2 * time.Second
		o.WaitInterval = 10 * time.Millisecond
	})

	_, err := d.Run(context.Background())
	if err == nil {
		t.Fatal("全新部署复用已存在的 KV 时必须判为 occupied，不能当成 owned 放行")
	}
	if !strings.Contains(err.Error(), "已被另一个 CFPilot 实例占用") {
		t.Errorf("错误信息应说明被另一实例占用，实际：%v", err)
	}

	// ⚠️ 关键：绝不能覆盖现役实例的清单与配置
	if _, has := f.kvWrites["CFP_DEPLOY_MANIFEST"]; has {
		t.Error("归属冲突时绝不能写回部署清单（会把现役实例的身份改掉）")
	}
	if _, has := f.kvWrites["CONFIG"]; has {
		t.Error("归属冲突时绝不能写 CONFIG（会把现役实例的 UUID / WS 路径改掉）")
	}
	if len(f.created) != 0 {
		t.Errorf("归属冲突时不该创建项目，实际创建了 %v", f.created)
	}
}

// 反向保证：更新已有实例（auto 模式）**不能**被误判成 occupied。
//
// 更新模式会复用清单里的项目名（对照 CLI），
// 因此归属校验必须判为 owned，部署才能正常进行。
func TestOwnershipAutoModeReusesManifestProject(t *testing.T) {
	f := newFakeCF()
	f.kvSeed["CFP_DEPLOY_MANIFEST"] = `{
		"v": 1,
		"controlProject": "existing-control",
		"dataProject": "existing-data",
		"build": "old-build",
		"at": "2026-10-20T00:00:00.000Z",
		"credentials": {"uuid":"KEEP-UUID","wsPath":"/keep-ws","panelPath":"/keep-panel","panelPassword":"KEEP-PW","trojanPassword":"KEEP-TP"}
	}`

	// 用户没填项目名（可选框留空）→ 必须复用清单里的，而不是随机名
	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.Mode = "auto"
		o.ControlProject = ""
		o.DataProject = ""
		o.LocalBuild = "new-build"
		o.WaitTimeout = 2 * time.Second
		o.WaitInterval = 10 * time.Millisecond
	})

	res, err := d.Run(context.Background())
	if err != nil {
		t.Fatalf("更新已有实例不该被拒：%v", err)
	}
	if res.Control.Name != "existing-control" {
		t.Errorf("更新时应复用清单里的控制面项目名，实际 %q", res.Control.Name)
	}
	if res.Data.Name != "existing-data" {
		t.Errorf("更新时应复用清单里的数据面项目名，实际 %q", res.Data.Name)
	}
	// 凭据也必须沿用（客户端订阅地址不变）
	if res.UUID != "KEEP-UUID" {
		t.Errorf("应沿用清单里的 UUID，实际 %q", res.UUID)
	}
}

// 回归测试（B7）：已有 CONFIG 里的字段在部署后**仍然存在**。
//
// 之前 writeEffectiveConfig 是整体覆盖，用户在面板里配过的
// poolManual / poolOfficial / proxyIp / relayPool … 会被一次部署全部抹掉。
//
// 对照 CLI 的 writeEffectiveConfig：`{ ...existing, uuid, ... }`。
func TestConfigMergeKeepsExistingFields(t *testing.T) {
	f := newFakeCF()
	// 本实例的清单（归属校验要判 owned 才能走到写配置这一步）
	f.kvSeed["CFP_DEPLOY_MANIFEST"] = `{
		"v": 1,
		"kvNamespaceId": "kv1",
		"controlProject": "mycontrol",
		"dataProject": "mydata",
		"build": "old-build",
		"at": "2026-10-20T00:00:00.000Z",
		"credentials": {"uuid":"OLD-UUID","trojanPassword":"OLD-TP","wsPath":"/old-ws","panelPath":"/old-panel","panelPassword":"OLD-PW"}
	}`
	// 面板里配过的内容（用户自己在面板保存的）
	f.kvSeed["CONFIG"] = `{
		"uuid": "OLD-UUID",
		"trojanPassword": "OLD-TP",
		"wsPath": "/old-ws",
		"poolManual": "1.2.3.4",
		"poolOfficial": ["5.6.7.8", "9.10.11.12"],
		"proxyIp": "proxy.example.com",
		"socks5": "socks.example.com:1080",
		"relayPool": "https://relay.example.com",
		"subDomain": "my.example.com",
		"resolvePreferred": false,
		"someUserField": {"nested": true}
	}`

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.ControlProject = "mycontrol"
		o.DataProject = "mydata"
		o.WaitTimeout = 2 * time.Second
		o.WaitInterval = 10 * time.Millisecond
	})

	res, err := d.Run(context.Background())
	if err != nil {
		t.Fatalf("部署失败：%v", err)
	}

	raw := f.kvWrites["CONFIG"]
	if raw == "" {
		t.Fatal("必须写入 CONFIG")
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatalf("CONFIG 不是合法 JSON：%v", err)
	}

	// 用户配过的字段必须还在
	for _, k := range []string{
		"poolManual", "poolOfficial", "proxyIp", "socks5",
		"relayPool", "subDomain", "resolvePreferred", "someUserField",
	} {
		if _, has := cfg[k]; !has {
			t.Errorf("CONFIG 里的 %s 被抹掉了（整体覆盖回归）", k)
		}
	}
	if cfg["poolManual"] != "1.2.3.4" {
		t.Errorf("poolManual 的值应保持不变，实际 %v", cfg["poolManual"])
	}

	// 凭据类字段必须被本次部署的值覆盖
	if cfg["uuid"] != res.UUID {
		t.Errorf("uuid 应为本次部署的 %q，实际 %v", res.UUID, cfg["uuid"])
	}
	if cfg["wsPath"] != res.WSPath {
		t.Errorf("wsPath 应为本次部署的 %q，实际 %v", res.WSPath, cfg["wsPath"])
	}
}

// enableTrojan / enableXhttp 必须与 CLI 一致
// （CLI 的 deploy/command.ts 固定传 enableTrojan: true / enableXhttp: true）。
//
// 之前 Go 侧是零值 false —— Trojan 被强制关闭，
// GUI 部署出来的实例与 CLI 部署出来的行为不同。
//
// XHTTP 自 2026-10-28 起也默认 true（用户要求「默认开启，面板控制」）。
func TestConfigTrojanMatchesCLI(t *testing.T) {
	f := newFakeCF()
	d, _ := newTestDeployer(t, f, nil)

	if _, err := d.Run(context.Background()); err != nil {
		t.Fatalf("部署失败：%v", err)
	}

	var cfg map[string]any
	if err := json.Unmarshal([]byte(f.kvWrites["CONFIG"]), &cfg); err != nil {
		t.Fatalf("CONFIG 不是合法 JSON：%v", err)
	}
	if cfg["enableTrojan"] != true {
		t.Errorf("enableTrojan 应为 true（与 CLI 一致），实际 %v", cfg["enableTrojan"])
	}
	if cfg["enableXhttp"] != true {
		t.Errorf("enableXhttp 应为 true（与 CLI 一致，面板可关），实际 %v", cfg["enableXhttp"])
	}
}

// 8000119：同一个项目先原样重试 3 次，全部失败才换名。
func TestBlockRetrySameNameThenRename(t *testing.T) {
	f := newFakeCF()
	// 原名永远失败
	f.deployFailPlan["mydata"] = 999

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.DataProject = "mydata"
		o.ControlProject = "mycontrol"
		o.WaitTimeout = 2 * time.Second
		o.WaitInterval = 10 * time.Millisecond
	})

	if _, err := d.Run(context.Background()); err != nil {
		t.Fatal(err)
	}

	// mydata 应被尝试 3 次
	if f.deployCalls["mydata"] != 3 {
		t.Errorf("原名应重试 3 次，实际 %d 次", f.deployCalls["mydata"])
	}
	// 之后应换名重试（mydata-xxxx）
	renamed := false
	for name := range f.deployCalls {
		if strings.HasPrefix(name, "mydata-") {
			renamed = true
		}
	}
	if !renamed {
		t.Errorf("3 次失败后应换名重试，实际尝试过：%v", keysOfInt(f.deployCalls))
	}
}

// 8000119 第一次就成功：不该换名（间歇性风控，同名重试即可）。
func TestBlockRetrySucceedsOnSameName(t *testing.T) {
	f := newFakeCF()
	// 只失败前 2 次
	f.deployFailPlan["mydata"] = 2

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.DataProject = "mydata"
		o.ControlProject = "mycontrol"
		o.WaitTimeout = 2 * time.Second
		o.WaitInterval = 10 * time.Millisecond
	})

	res, err := d.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if f.deployCalls["mydata"] != 3 {
		t.Errorf("应在第 3 次成功，实际尝试 %d 次", f.deployCalls["mydata"])
	}
	// 不该产生换名项目
	for name := range f.deployCalls {
		if strings.HasPrefix(name, "mydata-") {
			t.Errorf("同项目重试成功时不该换名，却出现了 %q", name)
		}
	}
	if res.Data.Name != "mydata" {
		t.Errorf("数据面名应保持 mydata，实际 %q", res.Data.Name)
	}
}

// 域名迁移顺序：旧解绑 → 新绑定 → 删旧项目。
func TestDomainMigrationOrder(t *testing.T) {
	f := newFakeCF()
	f.kvSeed["CFP_DEPLOY_MANIFEST"] = `{
		"v": 1,
		"kvNamespaceId": "kv1",
		"controlProject": "mycontrol",
		"dataProject": "olddata",
		"controlSubdomain": "mycontrol.pages.dev",
		"dataSubdomain": "olddata.pages.dev",
		"dataCustomDomain": "cf.example.com",
		"build": "old-build",
		"at": "2026-10-20T00:00:00.000Z",
		"credentials": {"uuid":"u","wsPath":"/ws","panelPath":"p","panelPassword":"pw","trojanPassword":"tp"}
	}`
	// 旧数据面永远被拒 → 触发换名
	f.deployFailPlan["olddata"] = 999

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.ControlProject = "mycontrol"
		o.DataProject = "olddata"
		o.LocalBuild = "new-build"
		o.WaitTimeout = 2 * time.Second
		o.WaitInterval = 10 * time.Millisecond
	})

	if _, err := d.Run(context.Background()); err != nil {
		t.Fatal(err)
	}

	// 找到三个关键操作在 domainOps 里的位置
	var unbindIdx, bindIdx, deleteIdx = -1, -1, -1
	for i, op := range f.domainOps {
		if strings.HasPrefix(op, "unbind:olddata:cf.example.com") && unbindIdx < 0 {
			unbindIdx = i
		}
		// 绑定到**新**项目：新名形如 olddata-xxxx，所以不能用「不含 olddata」判断
		if strings.HasPrefix(op, "bind:") && strings.Contains(op, "cf.example.com") && bindIdx < 0 {
			// 排除绑到旧项目本身的情况
			if !strings.HasPrefix(op, "bind:olddata:") {
				bindIdx = i
			}
		}
		if op == "delete:olddata" {
			deleteIdx = i
		}
	}

	if unbindIdx < 0 {
		t.Fatalf("应从旧项目解绑域名，实际操作：%v", f.domainOps)
	}
	if bindIdx < 0 {
		t.Fatalf("应把域名绑到新项目，实际操作：%v", f.domainOps)
	}
	if deleteIdx < 0 {
		t.Fatalf("应删除旧项目，实际操作：%v", f.domainOps)
	}

	if !(unbindIdx < bindIdx) {
		t.Errorf("必须先解绑旧项目再绑新项目（否则报 already added），实际顺序：%v", f.domainOps)
	}
	if !(bindIdx < deleteIdx) {
		t.Errorf("必须先绑新项目再删旧项目（否则域名指向不存在的项目），实际顺序：%v", f.domainOps)
	}
}

// 域名迁移失败时，绝不能删旧项目（旧项目还挂着用户唯一入口）。
func TestDomainMigrationFailureKeepsOldProject(t *testing.T) {
	f := newFakeCF()
	f.kvSeed["CFP_DEPLOY_MANIFEST"] = `{
		"v": 1,
		"controlProject": "mycontrol",
		"dataProject": "olddata",
		"dataCustomDomain": "cf.example.com",
		"build": "old",
		"credentials": {}
	}`
	f.deployFailPlan["olddata"] = 999
	f.addDomainFail = true // 新项目绑定域名失败

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.ControlProject = "mycontrol"
		o.DataProject = "olddata"
		o.LocalBuild = "new"
		o.WaitTimeout = 2 * time.Second
		o.WaitInterval = 10 * time.Millisecond
	})

	res, err := d.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	// 不能删旧项目
	for _, name := range f.deleted {
		if name == "olddata" {
			t.Error("域名迁移失败时绝不能删旧项目 —— 旧项目还挂着用户唯一的访问入口")
		}
	}
	// 要有醒目警告
	found := false
	for _, w := range res.Warnings {
		if strings.Contains(w, "手动") && strings.Contains(w, "域名") {
			found = true
		}
	}
	if !found {
		t.Errorf("应给出「请手动改绑域名」的警告，实际：%v", res.Warnings)
	}
}

// 同版本跳过部署。
func TestSkipSameVersion(t *testing.T) {
	f := newFakeCF()
	f.kvSeed["CFP_DEPLOY_MANIFEST"] = `{
		"v": 1,
		"controlProject": "mycontrol",
		"dataProject": "mydata",
		"controlSubdomain": "mycontrol.pages.dev",
		"dataSubdomain": "mydata.pages.dev",
		"build": "same-build",
		"at": "2026-10-20T00:00:00.000Z",
		"credentials": {"uuid":"u","wsPath":"/ws","panelPath":"p","panelPassword":"pw","trojanPassword":"tp"}
	}`

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.ControlProject = "mycontrol"
		o.DataProject = "mydata"
		o.LocalBuild = "same-build"
	})

	res, err := d.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if !res.Skipped {
		t.Error("同版本应跳过部署")
	}
	if len(f.deployOrder) != 0 {
		t.Errorf("同版本不该触发部署，实际 %v", f.deployOrder)
	}
	// 凭据要沿用清单里的
	if res.UUID != "u" {
		t.Errorf("应沿用清单里的 UUID，实际 %q", res.UUID)
	}
	if res.WSPath != "/ws" {
		t.Errorf("应沿用清单里的 WS 路径，实际 %q", res.WSPath)
	}
}

// 更新模式：沿用清单里的凭据（客户端订阅地址不变）。
func TestUpdateKeepsCredentials(t *testing.T) {
	f := newFakeCF()
	f.kvSeed["CFP_DEPLOY_MANIFEST"] = `{
		"v": 1,
		"controlProject": "mycontrol",
		"dataProject": "mydata",
		"controlSubdomain": "mycontrol.pages.dev",
		"dataSubdomain": "mydata.pages.dev",
		"build": "old-build",
		"at": "2026-10-20T00:00:00.000Z",
		"credentials": {"uuid":"KEEP-UUID","wsPath":"/keep-ws","panelPath":"keep-panel","panelPassword":"KEEP-PW","trojanPassword":"KEEP-TP"}
	}`

	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.ControlProject = "mycontrol"
		o.DataProject = "mydata"
		o.LocalBuild = "new-build"
		o.WaitTimeout = 2 * time.Second
		o.WaitInterval = 10 * time.Millisecond
	})

	res, err := d.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if res.UUID != "KEEP-UUID" {
		t.Errorf("应沿用 UUID，实际 %q", res.UUID)
	}
	if res.WSPath != "/keep-ws" {
		t.Errorf("应沿用 WS 路径，实际 %q", res.WSPath)
	}
	if res.PanelPassword != "KEEP-PW" {
		t.Errorf("应沿用小写面板密码，实际 %q", res.PanelPassword)
	}

	// 写回 KV 的 CONFIG 也必须是沿用值
	var cfg map[string]any
	_ = json.Unmarshal([]byte(f.kvWrites["CONFIG"]), &cfg)
	if cfg["uuid"] != "KEEP-UUID" {
		t.Errorf("CONFIG 里的 uuid 应为沿用值，实际 %v", cfg["uuid"])
	}
}

// 参数校验。
func TestValidate(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Options)
		want   string
	}{
		{"缺 Token", func(o *Options) { o.Token = "" }, "Token"},
		{"缺账号", func(o *Options) { o.AccountID = "" }, "账号"},
		{"缺 KV", func(o *Options) { o.KVNamespaceID = "" }, "KV"},
		{"缺控制面产物", func(o *Options) { o.ControlScript = nil }, "控制面"},
		{"缺数据面产物", func(o *Options) { o.DataScript = nil }, "数据面"},
	}
	for _, tc := range cases {
		f := newFakeCF()
		d, _ := newTestDeployer(t, f, tc.mutate)
		_, err := d.Run(context.Background())
		if err == nil {
			t.Errorf("%s：应报错", tc.name)
			continue
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s：错误信息应含 %q，实际 %v", tc.name, tc.want, err)
		}
	}
}

// 空脚本不该发起部署。
func TestEmptyScriptSkipsDeploy(t *testing.T) {
	f := newFakeCF()
	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.DataScript = nil
		o.WaitTimeout = time.Second
	})
	// 直接调内部方法验证
	d2 := d
	d2.opt.DataScript = nil
	res := d2.deployWithBlockRetry(context.Background(), deployAttemptParams{
		preferredName: "x",
		code:          nil,
		label:         "数据面",
	})
	if res != nil {
		t.Error("空脚本应返回 nil")
	}
	if len(f.deployOrder) != 0 {
		t.Error("空脚本不该发起部署")
	}
}

// ---------- 辅助 ----------

func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func keysOfInt(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, fmt.Sprintf("%s(%d)", k, m[k]))
	}
	return out
}

var _ = errors.New
