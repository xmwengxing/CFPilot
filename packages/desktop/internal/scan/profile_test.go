package scan

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

func TestProfileStageDecayAndTimeValidation(t *testing.T) {
	s := NewProfileStore()
	at := time.Now().UTC().Add(-DefaultProfileHalfLife)
	if !s.RecordProbeResult("a", "104.16.1.2", "ws", false, "timeout", 0, 0, at) || !s.RecordProbeResult("a", "104.16.1.2", "ws", true, "", 20, 2, at.Add(DefaultProfileHalfLife)) {
		t.Fatal("有效阶段记录失败")
	}
	o := s.ForProfile("a")[0]
	if math.Abs(o.Attempts-1.5) > 1e-8 || o.Successes != 1 || math.Abs(o.Failures["timeout"]-0.5) > 1e-8 || o.LatencyMs != 20 || o.SpeedMBps != 2 {
		t.Fatalf("半衰期或失败统计错误：%+v", o)
	}
	for _, tt := range []struct {
		kind string
		at   time.Time
	}{{"cancelled", time.Now().UTC()}, {"unknown", time.Now().Add(time.Hour)}, {"unknown", at}} {
		if s.RecordProbeResult("a", "104.16.1.2", "ws", false, tt.kind, 0, 0, tt.at) {
			t.Fatalf("无效时间或取消进入统计：%+v", tt)
		}
	}
}

func TestProfileSchemaValidationAndMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile.json")
	at := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	legacy := `{"profiles":{},"observations":{"a|104.16.1.0/24":{"profileId":"a","prefix":"104.16.1.0/24","sampleCount":10,"tcpAttempts":10,"tcpSuccess":9,"wsSuccess":2,"lastTestAt":"` + at + `"}}}`
	if err := os.WriteFile(path, []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadProfileStore(path); err == nil {
		t.Fatal("无分母的阶段成功不可迁移")
	}
	legacy = `{"profiles":{},"observations":{"a|104.16.1.0/24":{"profileId":"a","prefix":"104.16.1.0/24","sampleCount":10,"tcpAttempts":10,"tcpSuccess":9,"lastTestAt":"` + at + `"}}}`
	if err := os.WriteFile(path, []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := LoadProfileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Observations) != 1 || s.ForProfile("a")[0].Failures["unknown"] != 1 {
		t.Fatal("旧档案未按已知阶段迁移")
	}
	if err = s.Save(path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]interface{}
	if err = json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["version"] != float64(1) {
		t.Fatal("缺少版本字段")
	}
	for _, value := range []string{`null`, `{}`, `{"version":2,"profiles":{},"observations":{}}`, `{"version":1,"profiles":{},"observations":{"a|104.16.1.0/24|tcp":{"profileId":"a","prefix":"104.16.1.0/24","stage":"tcp","attempts":1,"successes":2,"failures":{},"updatedAt":"` + at + `"}}}`} {
		if err = os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err = LoadProfileStore(path); err == nil {
			t.Fatalf("非法档案被接受：%s", value)
		}
	}
}

func TestNetworkProfileIdentity(t *testing.T) {
	a := NewNetworkProfile(NetworkProfile{ISP: " ISP ", Region: " CN ", Access: "WiFi", Confidence: 2})
	b := NewNetworkProfile(NetworkProfile{ISP: "isp", Region: "cn", Access: "wifi", Family: "ipv4", Source: "manual"})
	if a.ID == "" || a.ID != b.ID || a.Confidence != 1 {
		t.Fatalf("档案未规范化：%+v / %+v", a, b)
	}
	b.Access = "cellular"
	if NewNetworkProfile(b).ID == a.ID {
		t.Fatal("不同接入方式不能混用历史")
	}
}

func TestProfileObservationStagesAndIsolation(t *testing.T) {
	s := NewProfileStore()
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.RecordProbe("a", "104.16.1.2", "tcp", true, at)
			s.RecordProbe("a", "104.16.1.3", "tls", false, at)
		}()
	}
	wg.Wait()
	s.RecordProbe("b", "104.16.1.9", "ws", true, at)
	for _, ip := range []string{"host.example", "2001:db8::1", "bad"} {
		if s.RecordProbe("a", ip, "tcp", false, at) {
			t.Fatalf("非法 IPv4 进入桶：%s", ip)
		}
	}
	if s.RecordProbe("a", "104.16.1.1", "invalid", true, at) {
		t.Fatal("未知阶段不应计数")
	}
	observations := s.ForProfile("a")
	if len(observations) != 2 {
		t.Fatalf("桶数错误：%v", observations)
	}
	o := observations[0]
	if o.Prefix != "104.16.1.0/24" || o.Stage != "tcp" || o.Attempts != 20 || o.Successes != 20 || observations[1].Stage != "tls" || observations[1].Failures["unknown"] != 20 {
		t.Fatalf("阶段分母或网络隔离错误：%+v", observations)
	}
	observations[0].Successes = 0
	observations[1].Failures["unknown"] = 0
	if s.ForProfile("a")[0].Successes != 20 || s.ForProfile("a")[1].Failures["unknown"] != 20 {
		t.Fatal("返回值应为副本")
	}
}

func TestProfileStoreRoundTripAndOverwrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "profiles.json")
	s, err := LoadProfileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	p := s.PutProfile(NetworkProfile{ISP: "local", Access: "wired"})
	s.RecordProbe(p.ID, "104.16.1.2", "tcp", true, time.Now().UTC())
	if err = s.Save(path); err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(path, 0666); err != nil {
		t.Fatal(err)
	}
	if err = s.Save(path); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadProfileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(s.ForProfile(p.ID), loaded.ForProfile(p.ID)) {
		t.Fatal("统计保存后发生变化")
	}
	if loaded.Profiles[p.ID] != p {
		t.Fatal("档案未持久化")
	}
	if err = os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = LoadProfileStore(path); err == nil {
		t.Fatal("损坏 JSON 应返回错误")
	}
}
