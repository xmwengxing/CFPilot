package scan

// Phase 4 回归：本地池分层取样与完整优选结果回写。
// 与 packages/cli/test/pool-sample.test.ts 同语义。

import (
	"fmt"
	"testing"
)

func sampleCandidate(ip string, patch func(*ExternalCandidate)) ExternalCandidate {
	version := 4
	key := ip + ":443"
	if containsColon(ip) {
		version = 6
		key = "[" + ip + "]:443"
	}
	c := ExternalCandidate{
		Key: key, IP: ip, Port: 443, IPVersion: version,
		CandidateType: EntryIP, Sources: []string{"src"},
		FirstSeen: sourcesNow, LastSeen: sourcesNow,
		Status: StatusPending,
	}
	if patch != nil {
		patch(&c)
	}
	return c
}

func containsColon(s string) bool {
	for i := range s {
		if s[i] == ':' {
			return true
		}
	}
	return false
}

func TestSampleNetworkBucket(t *testing.T) {
	cases := map[string]string{
		"104.16.0.1":         "104.16.0",
		"104.16.9.9":         "104.16.9",
		"2606:4700:3035::1":  "2606:4700:3035",
		"2606:4700:3036::99": "2606:4700:3036",
	}
	for ip, want := range cases {
		if got := NetworkBucket(ip); got != want {
			t.Errorf("NetworkBucket(%q) = %q，期望 %q", ip, got, want)
		}
	}
}

func TestSampleFromPoolSpreadsAcrossBuckets(t *testing.T) {
	pool := EmptyPool()
	for i := 1; i <= 20; i++ {
		pool.Candidates = append(pool.Candidates, sampleCandidate(fmt.Sprintf("104.16.0.%d", i), nil))
	}
	for i := 1; i <= 3; i++ {
		pool.Candidates = append(pool.Candidates, sampleCandidate(fmt.Sprintf("104.17.%d.1", i), nil))
	}
	s := SampleFromPool(pool, 8, 443)
	if len(s.Candidates) != 8 || s.TotalEligible != 23 {
		t.Fatalf("取样数不对：%+v", s)
	}
	foundOther := false
	for _, ip := range s.Candidates {
		if len(ip) >= 7 && ip[:7] == "104.17." {
			foundOther = true
		}
	}
	if !foundOther {
		t.Fatalf("同一 /24 吃掉了全部预算：%v", s.Candidates)
	}
}

func TestSampleFromPoolFamilyQuota(t *testing.T) {
	pool := EmptyPool()
	for i := 1; i <= 10; i++ {
		pool.Candidates = append(pool.Candidates, sampleCandidate(fmt.Sprintf("104.16.0.%d", i), nil))
	}
	pool.Candidates = append(pool.Candidates,
		sampleCandidate("2606:4700::1", nil), sampleCandidate("2606:4700::2", nil))
	s := SampleFromPool(pool, 6, 443)
	if s.V6 != 2 || s.V4 != 4 {
		t.Fatalf("族配额不对：v4=%d v6=%d（一族不足应把预算让给另一族）", s.V4, s.V6)
	}
}

func TestSampleFromPoolExcludes(t *testing.T) {
	tlsMs := int64(10)
	pool := EmptyPool()
	pool.Candidates = append(pool.Candidates,
		sampleCandidate("104.16.0.1", nil),
		sampleCandidate("104.16.0.2", func(c *ExternalCandidate) { c.Status = StatusDisabled }),
		sampleCandidate("104.16.0.3", func(c *ExternalCandidate) { c.Status = StatusExpired }),
		sampleCandidate("104.16.0.4", func(c *ExternalCandidate) {
			c.LightCheck = &LightCheck{TCPOk: true, TLSOk: false, TLSMs: &tlsMs, At: sourcesNow}
		}),
		sampleCandidate("104.16.0.5", func(c *ExternalCandidate) {
			c.Port = 8443
			c.Key = "104.16.0.5:8443"
		}),
	)
	s := SampleFromPool(pool, 10, 443)
	if len(s.Candidates) != 1 || s.Candidates[0] != "104.16.0.1" {
		t.Fatalf("过滤规则不对：%+v", s)
	}
	if s.TotalEligible != 1 {
		t.Fatalf("可取样计数不对：%d", s.TotalEligible)
	}
	if got := SampleFromPool(pool, 10, 8443); len(got.Candidates) != 1 {
		t.Fatalf("按端口 8443 应取到 1 条：%+v", got)
	}
}

func TestSampleFromPoolLimit(t *testing.T) {
	pool := EmptyPool()
	for i := 0; i < 500; i++ {
		pool.Candidates = append(pool.Candidates,
			sampleCandidate(fmt.Sprintf("104.16.%d.%d", i/250, i%250+1), nil))
	}
	if got := SampleFromPool(pool, 0, 443); len(got.Candidates) != PoolSampleLimit {
		t.Fatalf("默认上限应为 %d，实际 %d", PoolSampleLimit, len(got.Candidates))
	}
}

func TestApplyFullTestResults(t *testing.T) {
	sourcesTestDir(t)
	keys := []string{
		"104.16.0.1:443", "104.16.0.2:443", "104.16.0.3:443", "104.16.0.4:443",
	}
	if err := WithPool(func(pool *ExternalPool) error {
		for _, ip := range []string{"104.16.0.1", "104.16.0.2", "104.16.0.3", "104.16.0.4"} {
			pool.Candidates = append(pool.Candidates, sampleCandidate(ip, nil))
		}
		pool.Candidates[3].Status = StatusDisabled
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	summary := &Summary{Entries: []Entry{
		{IP: "104.16.0.1", Port: 443, Colo: "LAX", PeakSpeed: 12.5, Speed: 10},
		{IP: "104.16.0.2", Port: 443, Colo: "AMS", Speed: 8.2},
	}}
	active, failed, err := ApplyFullTestResults(keys, 443, summary, sourcesNow+1)
	if err != nil {
		t.Fatal(err)
	}
	if active != 2 || failed != 1 {
		t.Fatalf("回写计数不对：active=%d failed=%d", active, failed)
	}
	pool := ParsePool(ReadPoolRaw())
	byKey := map[string]*ExternalCandidate{}
	for i := range pool.Candidates {
		byKey[pool.Candidates[i].Key] = &pool.Candidates[i]
	}
	one := byKey["104.16.0.1:443"]
	if one.Status != StatusActive || one.SuccessCount != 1 || one.FullTest == nil {
		t.Fatalf("top1 应置 active：%+v", one)
	}
	if one.FullTest.SpeedMBps == nil || *one.FullTest.SpeedMBps != 12.5 || one.FullTest.Colo == nil || *one.FullTest.Colo != "LAX" {
		t.Fatalf("fullTest 内容不对：%+v", one.FullTest)
	}
	if got := *byKey["104.16.0.2:443"].FullTest.SpeedMBps; got != 8.2 {
		t.Fatalf("PeakSpeed 为 0 时应回落 Speed：%v", got)
	}
	if byKey["104.16.0.3:443"].Status != StatusFailed || byKey["104.16.0.3:443"].FailCount != 1 {
		t.Fatalf("未进 top N 应置 failed：%+v", byKey["104.16.0.3:443"])
	}
	if byKey["104.16.0.4:443"].Status != StatusDisabled {
		t.Fatal("用户禁用的候选不该被结果回写覆盖")
	}
}
