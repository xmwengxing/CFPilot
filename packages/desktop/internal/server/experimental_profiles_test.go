package server

// 实验性功能（自适应采样）的服务端测试。
//
// 重点验证：
//   - 地区归一化（不同写法必须落到同一个档案）
//   - 档案状态（样本量、是否够用、久未使用提示）
//   - 档案重命名 / 删除（观测要跟着迁移或一起删）
//   - A/B 对照（同档案同域名，样本不足要明确说）

import (
	"bytes"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/history"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

func TestNormalizeRegionMergesSpellings(t *testing.T) {
	for _, raw := range []string{"福建", " 福建 ", "福建省", "闽"} {
		if got := scan.NormalizeRegion(raw); got != "福建" {
			t.Errorf("地区归一化 %q → %q，期望 福建", raw, got)
		}
	}
	if got := scan.NormalizeRegion("内蒙古自治区"); got != "内蒙古" {
		t.Errorf("内蒙古自治区 → %q", got)
	}
	if got := scan.NormalizeRegion(""); got != "" {
		t.Errorf("空地区应为空串，实际 %q", got)
	}
	// 不同写法必须落到同一个档案 ID（否则历史被切碎）。
	a := scan.NewNetworkProfile(scan.NetworkProfile{ISP: "ct", Region: "福建省", Access: "fixed", Family: "ipv4"})
	b := scan.NewNetworkProfile(scan.NetworkProfile{ISP: "ct", Region: "闽", Access: "fixed", Family: "ipv4"})
	if a.ID != b.ID {
		t.Fatalf("不同写法的地区应得到同一档案：%s vs %s", a.ID, b.ID)
	}
}

// 档案状态：样本不足要说清楚；久未使用要提示可能换了网络。
func TestProfileStatusReportsSamplesAndStaleness(t *testing.T) {
	now := time.Now().UTC()
	profile := scan.NewNetworkProfile(scan.NetworkProfile{ISP: "ct", Region: "福建", Access: "fixed", Family: "ipv4"})
	obs := []scan.PrefixObservation{{
		ProfileID: profile.ID, Prefix: "104.16.1.0/24", Stage: "ws",
		Attempts: 5, Successes: 4, Failures: map[string]float64{"timeout": 1},
		UpdatedAt: now.Add(-2 * time.Hour),
	}}
	view := buildProfileStatus(profile, obs, true, now)
	if view.Label != "中国电信 · 福建 · 固定宽带" {
		t.Errorf("档案名称不对：%q", view.Label)
	}
	if view.EnoughSamples {
		t.Error("样本不足时不应判定为充足")
	}
	if view.PrefixCount != 1 {
		t.Errorf("前缀数不对：%d", view.PrefixCount)
	}
	if view.Notice == "" {
		t.Error("应给出说明文案")
	}

	// 样本充足且刚用过：正常提示。
	full := make([]scan.PrefixObservation, 0, 25)
	for i := 0; i < 25; i++ {
		full = append(full, scan.PrefixObservation{
			ProfileID: profile.ID, Prefix: "104.16.2.0/24", Stage: "ws",
			Attempts: 4, Successes: 4, Failures: map[string]float64{},
			UpdatedAt: now.Add(-time.Hour),
		})
	}
	profile.LastUsedAt = now.Add(-time.Hour)
	view = buildProfileStatus(profile, full, true, now)
	if !view.EnoughSamples {
		t.Error("样本充足时应判定为充足")
	}
	if view.IdleDays != 0 {
		t.Errorf("闲置天数不对：%d", view.IdleDays)
	}
}

// 档案重命名：观测必须跟着迁移，不能丢样本。
func TestProfileRenameMigratesObservations(t *testing.T) {
	store := scan.NewProfileStore()
	old := store.PutProfile(scan.NetworkProfile{ISP: "ct", Region: "福建", Access: "fixed", Family: "ipv4"})
	store.RecordProbeResult(old.ID, "104.16.1.2", "ws", true, "", 20, 0, time.Now().UTC())

	next := scan.NewNetworkProfile(scan.NetworkProfile{ISP: "ct", Region: "广东", Access: "fixed", Family: "ipv4"})
	store.RenameProfile(old.ID, next)
	if _, ok := store.Profiles[old.ID]; ok {
		t.Error("旧档案应被移除")
	}
	if _, ok := store.Profiles[next.ID]; !ok {
		t.Error("新档案应存在")
	}
	obs := store.ForProfile(next.ID)
	if len(obs) != 1 {
		t.Fatalf("观测应迁移到新档案，实际 %d 条", len(obs))
	}
}

// 档案删除：档案与观测一起消失。
func TestProfileDeleteRemovesObservations(t *testing.T) {
	store := scan.NewProfileStore()
	p := store.PutProfile(scan.NetworkProfile{ISP: "cu", Region: "广东", Access: "fixed", Family: "ipv4"})
	store.RecordProbeResult(p.ID, "104.16.1.2", "ws", true, "", 20, 0, time.Now().UTC())
	store.DeleteProfile(p.ID)
	if _, ok := store.Profiles[p.ID]; ok {
		t.Error("档案应被删除")
	}
	if len(store.ForProfile(p.ID)) != 0 {
		t.Error("观测应一并删除")
	}
}

// A/B 对照：只有同档案同域名的会话才参与比较。
func TestAdaptiveEffectComparesSameProfileAndHost(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	profileID := "profile-1"
	sessions := []history.Session{
		{ID: "a1", At: "2026-11-01T01:00:00Z", Host: "demo.example.com", NetworkProfileID: profileID, Adaptive: true,
			Stats: &history.ScanStats{Candidates: 100, TCPOK: 80, TLSOK: 70, WSOK: 60, SpeedOK: 10, ElapsedMs: 60000}},
		{ID: "a2", At: "2026-11-01T02:00:00Z", Host: "demo.example.com", NetworkProfileID: profileID, Adaptive: false,
			Stats: &history.ScanStats{Candidates: 100, TCPOK: 50, TLSOK: 40, WSOK: 30, SpeedOK: 5, ElapsedMs: 70000}},
		// 别的域名：不能混进对照
		{ID: "a3", At: "2026-11-01T03:00:00Z", Host: "other.example.com", NetworkProfileID: profileID, Adaptive: false,
			Stats: &history.ScanStats{Candidates: 100, TCPOK: 99, WSOK: 99, SpeedOK: 50}},
	}
	store := s.historyStore()
	for _, sess := range sessions {
		if err := store.Save(sess); err != nil {
			t.Fatal(err)
		}
	}

	code, body := getJSON(t, base+"/api/scan/adaptive-effect?profileId="+profileID, cookie)
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", code)
	}
	enabled := body["enabled"].(map[string]any)
	disabled := body["disabled"].(map[string]any)
	if enabled["runs"].(float64) != 1 || disabled["runs"].(float64) != 1 {
		t.Fatalf("两侧轮数不对：%v / %v", enabled["runs"], disabled["runs"])
	}
	// 阶段一通过率：80% vs 50%（别的域名那条不能算进来）
	if got := enabled["tcpRate"].(float64); got < 0.79 || got > 0.81 {
		t.Errorf("开启侧阶段一通过率不对：%v", got)
	}
	if got := disabled["tcpRate"].(float64); got < 0.49 || got > 0.51 {
		t.Errorf("关闭侧阶段一通过率不对：%v", got)
	}
	if body["notice"] == "" {
		t.Error("应给出对照说明")
	}
}

// 档案管理接口：列表、重命名、删除。
func TestExperimentalProfileManagementAPI(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	// 建一个档案并写一条观测
	store := scan.NewProfileStore()
	p := store.PutProfile(scan.NetworkProfile{ISP: "ct", Region: "福建", Access: "fixed", Family: "ipv4"})
	store.RecordProbeResult(p.ID, "104.16.1.2", "ws", true, "", 20, 0, time.Now().UTC())
	path := filepath.Join(s.store.DirPath(), "scan-profiles.json")
	if err := store.Save(path); err != nil {
		t.Fatal(err)
	}

	code, body := getJSON(t, base+"/api/experimental/profiles", cookie)
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", code)
	}
	list, ok := body["profiles"].([]any)
	if !ok || len(list) != 1 {
		t.Fatalf("档案列表不对：%v", body["profiles"])
	}

	// 重命名（改地区 → 新 ID，观测跟着走）
	code, body = putJSON(t, base+"/api/experimental/profiles", cookie, map[string]any{
		"id": p.ID, "isp": "ct", "region": "广东", "access": "fixed",
	})
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("重命名应成功：%d %v", code, body)
	}
	after := scan.NewProfileStore()
	loaded, err := scan.LoadProfileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	_ = after
	if len(loaded.Profiles) != 1 {
		t.Fatalf("档案数不对：%d", len(loaded.Profiles))
	}
	migrated := false
	for id := range loaded.Profiles {
		if id != p.ID {
			migrated = true
			if len(loaded.ForProfile(id)) != 1 {
				t.Error("观测应迁移到新档案")
			}
		}
	}
	if !migrated {
		t.Error("重命名后档案 ID 应变化")
	}

	// 删除
	newID := ""
	for id := range loaded.Profiles {
		newID = id
	}
	code, body = callDelete(t, base+"/api/experimental/profiles?id="+newID, cookie)
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("删除应成功：%d %v", code, body)
	}
	loaded, err = scan.LoadProfileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Profiles) != 0 {
		t.Errorf("档案应被删除，实际 %d", len(loaded.Profiles))
	}
}

// 状态接口要带上当前档案与全部档案。
func TestExperimentalStatusIncludesProfile(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := getJSON(t, base+"/api/experimental", cookie)
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", code)
	}
	raw, _ := json.Marshal(body)
	if !json.Valid(raw) {
		t.Fatal("响应不是合法 JSON")
	}
	if _, ok := body["profile"]; !ok {
		t.Error("应返回当前档案状态")
	}
	if _, ok := body["profiles"]; !ok {
		t.Error("应返回全部档案")
	}
}

// putJSON 发一个 PUT 请求（测试用）。
func putJSON(t *testing.T, url string, cookie *http.Cookie, payload map[string]any) (int, map[string]any) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}
