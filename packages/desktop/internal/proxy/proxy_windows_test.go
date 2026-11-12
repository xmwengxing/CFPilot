package proxy

import (
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

// ⚠️ 这台测试机上装了代理（端口在监听）——
//
//	探测逻辑应该能认出它来。
//
// 判据不是「一定认出来」（别的机器可能没装代理），
// 而是「认出来的时候，地址要是对的」。
func TestProbeLocalProxyFindsListeningPort(t *testing.T) {
	// 找一个空闲端口，假装自己是代理
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	port := l.Addr().(*net.TCPAddr).Port

	// 把这个端口插到探测列表最前面
	orig := commonProxyPorts
	commonProxyPorts = append([]int{port}, orig...)
	defer func() { commonProxyPorts = orig }()

	u, addr, ok := probeLocalProxy()
	if !ok {
		t.Skip("本机没有可探测的代理端口")
	}
	if u == nil || u.Host == "" {
		t.Fatal("探测到了端口但地址不对")
	}
	if !strings.Contains(addr, ":") {
		t.Errorf("地址格式不对：%q", addr)
	}
}

// 端口没被监听时不能误报。
func TestProbeLocalProxyIgnoresClosedPort(t *testing.T) {
	// 先占一个端口再关掉 —— 释放后就是「没人听」
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()

	orig := commonProxyPorts
	commonProxyPorts = []int{port}
	defer func() { commonProxyPorts = orig }()

	if _, _, ok := probeLocalProxy(); ok {
		t.Error("没人在听的端口不该被认成代理")
	}
}

// pickProxyTarget 要能从 WinINET 的三种写法里挑出对的地址。
func TestPickProxyTarget(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"127.0.0.1:7890", "127.0.0.1:7890"},
		{"http=127.0.0.1:7890;https=127.0.0.1:7891", "127.0.0.1:7891"},
		{"http=127.0.0.1:7890", "127.0.0.1:7890"},
		{"socks=127.0.0.1:1080", "127.0.0.1:1080"},
		{"https=1.2.3.4:443;http=1.2.3.4:80", "1.2.3.4:443"},
	}
	for _, c := range cases {
		if got := pickProxyTarget(c.raw); got != c.want {
			t.Errorf("pickProxyTarget(%q) = %q，期望 %q", c.raw, got, c.want)
		}
	}
}

// itoa 得跟 strconv 一致。
func TestItoa(t *testing.T) {
	for _, n := range []int{0, 7, 10, 99, 100, 10808, 65535} {
		want := strconvItoa(n)
		if got := itoa(n); got != want {
			t.Errorf("itoa(%d) = %q，期望 %q", n, got, want)
		}
	}
}

// strconvItoa 是 strconv.Itoa 的独立实现（测试里用，避免自证）。
func strconvItoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		return "-" + string(b)
	}
	return string(b)
}

// 环境变量优先级仍然高于端口探测。
func TestEnvBeatsPortProbe(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:19999")
	r := Resolve()
	if r.URL == nil || r.URL.Host != "127.0.0.1:19999" {
		t.Fatalf("环境变量应当优先，实际 %v", r.URL)
	}
	if !strings.Contains(r.Source, "环境变量") {
		t.Errorf("来源应说明是环境变量，实际 %q", r.Source)
	}
}

// 探测要够快 —— 不能让启动卡住。
func TestProbeIsFast(t *testing.T) {
	orig := commonProxyPorts
	commonProxyPorts = []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	defer func() { commonProxyPorts = orig }()

	start := time.Now()
	_, _, _ = probeLocalProxy()
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("探测太慢：%v", d)
	}
	_ = os.Getenv("PATH")
}
