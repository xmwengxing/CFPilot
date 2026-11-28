package mesh

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeNATPMP 起一个只回一次的假网关，返回收到的请求字节。
func fakeNATPMP(t *testing.T, respond func(req []byte) []byte) *natpmpClient {
	t.Helper()
	pc, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	got := make(chan []byte, 4)
	go func() {
		buf := make([]byte, 64)
		for {
			n, addr, err := pc.ReadFromUDP(buf)
			if err != nil {
				return
			}
			req := append([]byte(nil), buf[:n]...)
			got <- req
			if resp := respond(req); resp != nil {
				_, _ = pc.WriteToUDP(resp, addr)
			}
		}
	}()
	c := &natpmpClient{server: pc.LocalAddr().String(), timeout: 500 * time.Millisecond}
	t.Cleanup(func() {
		select {
		case req := <-got:
			t.Logf("请求: % x", req)
		case <-time.After(10 * time.Millisecond):
		}
	})
	return c
}

// TestNATPMPMapRequestBytes 锁死请求字节：版本/操作码/端口/寿命任何一个错，
// 路由器都只是静默不回，现场只能靠这里发现。
func TestNATPMPMapRequestBytes(t *testing.T) {
	var seen []byte
	c := fakeNATPMP(t, func(req []byte) []byte {
		if len(req) == 2 {
			// Map 成功后会补发一次 GetExternalAddress（NAT-PMP 的 MAP 响应不含 IP）。
			resp := make([]byte, 12)
			resp[0], resp[1] = 0, 128
			copy(resp[8:12], []byte{203, 0, 113, 7})
			return resp
		}
		seen = append([]byte(nil), req...)
		resp := make([]byte, 16)
		resp[0], resp[1] = 0, 128
		binary.BigEndian.PutUint16(resp[8:10], 51820)  // 内部端口
		binary.BigEndian.PutUint16(resp[10:12], 51000) // 外部端口
		binary.BigEndian.PutUint32(resp[12:16], 3600)
		return resp
	})
	m, err := c.Map(context.Background(), portMapRequest{
		InternalIP: net.IPv4(192, 168, 1, 5), InternalPort: 51820, Lifetime: time.Hour,
	})
	if err != nil {
		t.Fatalf("映射失败: %v", err)
	}
	if m.ExternalPort != 51000 || m.Lifetime != time.Hour {
		t.Fatalf("映射结果不符: %+v", m)
	}
	if m.Protocol != "nat-pmp" || m.InternalPort != 51820 {
		t.Fatalf("映射元信息不符: %+v", m)
	}
	want := []byte{0, 0, 0, 0, 0xca, 0x6c, 0xca, 0x6c, 0x00, 0x00, 0x0e, 0x10}
	if !equalBytes(seen, want) {
		t.Fatalf("请求字节不符:\n got=% x\nwant=% x", seen, want)
	}
}

func TestNATPMPGatewayProbeAndRejection(t *testing.T) {
	// opcode 0：GetExternalAddress，响应 12 字节。
	c := fakeNATPMP(t, func([]byte) []byte {
		resp := make([]byte, 12)
		resp[0], resp[1] = 0, 128
		copy(resp[8:12], []byte{203, 0, 113, 7})
		return resp
	})
	ip, err := c.externalAddress(context.Background())
	if err != nil || !ip.Equal(net.IPv4(203, 0, 113, 7)) {
		t.Fatalf("外部地址探测失败: ip=%v err=%v", ip, err)
	}

	// 结果码 2（未授权）必须报错，不能当成映射成功。
	c2 := fakeNATPMP(t, func([]byte) []byte {
		resp := make([]byte, 16)
		resp[0], resp[1] = 0, 128
		binary.BigEndian.PutUint16(resp[2:4], 2)
		return resp
	})
	if _, err := c2.Map(context.Background(), portMapRequest{InternalPort: 51820, Lifetime: time.Hour}); err == nil {
		t.Fatal("结果码 2 应被当成失败")
	} else if !strings.Contains(err.Error(), "未授权") {
		t.Fatalf("错误信息应含原因: %v", err)
	}
}

func TestPCPMapAndNonceCheck(t *testing.T) {
	pc, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	var req []byte
	go func() {
		buf := make([]byte, 128)
		n, addr, err := pc.ReadFromUDP(buf)
		if err != nil {
			return
		}
		req = append([]byte(nil), buf[:n]...)
		resp := make([]byte, 60)
		resp[0], resp[1] = pcpVersion, 0x80|pcpOpMap
		binary.BigEndian.PutUint32(resp[4:8], 1800)
		copy(resp[24:36], req[24:36]) // nonce 必须原样回显
		binary.BigEndian.PutUint16(resp[40:42], binary.BigEndian.Uint16(req[40:42]))
		binary.BigEndian.PutUint16(resp[42:44], 40000)
		copy(resp[44:60], ipv4Mapped(net.IPv4(203, 0, 113, 8)))
		_, _ = pc.WriteToUDP(resp, addr)
	}()
	c := &pcpClient{server: pc.LocalAddr().String(), timeout: 500 * time.Millisecond}
	m, err := c.Map(context.Background(), portMapRequest{
		InternalIP: net.IPv4(192, 168, 1, 5), InternalPort: 51820, Lifetime: time.Hour,
	})
	if err != nil {
		t.Fatalf("PCP 映射失败: %v", err)
	}
	if m.ExternalPort != 40000 || m.Lifetime != 30*time.Minute {
		t.Fatalf("PCP 映射结果不符: %+v", m)
	}
	if !m.ExternalIP.Equal(net.IPv4(203, 0, 113, 8)) {
		t.Fatalf("PCP 外部地址不符: %v", m.ExternalIP)
	}
	// 请求布局核对：版本 2、MAP、UDP、内部端口。
	if req[0] != 2 || req[1] != 1 || req[36] != 17 {
		t.Fatalf("PCP 请求头不符: % x", req[:40])
	}
	if binary.BigEndian.Uint16(req[40:42]) != 51820 || len(req) != 60 {
		t.Fatalf("PCP 请求长度/端口不符: len=%d", len(req))
	}
}

func TestUPnPDescriptionAndPermanentLeaseFallback(t *testing.T) {
	var addCalls int
	var leases []string
	mux := http.NewServeMux()
	mux.HandleFunc("/desc.xml", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device>
<deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
<serviceList><service>
<serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
<controlURL>ctl</controlURL>
</service></serviceList></device></root>`)
	})
	mux.HandleFunc("/ctl", func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		body := strings.NewReader(string(raw))
		_ = body
		soap := r.Header.Get("SOAPACTION")
		switch {
		case strings.Contains(soap, "AddPortMapping"):
			addCalls++
			lease := between(string(raw), "<NewLeaseDuration>", "</NewLeaseDuration>")
			leases = append(leases, lease)
			if lease != "0" {
				w.WriteHeader(http.StatusInternalServerError)
				fmt.Fprint(w, `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>725</errorCode><errorDescription>OnlyPermanentLeasesSupported</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`)
				return
			}
			fmt.Fprint(w, `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:AddPortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/></s:Body></s:Envelope>`)
		case strings.Contains(soap, "GetExternalIPAddress"):
			fmt.Fprint(w, `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetExternalIPAddressResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"><NewExternalIPAddress>203.0.113.9</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>`)
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c, err := newUPnPClientFromDescription(context.Background(), srv.URL+"/desc.xml", srv.Client())
	if err != nil {
		t.Fatalf("解析描述失败: %v", err)
	}
	if c.controlURL != srv.URL+"/ctl" {
		t.Fatalf("controlURL 解析不符: %s", c.controlURL)
	}
	if c.gateway() != strings.TrimPrefix(srv.URL, "http://") {
		t.Fatalf("网关字段不符: %s", c.gateway())
	}
	m, err := c.Map(context.Background(), portMapRequest{
		InternalIP: net.IPv4(192, 168, 1, 5), InternalPort: 51820, Lifetime: time.Hour,
	})
	if err != nil {
		t.Fatalf("UPnP 映射失败: %v", err)
	}
	if addCalls != 2 || len(leases) != 2 || leases[0] != "3600" || leases[1] != "0" {
		t.Fatalf("应先有限租约、被 725 拒后改永久: calls=%d leases=%v", addCalls, leases)
	}
	if m.ExternalPort != 51820 || !m.ExternalIP.Equal(net.IPv4(203, 0, 113, 9)) {
		t.Fatalf("映射结果不符: %+v", m)
	}
	if m.Lifetime != upnpPermanentRenew {
		t.Fatalf("永久租约应按 24h 续约，实际 %s", m.Lifetime)
	}
}

// TestPortMapManagerStartStop 保证后台循环能起、能停，且 Stop 不等待续约定时器。
func TestPortMapManagerStartStop(t *testing.T) {
	m := &fakeMapper{proto: "nat-pmp", lifetime: time.Hour}
	pm := newPortMapManager(portMapConfig{
		InternalPort: 51820,
		build: func(ctx context.Context) []portMapClient {
			return []portMapClient{m}
		},
	})
	pm.Start()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && pm.Status().Protocol == "" {
		time.Sleep(5 * time.Millisecond)
	}
	done := make(chan struct{})
	go func() { pm.Stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Stop 超时（续约定时器没被 stop 唤醒）")
	}
	if m.calls != 1 {
		t.Fatalf("首次应只映射一次，实际 %d", m.calls)
	}
	if st := pm.Status(); st.Protocol != "nat-pmp" || st.Successes != 1 || st.InternalPort != 51820 {
		t.Fatalf("状态不符: %+v", st)
	}
}

// fakeMapper 直接实现 portMapClient，测管理器的调度与计数。
type fakeMapper struct {
	proto    string
	err      error
	calls    int
	lifetime time.Duration
}

func (f *fakeMapper) protocol() string { return f.proto }

func (f *fakeMapper) Map(ctx context.Context, req portMapRequest) (*portMapping, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return &portMapping{
		Protocol: f.proto, Gateway: "127.0.0.1:5351",
		ExternalIP:   net.IPv4(203, 0, 113, 10),
		ExternalPort: req.InternalPort, InternalPort: req.InternalPort,
		Lifetime: f.lifetime,
	}, nil
}

func TestPortMapManagerFallsBackAndCounts(t *testing.T) {
	bad := &fakeMapper{proto: "pcp", err: fmt.Errorf("未授权")}
	good := &fakeMapper{proto: "nat-pmp", lifetime: 2 * time.Hour}
	pm := newPortMapManager(portMapConfig{
		InternalPort: 51820,
		InternalIP:   net.IPv4(192, 168, 1, 5),
		build: func(ctx context.Context) []portMapClient {
			return []portMapClient{bad, good}
		},
	})
	pm.refresh(context.Background())
	st := pm.Status()
	if !st.Enabled || st.Protocol != "nat-pmp" || st.ExternalPort != 51820 || st.Successes != 1 {
		t.Fatalf("应回退到 nat-pmp: %+v", st)
	}
	if bad.calls != 1 || good.calls != 1 {
		t.Fatalf("调用次数不符: bad=%d good=%d", bad.calls, good.calls)
	}
	if st.ExpiresAt == "" || st.LifetimeSec != int((2*time.Hour).Seconds()) {
		t.Fatalf("续约信息不符: %+v", st)
	}
	if d := pm.nextDelay(); d != 90*time.Minute {
		t.Fatalf("续约间隔应为 90min，实际 %s", d)
	}

	failing := newPortMapManager(portMapConfig{
		InternalPort: 51820,
		build: func(ctx context.Context) []portMapClient {
			return []portMapClient{bad}
		},
	})
	failing.refresh(context.Background())
	st = failing.Status()
	if st.Failures != 1 || st.LastError == "" || st.Protocol != "" {
		t.Fatalf("失败计数不符: %+v", st)
	}
	if d := failing.nextDelay(); d != portMapRetryMin {
		t.Fatalf("首次失败退避应为 %s，实际 %s", portMapRetryMin, d)
	}
}

func between(s, pre, post string) string {
	i := strings.Index(s, pre)
	if i < 0 {
		return ""
	}
	i += len(pre)
	j := strings.Index(s[i:], post)
	if j < 0 {
		return ""
	}
	return s[i : i+j]
}
