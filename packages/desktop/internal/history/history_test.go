package history

// 优选历史库的单元测试。
//
// 重点验证：
//   - 保存后 Load 返回最新在前
//   - 容量裁剪（只留最近 N 条）
//   - Delete 只删指定 id
//   - UpdateEntryLastTest 只更新目标条目、生成完整结论

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

func newTestStore(t *testing.T, capN int) *Store {
	t.Helper()
	return New(t.TempDir(), capN)
}

func mkSession(id, at string) Session {
	return Session{
		ID:     id,
		At:     at,
		Host:   "cf.example.com",
		WSPath: "/ws",
		Source: "local",
		Entries: []Entry{
			{IP: "104.16.1.1", Port: 443, Colo: "NRT", Latency: 40, TLSMs: 180, Speed: 1.2},
			{IP: "104.17.2.2", Port: 443, Colo: "HKG", Latency: 55, TLSMs: 200, Speed: 0.9},
		},
	}
}

// 保存后 Load 应最新在前；超过容量时裁掉最旧的。
func TestSaveLoadPrune(t *testing.T) {
	st := newTestStore(t, 3)

	// 故意按时间乱序写入：Save 插最前，Load 再按时间倒序稳定排序
	for _, id := range []string{"s1", "s2", "s3", "s4", "s5"} {
		at := map[string]string{
			"s1": "2026-10-30T01:00:00.000Z",
			"s2": "2026-10-30T02:00:00.000Z",
			"s3": "2026-10-30T03:00:00.000Z",
			"s4": "2026-10-30T04:00:00.000Z",
			"s5": "2026-10-30T05:00:00.000Z",
		}[id]
		if err := st.Save(mkSession(id, at)); err != nil {
			t.Fatalf("Save(%s) 失败：%v", id, err)
		}
	}

	list, err := st.Load()
	if err != nil {
		t.Fatalf("Load 失败：%v", err)
	}
	if len(list) != 3 {
		t.Fatalf("容量 3 应只留 3 条，实际 %d 条", len(list))
	}
	if list[0].ID != "s5" || list[1].ID != "s4" || list[2].ID != "s3" {
		t.Errorf("应按时间倒序 s5/s4/s3，实际 %s/%s/%s", list[0].ID, list[1].ID, list[2].ID)
	}
}

// 文件不存在时 Load 返回空列表且不报错。
func TestLoadEmpty(t *testing.T) {
	st := newTestStore(t, 5)
	list, err := st.Load()
	if err != nil {
		t.Fatalf("空库 Load 不应报错：%v", err)
	}
	if len(list) != 0 {
		t.Errorf("空库应返回 0 条，实际 %d 条", len(list))
	}
}

// Delete 只删指定 id；不存在的 id 静默成功。
func TestDelete(t *testing.T) {
	st := newTestStore(t, 10)
	ats := map[string]string{
		"a": "2026-10-30T01:00:00.000Z",
		"b": "2026-10-30T02:00:00.000Z",
		"c": "2026-10-30T03:00:00.000Z",
	}
	for _, id := range []string{"a", "b", "c"} {
		if err := st.Save(mkSession(id, ats[id])); err != nil {
			t.Fatalf("Save(%s) 失败：%v", id, err)
		}
	}

	if err := st.Delete("b"); err != nil {
		t.Fatalf("Delete 失败：%v", err)
	}
	list, _ := st.Load()
	if len(list) != 2 {
		t.Fatalf("删完应剩 2 条，实际 %d 条", len(list))
	}
	for _, s := range list {
		if s.ID == "b" {
			t.Errorf("b 应已被删除")
		}
	}

	// 不存在的 id：不报错、不变动
	if err := st.Delete("nope"); err != nil {
		t.Errorf("删除不存在的 id 不应报错：%v", err)
	}
	list2, _ := st.Load()
	if len(list2) != 2 {
		t.Errorf("删除不存在的 id 后条数不应变化，实际 %d", len(list2))
	}
}

// Save 未传 ID / At 时自动补全，且落盘文件确实存在。
func TestSaveAutofillAndFile(t *testing.T) {
	dir := t.TempDir()
	st := New(dir, 5)
	sess := mkSession("", "")
	if sess.ID != "" || sess.At != "" {
		t.Fatalf("测试前置：会话应为空 id/At")
	}
	if err := st.Save(sess); err != nil {
		t.Fatalf("Save 失败：%v", err)
	}
	list, _ := st.Load()
	if len(list) != 1 {
		t.Fatalf("应 1 条，实际 %d", len(list))
	}
	if list[0].ID == "" || list[0].At == "" {
		t.Errorf("应自动补全 id/At，实际 id=%q at=%q", list[0].ID, list[0].At)
	}
	if _, err := os.Stat(filepath.Join(dir, "scan-history.json")); err != nil {
		t.Errorf("历史文件应存在：%v", err)
	}
}

// UpdateEntryLastTest：按 ip:port 定位更新；找不到的条目忽略。
func TestUpdateEntryLastTest(t *testing.T) {
	st := newTestStore(t, 5)
	if err := st.Save(mkSession("s1", "2026-10-30T01:00:00.000Z")); err != nil {
		t.Fatalf("Save 失败：%v", err)
	}

	results := []scan.IPTestResult{
		{IP: "104.16.1.1", Port: 443, OK: true, Colo: "SIN", TCPMs: 40, TLSMs: 190, WSOK: true},
		{IP: "999.999.999.999", Port: 443, OK: false, Error: "超时"}, // 不在会话里 → 忽略
	}
	if err := st.UpdateEntryLastTest("s1", results); err != nil {
		t.Fatalf("UpdateEntryLastTest 失败：%v", err)
	}

	list, _ := st.Load()
	sess := list[0]
	if sess.ID != "s1" {
		t.Fatalf("应更新到 s1，实际 %s", sess.ID)
	}
	e0 := sess.Entries[0]
	if e0.LastTest == nil {
		t.Fatalf("第一条应有复测结论")
	}
	if !e0.LastTest.OK || e0.LastTest.Colo != "SIN" {
		t.Errorf("复测结论错误：%+v", e0.LastTest)
	}
	if e0.LastTest.At == "" {
		t.Errorf("复测结论应带时间")
	}
	e1 := sess.Entries[1]
	if e1.LastTest != nil {
		t.Errorf("不在结果里的条目不应被写：%+v", e1.LastTest)
	}

	// 会话不存在时静默成功
	if err := st.UpdateEntryLastTest("nope", results); err != nil {
		t.Errorf("会话不存在不应报错：%v", err)
	}
}
