package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

func TestQualityHistoryMigratesArray(t *testing.T) {
	st := newTestStore(t, 10)
	old := mkSession("legacy", "2026-11-01T00:00:00Z")
	raw, _ := json.Marshal([]Session{old})
	if err := os.WriteFile(st.path(), raw, 0600); err != nil {
		t.Fatal(err)
	}
	list, err := st.Load()
	if err != nil || len(list) != 1 {
		t.Fatalf("旧数组不可读: %v", err)
	}
	if err := st.Save(mkSession("new", "2026-11-01T01:00:00Z")); err != nil {
		t.Fatal(err)
	}
	raw, err = os.ReadFile(st.path())
	if err != nil {
		t.Fatal(err)
	}
	var doc document
	if err := json.Unmarshal(raw, &doc); err != nil || doc.Version != SchemaVersion || len(doc.Sessions) != 2 {
		t.Fatalf("未迁移 envelope: %v", err)
	}
	var migrated *Session
	for i := range doc.Sessions {
		if doc.Sessions[i].ID == "legacy" {
			migrated = &doc.Sessions[i]
		}
	}
	if migrated == nil || migrated.Host != old.Host || migrated.WSPath != old.WSPath || migrated.Entries[0].IP != old.Entries[0].IP {
		t.Fatal("迁移丢失历史字段")
	}
	if doc.Sessions[0].Entries[0].QualityReport == nil {
		t.Fatal("新会话未保存质量报告")
	}
}

func TestQualityHistoryRefusesDestructiveOverwrite(t *testing.T) {
	for _, raw := range []string{`{"version":999,"sessions":[]}`, `{broken`} {
		t.Run(raw, func(t *testing.T) {
			st := newTestStore(t, 10)
			_ = os.WriteFile(st.path(), []byte(raw), 0600)
			if err := st.Save(mkSession("x", "")); err == nil {
				t.Fatal("不应覆盖不兼容历史")
			}
			got, _ := os.ReadFile(st.path())
			if string(got) != raw {
				t.Fatal("原文件被覆盖")
			}
		})
	}
}

func TestQualityReportEvidenceAndScope(t *testing.T) {
	a := mkSession("a", "2026-11-01T00:00:00Z")
	a.SkipSpeed = true
	b := mkSession("b", "2026-11-01T01:00:00Z")
	b.Entries[0].Tests = []LastTest{{At: "2026-11-01T01:01:00Z", OK: false, TCPMs: 10, TLSMs: 20, WSOK: false}, {At: "2026-11-01T01:02:00Z", OK: true, TCPMs: 8, TLSMs: 18, WSOK: true}}
	b.Entries[0].LastTest = &b.Entries[0].Tests[1]
	foreign := mkSession("foreign", "2026-11-01T02:00:00Z")
	foreign.Host = "other.example.com"
	now := time.Date(2026, 11, 1, 3, 0, 0, 0, time.UTC)
	report, err := BuildQualityReport([]Session{foreign, b, a}, "b", "104.16.1.1", 443, now)
	if err != nil {
		t.Fatal(err)
	}
	if report.History.TestCount != 4 || report.History.SuccessRate != 0.75 {
		t.Fatalf("样本统计错误: %+v", report.History)
	}
	if report.History.FirstSeen != a.At || report.History.LastSeen != b.Entries[0].Tests[1].At {
		t.Fatal("历史排序错误")
	}
	if report.Protocol.PongOK != nil || report.Protocol.RealTunnelOK != nil || report.Egress.Status != "not-run" || len(report.Compatibility.Targets) != 0 {
		t.Fatal("未检测能力不得伪装通过")
	}
	statuses := map[string]string{}
	for _, f := range report.Fields {
		statuses[f.Name] = f.Status
	}
	if statuses["protocol.pongOk"] != "not_implemented" || statuses["egress"] != "not_run" || statuses["performance.speedMBps"] != "available" {
		t.Fatalf("字段状态错误: %+v", statuses)
	}
	if report.History.Trend[0].SpeedMBps != nil {
		t.Fatal("跳过测速不能显示零速")
	}
	if _, err := BuildQualityReport([]Session{a}, "a", "104.16.1.1", 8443, now); err == nil {
		t.Fatal("端口不得混合")
	}
}

// 质量报告必须能给出真实取值，而不是一律「未执行」。
//
// 回归点：早期版本没有把阶段一的 TCP 耗时和阶段三的测速峰值带进历史条目，
// 于是报告里的 TCP 耗时永远是「未执行」、峰值永远是「尚未实现」——
// 数据其实早就测出来了，只是没落库。
func TestQualityReportUsesRecordedTCPAndPeak(t *testing.T) {
	sess := mkSession("a", "2026-11-01T00:00:00Z")
	sess.Entries[0].TCPMs = 42
	sess.Entries[0].PeakSpeed = 2.4
	now := time.Date(2026, 11, 1, 3, 0, 0, 0, time.UTC)
	report, err := BuildQualityReport([]Session{sess}, "a", "104.16.1.1", 443, now)
	if err != nil {
		t.Fatal(err)
	}
	if report.Basic.TCPMs == nil || *report.Basic.TCPMs != 42 || report.Basic.Status != "available" {
		t.Fatalf("TCP 耗时未取到实际值: %+v", report.Basic)
	}
	if report.Performance.PeakMBps == nil || *report.Performance.PeakMBps != 2.4 {
		t.Fatalf("测速峰值未取到实际值: %+v", report.Performance)
	}
	statuses := map[string]string{}
	for _, f := range report.Fields {
		statuses[f.Name] = f.Status
	}
	if statuses["basic.tcpMs"] != "available" || statuses["performance.peakMBps"] != "available" {
		t.Fatalf("字段状态错误: %+v", statuses)
	}
	// 只有一个样本时不能给出离散度数字。
	if statuses["performance.stabilityP95"] != "not_run" || statuses["performance.jitter"] != "not_run" {
		t.Fatalf("样本不足时不应给出离散度: %+v", statuses)
	}
}

// 样本足够时给出 P95 与抖动（同一个指标：TCP 建连耗时）。
func TestQualityReportComputesP95AndJitter(t *testing.T) {
	sess := mkSession("a", "2026-11-01T00:00:00Z")
	sess.Entries[0].TCPMs = 40
	sess.Entries[0].Tests = []LastTest{
		{At: "2026-11-01T00:01:00Z", OK: true, TCPMs: 60, TLSMs: 100, WSOK: true},
		{At: "2026-11-01T00:02:00Z", OK: true, TCPMs: 50, TLSMs: 100, WSOK: true},
	}
	now := time.Date(2026, 11, 1, 3, 0, 0, 0, time.UTC)
	report, err := BuildQualityReport([]Session{sess}, "a", "104.16.1.1", 443, now)
	if err != nil {
		t.Fatal(err)
	}
	if report.Performance.StabilityP95 == nil || *report.Performance.StabilityP95 != 60 {
		t.Fatalf("P95 计算错误: %+v", report.Performance)
	}
	if report.Performance.Jitter == nil || *report.Performance.Jitter != 20 {
		t.Fatalf("抖动计算错误: %+v", report.Performance)
	}
	statuses := map[string]string{}
	for _, f := range report.Fields {
		statuses[f.Name] = f.Status
	}
	if statuses["performance.stabilityP95"] != "available" || statuses["performance.jitter"] != "available" {
		t.Fatalf("字段状态错误: %+v", statuses)
	}
}

func TestQualityHistoryRetestSamplesBounded(t *testing.T) {
	st := newTestStore(t, 10)
	if err := st.Save(mkSession("a", "2026-11-01T00:00:00Z")); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxRetestSamples+3; i++ {
		if err := st.UpdateEntryTests("a", []scan.IPTestResult{{IP: "104.16.1.1", Port: 443, OK: i%2 == 0, TCPMs: 10, TLSMs: 20, WSOK: i%2 == 0, Speed: 1.2}}, true); err != nil {
			t.Fatal(err)
		}
	}
	list, err := st.Load()
	if err != nil {
		t.Fatal(err)
	}
	entry := list[0].Entries[0]
	if len(entry.Tests) != maxRetestSamples || entry.LastTest == nil || !entry.LastTest.WithSpeed || entry.QualityReport == nil {
		t.Fatalf("复测证据未正确存储: %+v", entry)
	}
	report, err := st.QualityReport("a", entry.IP, entry.Port)
	if err != nil || report.History.TestCount != maxRetestSamples+1 {
		t.Fatalf("报告计数错误: %v", err)
	}
	if report.Performance.SpeedMBps == nil || *report.Performance.SpeedMBps != 1.2 {
		t.Fatal("测速结果丢失")
	}
	if matches, _ := filepath.Glob(filepath.Join(st.dir, ".scan-history-*")); len(matches) != 0 {
		t.Fatal("临时文件残留")
	}
}
