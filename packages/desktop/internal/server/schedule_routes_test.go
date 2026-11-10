package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/schedule"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/store"
)

// 定时优选任务接口的端到端测试（不碰网络：只测任务的增删改查与冲突判定）。
//
// 用例覆盖：
//   - 首次访问自动物化 5 条内置任务
//   - 新建任务
//   - 运行时刻冲突被拒绝
//   - 批量修改只提交改动过的字段
//   - 内置任务不可删除
//   - 池内 IP 去重覆盖

// newScheduleTestServer 起一个带账号的服务实例（不监听端口）。
func newScheduleTestServer(t *testing.T) *Server {
	t.Helper()
	settings := config.DefaultSettings()
	s, err := New(settings)
	if err != nil {
		t.Fatal(err)
	}
	// 用临时目录做凭据库，避免写到用户真实的 ~/.cfpilot-gui
	s.SetStore(store.New(t.TempDir()))
	// 造一个账号
	p, err := s.store.Create("测试账号", &store.Profile{AccountID: "acc-1", AccountName: "测试"})
	if err != nil {
		t.Fatal(err)
	}
	if p.ID == "" {
		t.Fatal("账号创建失败")
	}
	// 先读一次清单 —— 内置任务是在首次访问时物化的
	callJSON(t, s.handleScheduleTasks, http.MethodGet, nil)
	return s
}

// callJSON 直接调用处理函数（绕过会话鉴权，聚焦业务逻辑）。
func callJSON(t *testing.T, h http.HandlerFunc, method string, body any) map[string]any {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, "/api/schedule/tasks", reader)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out
}

// 首次访问任务清单应自动生成 5 条内置任务。
func TestScheduleTasksMaterializeBuiltins(t *testing.T) {
	s := newScheduleTestServer(t)
	out := callJSON(t, s.handleScheduleTasks, http.MethodGet, nil)
	if out["ok"] != true {
		t.Fatalf("应成功，实际 %v", out)
	}
	tasks, _ := out["tasks"].([]any)
	if len(tasks) != 5 {
		t.Fatalf("应生成 5 条内置任务，实际 %d", len(tasks))
	}
	// 全部默认禁用、周期 2 天
	for _, raw := range tasks {
		task := raw.(map[string]any)
		if task["enabled"] == true {
			t.Fatalf("内置任务 %v 默认应为禁用", task["name"])
		}
		if task["intervalDays"].(float64) != 2 {
			t.Fatalf("内置任务周期应为 2，实际 %v", task["intervalDays"])
		}
		if task["builtin"] != true {
			t.Fatalf("内置任务缺少 builtin 标记：%v", task)
		}
	}
	// 二次访问不应重复生成
	out2 := callJSON(t, s.handleScheduleTasks, http.MethodGet, nil)
	tasks2, _ := out2["tasks"].([]any)
	if len(tasks2) != 5 {
		t.Fatalf("二次访问应仍是 5 条，实际 %d", len(tasks2))
	}
}

// 新建任务后应出现在清单里。
func TestScheduleTasksCreate(t *testing.T) {
	s := newScheduleTestServer(t)
	profile, _ := s.store.Active()
	out := callJSON(t, s.handleScheduleTasks, http.MethodPost, map[string]any{
		"name":         "我的任务",
		"description":  "说明",
		"intervalDays": 3,
		"runAt":        "03:30",
		"minSpeedMBps": 1.5,
		"scan": map[string]any{
			"family": "v4", "countries": []string{"ASIA"}, "sample": 1500,
			"top": 8, "speedMode": "two", "speedDurationMs": 6000,
			"speedConnections": 8, "probeTransport": "ws",
		},
	})
	if out["ok"] != true {
		t.Fatalf("创建失败：%v", out)
	}
	task := out["task"].(map[string]any)
	if task["name"] != "我的任务" {
		t.Fatalf("名称不符：%v", task["name"])
	}
	if task["profileId"] != profile.ID {
		t.Fatalf("应归属当前账号 %s，实际 %v", profile.ID, task["profileId"])
	}
	if task["intervalDays"].(float64) != 3 {
		t.Fatalf("周期不符：%v", task["intervalDays"])
	}
	// 清单里应能看到它
	list := callJSON(t, s.handleScheduleTasks, http.MethodGet, nil)
	tasks, _ := list["tasks"].([]any)
	if len(tasks) != 6 {
		t.Fatalf("清单应有 6 条（5 内置 + 1 新建），实际 %d", len(tasks))
	}
}

// 运行时刻冲突必须被拒绝。
func TestScheduleTasksConflictRejected(t *testing.T) {
	s := newScheduleTestServer(t)
	// 先把一条内置任务启用并定在 02:00（内置默认 02:00 的那条是亚洲组_IPv4）
	all := s.scheduleStore().Tasks()
	var target schedule.Task
	for _, tsk := range all {
		if tsk.RunAt == "02:00" {
			target = tsk
		}
	}
	if target.ID == "" {
		t.Fatal("没找到 02:00 的内置任务")
	}
	target.Enabled = true
	_ = s.scheduleStore().UpdateTasks(func(tasks []schedule.Task) []schedule.Task {
		for i := range tasks {
			if tasks[i].ID == target.ID {
				tasks[i] = target
			}
		}
		return tasks
	})
	// 新建一个 02:10 的任务 ⇒ 冲突
	out := callJSON(t, s.handleScheduleTasks, http.MethodPost, map[string]any{
		"name": "冲突任务", "intervalDays": 2, "runAt": "02:10",
		"scan": map[string]any{"family": "v4", "sample": 1500, "top": 8, "speedMode": "two"},
	})
	if out["ok"] != false {
		t.Fatalf("冲突的任务应被拒绝，实际 %v", out)
	}
	if out["error"] == nil || out["error"] == "" {
		t.Fatal("应给出冲突原因")
	}
	// 02:45 不冲突（相隔 45 分钟）
	ok := callJSON(t, s.handleScheduleTasks, http.MethodPost, map[string]any{
		"name": "不冲突", "intervalDays": 2, "runAt": "02:45",
		"scan": map[string]any{"family": "v4", "sample": 1500, "top": 8, "speedMode": "two"},
	})
	if ok["ok"] != true {
		t.Fatalf("不冲突的任务应创建成功：%v", ok)
	}
}

// 批量修改：只提交改动过的字段。
func TestScheduleTasksBatchUpdate(t *testing.T) {
	s := newScheduleTestServer(t)
	all := s.scheduleStore().Tasks()
	if len(all) < 2 {
		t.Fatal("任务不足")
	}
	ids := []string{all[0].ID, all[1].ID}
	before := map[string]string{}
	for _, tsk := range all {
		if tsk.ID == ids[0] || tsk.ID == ids[1] {
			before[tsk.ID] = tsk.Name
		}
	}
	// 只改运行时间
	out := callJSON(t, s.handleScheduleTasks, http.MethodPut, map[string]any{
		"ids": ids, "runAt": "12:00",
	})
	if out["ok"] != true {
		t.Fatalf("批量修改失败：%v", out)
	}
	after := s.scheduleStore().Tasks()
	for _, tsk := range after {
		if tsk.ID != ids[0] && tsk.ID != ids[1] {
			continue
		}
		if tsk.RunAt != "12:00" {
			t.Fatalf("运行时间应被改成 12:00，实际 %s", tsk.RunAt)
		}
		if tsk.Name != before[tsk.ID] {
			t.Fatalf("未改动的名称不应被覆盖：%s → %s", before[tsk.ID], tsk.Name)
		}
	}
}

// 批量修改也要做冲突校验。
//
// ⚠️ 内置任务默认是**禁用**的 —— 禁用的任务不参与冲突判定（它不会跑）。
// 所以这里先把它们启用，再验证冲突能被拦下。
func TestScheduleTasksBatchUpdateConflict(t *testing.T) {
	s := newScheduleTestServer(t)
	all := s.scheduleStore().Tasks()
	_ = s.scheduleStore().UpdateTasks(func(tasks []schedule.Task) []schedule.Task {
		for i := range tasks {
			tasks[i].Enabled = true
		}
		return tasks
	})
	out := callJSON(t, s.handleScheduleTasks, http.MethodPut, map[string]any{
		"ids": []string{all[0].ID, all[1].ID}, "runAt": "07:00",
	})
	if out["ok"] != false {
		t.Fatalf("两个启用中的任务改成同一时刻应被拒绝，实际 %v", out)
	}
}

// 内置任务不可删除。
func TestScheduleTasksBuiltinNotDeletable(t *testing.T) {
	s := newScheduleTestServer(t)
	all := s.scheduleStore().Tasks()
	builtinID := ""
	userID := ""
	for _, tsk := range all {
		if tsk.Builtin && builtinID == "" {
			builtinID = tsk.ID
		}
	}
	// 造一条用户任务
	created := callJSON(t, s.handleScheduleTasks, http.MethodPost, map[string]any{
		"name": "用户任务", "intervalDays": 2, "runAt": "20:00",
		"scan": map[string]any{"family": "v4", "sample": 1500, "top": 8, "speedMode": "two"},
	})
	userID = created["task"].(map[string]any)["id"].(string)

	out := callJSON(t, s.handleScheduleTasks, http.MethodDelete, map[string]any{
		"ids": []string{builtinID, userID},
	})
	if out["ok"] != true {
		t.Fatalf("删除应返回成功（内置被跳过）：%v", out)
	}
	if out["deleted"].(float64) != 1 {
		t.Fatalf("应只删掉 1 条（用户任务），实际 %v", out["deleted"])
	}
	skipped, _ := out["skipped"].([]any)
	if len(skipped) != 1 {
		t.Fatalf("内置任务应被跳过并说明原因，实际 %v", skipped)
	}
	// 内置任务应还在
	found := false
	for _, tsk := range s.scheduleStore().Tasks() {
		if tsk.ID == builtinID {
			found = true
		}
	}
	if !found {
		t.Fatal("内置任务不应被删除")
	}
}

// 内置任务不能改名。
func TestScheduleTasksBuiltinCannotRename(t *testing.T) {
	s := newScheduleTestServer(t)
	all := s.scheduleStore().Tasks()
	var builtin schedule.Task
	for _, tsk := range all {
		if tsk.Builtin {
			builtin = tsk
			break
		}
	}
	if builtin.ID == "" {
		t.Fatal("没找到内置任务")
	}
	out := callJSON(t, s.handleScheduleTasks, http.MethodPut, map[string]any{
		"ids": []string{builtin.ID}, "name": "我改的名字",
	})
	if out["ok"] != false {
		t.Fatalf("内置任务改名应被拒绝，实际 %v", out)
	}
	// 名称应保持原样
	for _, tsk := range s.scheduleStore().Tasks() {
		if tsk.ID == builtin.ID && tsk.Name != builtin.Name {
			t.Fatalf("内置任务名称被改了：%s → %s", builtin.Name, tsk.Name)
		}
	}
	// 改其它参数（周期）应当允许
	ok := callJSON(t, s.handleScheduleTasks, http.MethodPut, map[string]any{
		"ids": []string{builtin.ID}, "intervalDays": 5,
	})
	if ok["ok"] != true {
		t.Fatalf("内置任务改周期应被允许，实际 %v", ok)
	}
}

// 同一账号最多启用 3 个任务。
func TestScheduleTasksEnabledLimit(t *testing.T) {
	s := newScheduleTestServer(t)
	all := s.scheduleStore().Tasks()
	if len(all) < 4 {
		t.Fatalf("内置任务不足 4 条，实际 %d", len(all))
	}
	// 先启用 3 个
	first3 := []string{all[0].ID, all[1].ID, all[2].ID}
	out := callJSON(t, s.handleScheduleTasks, http.MethodPut, map[string]any{
		"ids": first3, "enabled": true,
	})
	if out["ok"] != true {
		t.Fatalf("启用 3 个应成功：%v", out)
	}
	// 第 4 个应被拒绝
	fourth := callJSON(t, s.handleScheduleTasks, http.MethodPut, map[string]any{
		"ids": []string{all[3].ID}, "enabled": true,
	})
	if fourth["ok"] != false {
		t.Fatalf("启用第 4 个应被拒绝，实际 %v", fourth)
	}
	msg, _ := fourth["error"].(string)
	if msg == "" {
		t.Fatal("应给出上限说明")
	}
	// 停用一个之后，第 4 个应能启用
	off := callJSON(t, s.handleScheduleTasks, http.MethodPut, map[string]any{
		"ids": []string{all[0].ID}, "enabled": false,
	})
	if off["ok"] != true {
		t.Fatalf("停用应成功：%v", off)
	}
	again := callJSON(t, s.handleScheduleTasks, http.MethodPut, map[string]any{
		"ids": []string{all[3].ID}, "enabled": true,
	})
	if again["ok"] != true {
		t.Fatalf("停用一个之后启用第 4 个应成功，实际 %v", again)
	}
}

// 列表接口要报出启用数与上限（界面要显示出来）。
func TestScheduleTasksReportsEnabledLimit(t *testing.T) {
	s := newScheduleTestServer(t)
	out := callJSON(t, s.handleScheduleTasks, http.MethodGet, nil)
	if out["enabledLimit"] != float64(3) {
		t.Fatalf("上限应为 3，实际 %v", out["enabledLimit"])
	}
	if out["enabledCount"] != float64(0) {
		t.Fatalf("初始启用数应为 0，实际 %v", out["enabledCount"])
	}
}

// 池：同 IP 覆盖、新 IP 追加。
func TestSchedulePoolDedup(t *testing.T) {
	s := newScheduleTestServer(t)
	st := s.scheduleStore()
	entries := []schedule.PoolEntry{
		{IP: "104.16.0.1", Port: 443, ProfileID: "acc", Speed: 1, Remark: "IPv4_SJC_10_1"},
	}
	st.UpdatePool(func(cur []schedule.PoolEntry) []schedule.PoolEntry {
		next, _ := schedule.AddEntries(cur, entries)
		return next
	})
	st.UpdatePool(func(cur []schedule.PoolEntry) []schedule.PoolEntry {
		next, _ := schedule.AddEntries(cur, []schedule.PoolEntry{
			{IP: "104.16.0.1", Port: 443, ProfileID: "acc", Speed: 9, Remark: "IPv4_SJC_10_9"},
			{IP: "104.16.0.2", Port: 443, ProfileID: "acc", Speed: 2, Remark: "IPv4_LAX_10_2"},
		})
		return next
	})
	pool := st.Pool()
	if len(pool) != 2 {
		t.Fatalf("池应有 2 条，实际 %d", len(pool))
	}
	for _, e := range pool {
		if e.IP == "104.16.0.1" && e.Speed != 9 {
			t.Fatalf("重复 IP 应被最新一轮覆盖，实际 speed=%v", e.Speed)
		}
	}
}

// 没有账号时不应报错（正常状态）。
func TestScheduleTasksNoAccount(t *testing.T) {
	settings := config.DefaultSettings()
	s, err := New(settings)
	if err != nil {
		t.Fatal(err)
	}
	s.SetStore(store.New(t.TempDir()))
	out := callJSON(t, s.handleScheduleTasks, http.MethodGet, nil)
	if out["ok"] != true {
		t.Fatalf("没有账号是正常状态，不该报错：%v", out)
	}
	if out["hint"] == nil || out["hint"] == "" {
		t.Fatal("应给出提示文案")
	}
}
