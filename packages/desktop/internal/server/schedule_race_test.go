package server

// 「竞速回填」的回归测试。
//
// 这里只测**纯逻辑**（候选合并、地址族过滤、回填取前 N 条、接口字段透传）——
// 真实的 KV 读 / 面板登录 / 回填要外网，由真机验证。

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/schedule"
)

// 面板池里的 IP 必须排在采样候选之前，且已有的不重复计入。
func TestMergeRaceCandidatesPoolFirstAndDedup(t *testing.T) {
	pool := []string{"104.16.0.1", "104.16.0.2"}
	sampled := []string{"104.16.0.2", "104.17.0.9", "104.18.0.9"}
	got, added := mergeRaceCandidates(pool, sampled, "both")
	if added != 1 {
		t.Fatalf("去重后应只新增 1 条（104.16.0.2 已在采样里），实际 %d", added)
	}
	if len(got) != 4 {
		t.Fatalf("合并后应有 4 条，实际 %d：%v", len(got), got)
	}
	// 池在前：先比旧赢家，再比新候选
	if got[0] != "104.16.0.1" || got[1] != "104.16.0.2" {
		t.Fatalf("池内 IP 应排在前面，实际 %v", got)
	}
	// 采样候选一条不少
	seen := map[string]bool{}
	for _, host := range got {
		seen[host] = true
	}
	for _, host := range sampled {
		if !seen[host] {
			t.Fatalf("采样候选 %s 被丢掉了：%v", host, got)
		}
	}
}

// 任务只跑 v4 时，池里的 v6 不能被拉进候选（反之亦然）。
func TestMergeRaceCandidatesFiltersFamily(t *testing.T) {
	pool := []string{"104.16.0.1", "2606:4700::1", "104.16.0.2"}
	cases := []struct {
		family string
		want   int
	}{
		{"v4", 2},
		{"v6", 1},
		{"both", 3},
		{"auto", 3},
		{"", 3},
	}
	for _, c := range cases {
		got, added := mergeRaceCandidates(pool, nil, c.family)
		if added != c.want {
			t.Errorf("family=%q 应收 %d 条，实际 %d（%v）", c.family, c.want, added, got)
		}
	}
}

// 池里的 IP 数量要有上限 —— 否则阶段一会凭空多出几千次握手。
func TestMergeRaceCandidatesCapsPool(t *testing.T) {
	pool := make([]string, 0, maxRacePoolCandidates+50)
	for i := 0; i < maxRacePoolCandidates+50; i++ {
		pool = append(pool, fmt.Sprintf("104.16.%d.%d", i/256%256, i%256))
	}
	got, added := mergeRaceCandidates(pool, nil, "v4")
	if added != maxRacePoolCandidates {
		t.Fatalf("池内候选应被截到 %d 条，实际 %d", maxRacePoolCandidates, added)
	}
	if len(got) != maxRacePoolCandidates {
		t.Fatalf("合并结果应为 %d 条，实际 %d", maxRacePoolCandidates, len(got))
	}
}

// 回填只取前 N 条（N = 任务的保留条数）。
func TestRaceBackfillTargetsTakesTop(t *testing.T) {
	entries := []schedule.PoolEntry{
		{IP: "a", Speed: 9},
		{IP: "b", Speed: 8},
		{IP: "c", Speed: 7},
	}
	if got := raceBackfillTargets(entries, 2); len(got) != 2 || got[1].IP != "b" {
		t.Fatalf("应取前 2 条，实际 %v", got)
	}
	// N 比结果多时按实际条数返回（不补空）
	if got := raceBackfillTargets(entries, 10); len(got) != 3 {
		t.Fatalf("N 大于结果数时应全给，实际 %d", len(got))
	}
	// N <= 0 / 空结果都不回填
	if got := raceBackfillTargets(entries, 0); got != nil {
		t.Fatalf("N=0 不应回填，实际 %v", got)
	}
	if got := raceBackfillTargets(nil, 5); got != nil {
		t.Fatalf("空结果不应回填，实际 %v", got)
	}
}

// 新建任务时 raceBackfill 要透传并存盘。
func TestScheduleTasksCreateRaceBackfill(t *testing.T) {
	s := newScheduleTestServer(t)
	out := callJSON(t, s.handleScheduleTasks, http.MethodPost, map[string]any{
		"name":         "竞速任务",
		"intervalDays": 2,
		"runAt":        "05:00",
		"raceBackfill": true,
		"scan": map[string]any{
			"family": "v4", "sample": 300, "top": 6,
			"speedMode": "two", "speedDurationMs": 3000,
			"speedConnections": 8, "probeTransport": "ws",
		},
	})
	if out["ok"] != true {
		t.Fatalf("创建失败：%v", out)
	}
	task := out["task"].(map[string]any)
	if task["raceBackfill"] != true {
		t.Fatalf("raceBackfill 应为 true，实际 %v", task["raceBackfill"])
	}
	// 落盘的也要是 true（否则重启后开关会「自己关掉」）
	var saved schedule.Task
	for _, tsk := range s.scheduleStore().Tasks() {
		if tsk.Name == "竞速任务" {
			saved = tsk
		}
	}
	if !saved.RaceBackfill {
		t.Fatalf("存盘的任务应保留 raceBackfill=true")
	}
}

// 批量修改可以打开 / 关闭竞速回填，且只在显式传了该字段时才改。
func TestScheduleTasksUpdateRaceBackfill(t *testing.T) {
	s := newScheduleTestServer(t)
	st := s.scheduleStore()
	all := st.Tasks()
	var target schedule.Task
	for _, tsk := range all {
		if !tsk.Builtin {
			continue
		}
		target = tsk
		break
	}
	if target.ID == "" {
		t.Fatal("没有内置任务可用于测试")
	}

	// 打开
	out := callJSON(t, s.handleScheduleTasks, http.MethodPut, map[string]any{
		"ids": []string{target.ID}, "raceBackfill": true,
	})
	if out["ok"] != true {
		t.Fatalf("修改失败：%v", out)
	}
	if got := taskByID(t, s, target.ID); !got.RaceBackfill {
		t.Fatal("应已打开竞速回填")
	}

	// 只改别的字段时不能被抹成 false
	out = callJSON(t, s.handleScheduleTasks, http.MethodPut, map[string]any{
		"ids": []string{target.ID}, "runAt": "06:30",
	})
	if out["ok"] != true {
		t.Fatalf("修改失败：%v", out)
	}
	if got := taskByID(t, s, target.ID); !got.RaceBackfill {
		t.Fatal("未提交 raceBackfill 时不应被改成 false")
	}

	// 关闭
	out = callJSON(t, s.handleScheduleTasks, http.MethodPut, map[string]any{
		"ids": []string{target.ID}, "raceBackfill": false,
	})
	if out["ok"] != true {
		t.Fatalf("修改失败：%v", out)
	}
	if got := taskByID(t, s, target.ID); got.RaceBackfill {
		t.Fatal("应已关闭竞速回填")
	}
}

// taskByID 从存储里取一条任务。
func taskByID(t *testing.T, s *Server, id string) schedule.Task {
	t.Helper()
	for _, tsk := range s.scheduleStore().Tasks() {
		if tsk.ID == id {
			return tsk
		}
	}
	t.Fatalf("找不到任务 %s", id)
	return schedule.Task{}
}
