package scan

import (
	"context"
	"strings"
	"testing"
)

func TestBuiltinMeshEntrySourcesUsable(t *testing.T) {
	list := BuiltinMeshEntrySources()
	if len(list) < 4 {
		t.Fatalf("内置组网候选源过少：%d", len(list))
	}
	seenID := map[string]bool{}
	for _, s := range list {
		if s.ID == "" || s.Name == "" || s.URL == "" {
			t.Errorf("条目字段不全：%+v", s)
		}
		if seenID[s.ID] {
			t.Errorf("重复 id：%s", s.ID)
		}
		seenID[s.ID] = true
		if !strings.HasPrefix(s.URL, "https://") {
			t.Errorf("%s 不是 HTTPS：%s", s.ID, s.URL)
		}
		if _, err := ValidateSourceURL(s.URL, false); err != nil {
			t.Errorf("%s URL 未通过校验：%v", s.ID, err)
		}
	}
}

// 返回副本：调用方修改不应污染内置清单。
func TestBuiltinMeshEntrySourcesIsCopy(t *testing.T) {
	a := BuiltinMeshEntrySources()
	a[0].Name = "tampered"
	b := BuiltinMeshEntrySources()
	if b[0].Name == "tampered" {
		t.Error("应返回副本，避免调用方改写内置清单")
	}
}

func TestFetchMeshEntryCandidatesRejectsBadURL(t *testing.T) {
	ctx := context.Background()
	for _, u := range []string{
		"http://example.com/list.txt",  // 非 HTTPS
		"https://127.0.0.1/list.txt",   // 回环
		"https://192.168.1.1/list.txt", // 内网
		"https://localhost/list.txt",   // 本机名
		"not-a-url",
	} {
		if _, err := FetchMeshEntryCandidates(ctx, u, 0, 10); err == nil {
			t.Errorf("%q 应被拒绝", u)
		}
	}
}

// 解析口径：带 #备注 与端口的行要保留端口（反代入口几乎都不是 443）。
func TestParseSourcePayloadKeepsPortForMesh(t *testing.T) {
	text := strings.Join([]string{
		"146.56.223.6:8443#天诚优选1 | 港岛茶记 | HK",
		"162.159.198.1:443#天诚优选1 HK版",
		"82.27.11.135:8443",
		"104.16.1.1",
		"",
		"# 纯注释行",
	}, "\n")
	parsed := ParseSourcePayload(text)
	got := map[string]int{}
	for _, c := range parsed {
		if c.Port != nil {
			got[c.IP] = *c.Port
		} else {
			got[c.IP] = 0
		}
	}
	if got["146.56.223.6"] != 8443 {
		t.Errorf("146.56.223.6 端口 = %d, 期望 8443", got["146.56.223.6"])
	}
	if got["162.159.198.1"] != 443 {
		t.Errorf("162.159.198.1 端口 = %d, 期望 443", got["162.159.198.1"])
	}
	if p, ok := got["104.16.1.1"]; !ok || p != 0 {
		t.Errorf("裸 IP 不应带端口，实际 %d", p)
	}
}
