package scan

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"testing"
)

func TestMeshProbePathFormat(t *testing.T) {
	got := meshProbePath("ABCDEF12", "00112233aabbccdd")
	want := "/mesh/abcdef12?peer_id=00112233aabbccdd"
	if got != want {
		t.Errorf("meshProbePath() = %q, 期望 %q", got, want)
	}
}

func TestRandomPeerID(t *testing.T) {
	re := regexp.MustCompile(`^[0-9a-f]{16}$`)
	seen := make(map[string]bool)
	for i := 0; i < 64; i++ {
		id, err := randomPeerID()
		if err != nil {
			t.Fatal(err)
		}
		if !re.MatchString(id) {
			t.Fatalf("peer_id 形态不对: %q", id)
		}
		if seen[id] {
			t.Fatalf("peer_id 重复: %q（探测必须用一次性标识，否则会踢掉真实节点）", id)
		}
		seen[id] = true
	}
}

func TestNormalizeMeshCandidate(t *testing.T) {
	cases := []struct {
		raw  string
		host string
		port int
		ok   bool
		name string
	}{
		{"104.16.1.1", "104.16.1.1", 443, true, "裸 IPv4"},
		{"104.16.1.1:8443", "104.16.1.1", 8443, true, "IPv4 带端口"},
		{"104.16.1.1:2053", "104.16.1.1", 2053, true, "反代常见端口"},
		{"2606:4700::1", "2606:4700::1", 443, true, "裸 IPv6 字面量"},
		{"[2606:4700::1]:2096", "2606:4700::1", 2096, true, "IPv6 带端口"},
		{"relay.example.com", "relay.example.com", 443, true, "域名"},
		{"  1.2.3.4  ", "1.2.3.4", 443, true, "带空白"},
		{"", "", 0, false, "空串"},
		{"1.2.3.4:0", "", 0, false, "端口 0"},
		{"1.2.3.4:70000", "", 0, false, "端口越界"},
	}
	for _, c := range cases {
		host, port, ok := normalizeMeshCandidate(c.raw, 443)
		if ok != c.ok {
			t.Errorf("%s: ok=%v, 期望 %v", c.name, ok, c.ok)
			continue
		}
		if !ok {
			continue
		}
		if host != c.host || port != c.port {
			t.Errorf("%s: (%q,%d), 期望 (%q,%d)", c.name, host, port, c.host, c.port)
		}
	}
}

func TestRunMeshEntryValidation(t *testing.T) {
	ctx := context.Background()

	if _, err := RunMeshEntry(ctx, MeshEntryOptions{Candidates: []string{"1.2.3.4"}, Room: "abcdef12"}); err == nil {
		t.Error("缺少中继域名应报错")
	}
	if _, err := RunMeshEntry(ctx, MeshEntryOptions{Candidates: []string{"1.2.3.4"}, RelayDomain: "r.example.com", Room: "xyz"}); err == nil {
		t.Error("房间名非 hex 应报错")
	}
	if _, err := RunMeshEntry(ctx, MeshEntryOptions{Candidates: []string{"1.2.3.4"}, RelayDomain: "r.example.com", Room: "abcd123"}); err == nil {
		t.Error("房间名过短应报错")
	}
	if _, err := RunMeshEntry(ctx, MeshEntryOptions{RelayDomain: "r.example.com", Room: "abcdef12"}); err == nil {
		t.Error("无候选应报错")
	}
	// 候选全是垃圾（端口非法）→ 视作无候选
	if _, err := RunMeshEntry(ctx, MeshEntryOptions{
		Candidates: []string{"1.2.3.4:0"}, RelayDomain: "r.example.com", Room: "abcdef12",
	}); err == nil {
		t.Error("候选全部非法应报错")
	}
}

// 真实 TLS + WS 升级：验证探测真的打到 /mesh/<room>?peer_id=<16hex> 并识别 101。
func TestRunMeshEntrySuccess(t *testing.T) {
	pathCh := make(chan string, 8)
	srv := newTLSServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case pathCh <- r.URL.RequestURI():
		default:
		}
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			t.Errorf("缺少 Upgrade 头")
		}
		if r.Host != "relay.example.com" {
			t.Errorf("SNI/Host 应为盲中继域名，实际 %q", r.Host)
		}
		w.Header().Set("Cf-Ray", "8a1b2c3d4e5f-HKG")
		w.Header().Set("Upgrade", "websocket")
		w.Header().Set("Connection", "Upgrade")
		w.WriteHeader(http.StatusSwitchingProtocols)
	}))
	defer srv.stop()

	sum, err := RunMeshEntry(context.Background(), MeshEntryOptions{
		Candidates:  []string{srv.Addr},
		RelayDomain: "relay.example.com",
		Room:        "abcdef12",
		DefaultPort: srv.Port,
		TimeoutMs:   3000,
		Attempts:    2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Results) != 1 {
		t.Fatalf("结果数 = %d, 期望 1", len(sum.Results))
	}
	r := sum.Results[0]
	if !r.OK {
		t.Fatalf("应判定成功，实际 error=%q status=%d", r.Error, r.Status)
	}
	if r.Attempts != 2 || r.Successes != 2 {
		t.Errorf("attempts/successes = %d/%d, 期望 2/2", r.Attempts, r.Successes)
	}
	if r.Colo != "HKG" {
		t.Errorf("colo = %q, 期望 HKG", r.Colo)
	}

	select {
	case p := <-pathCh:
		re := regexp.MustCompile(`^/mesh/abcdef12\?peer_id=[0-9a-f]{16}$`)
		if !re.MatchString(p) {
			t.Errorf("请求路径 = %q, 期望 /mesh/abcdef12?peer_id=<16hex>", p)
		}
	default:
		t.Error("服务端没收到探测请求")
	}
}

// 全部不可达：不应 panic，且失败项排在可用项之后。
func TestRunMeshEntryAllFail(t *testing.T) {
	sum, err := RunMeshEntry(context.Background(), MeshEntryOptions{
		Candidates:  []string{"127.0.0.1"},
		RelayDomain: "relay.example.com",
		Room:        "abcdef12",
		DefaultPort: 1, // 关闭端口，必然失败
		TimeoutMs:   800,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Results) != 1 || sum.Results[0].OK {
		t.Fatalf("应为一个失败结果: %+v", sum.Results)
	}
	if sum.Results[0].Error == "" {
		t.Error("失败项应带错误信息")
	}
	if sum.ElapsedMs < 0 {
		t.Error("耗时不应为负")
	}
}

// 排序：可用且 RTT 低的在前，失败的在后。
func TestMeshEntrySortOrder(t *testing.T) {
	list := []MeshEntryResult{
		{IP: "1.1.1.1", OK: false, Error: "timeout"},
		{IP: "2.2.2.2", OK: true, LatencyMs: 120},
		{IP: "3.3.3.3", OK: true, LatencyMs: 40},
	}
	// 复用生产排序逻辑：直接调用 RunMeshEntry 内部用的比较器不易抽离，
	// 这里用同样的规则断言，防止后续改动破坏排序语义。
	sortMeshResults(list)
	if !list[0].OK || list[0].IP != "3.3.3.3" {
		t.Errorf("第一名应为 RTT 最低的可用项，实际 %+v", list[0])
	}
	if !list[1].OK || list[1].IP != "2.2.2.2" {
		t.Errorf("第二名应为次低可用项，实际 %+v", list[1])
	}
	if list[2].OK || list[2].IP != "1.1.1.1" {
		t.Errorf("失败项应排最后，实际 %+v", list[2])
	}
}

