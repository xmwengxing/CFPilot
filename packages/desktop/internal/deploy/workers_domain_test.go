package deploy

// Workers 数据面的域名与 workers.dev 链接开关（真机事故 2026-11-02 的回归测试）。
//
// ## 事故经过
//
// 账号 86577212@qq.com 用 Workers 形态部署。更新部署时，
// 桌面版把**上一个账号**残留的「数据面域名」写进了控制面 DATA_HOST
// → 订阅节点的 sni/host 指向别的域名 → 节点全部 -1。
//
// 同时确认了另一条：数据面绑了自定义域名后，
// workers.dev 的**生产链接与预览链接必须都关掉**，否则节点同样全部 -1。

import (
	"context"
	"strings"
	"testing"
)

// newWorkersDeployer 造一个跑 Workers 数据面部署的部署器。
func newWorkersDeployer(t *testing.T, f *fakeCF, dataHost string) *Deployer {
	t.Helper()
	d, _ := newTestDeployer(t, f, func(o *Options) {
		o.ControlProject = "cpmanager"
		o.DataProject = "aytwi20y"
		o.DataHost = dataHost
		o.DataPlaneMode = "workers"
	})
	return d
}

// 用户填了自定义域名 → 必须关掉 workers.dev 的生产与预览链接。
func TestWorkersDataPlaneClosesWorkersDevWhenCustomDomain(t *testing.T) {
	f := newFakeCF()
	d := newWorkersDeployer(t, f, "data.example.com")
	if _, err := d.deployWorkersDataPlane(context.Background(), "aytwi20y", effective{}); err != nil {
		t.Fatal(err)
	}
	sw, ok := f.subdomainSwitches["aytwi20y"]
	if !ok {
		t.Fatalf("应设置过 workers.dev 开关，实际：%v", f.subdomainSwitches)
	}
	if sw["enabled"] {
		t.Error("绑了自定义域名后，workers.dev 生产链接必须关闭")
	}
	if sw["previews_enabled"] {
		t.Error("绑了自定义域名后，workers.dev 预览链接必须关闭")
	}
}

// 没填域名，但 Worker 已经绑了自定义域名 → 同样关掉，并用绑定的域名当节点域名。
func TestWorkersDataPlaneUsesBoundCustomDomain(t *testing.T) {
	f := newFakeCF()
	f.workerDomains = append(f.workerDomains, struct {
		service  string
		hostname string
	}{"aytwi20y", "bound.example.com"})
	d := newWorkersDeployer(t, f, "")
	host, err := d.deployWorkersDataPlane(context.Background(), "aytwi20y", effective{})
	if err != nil {
		t.Fatal(err)
	}
	if host != "bound.example.com" {
		t.Errorf("节点域名应用已绑定的自定义域名，实际 %q", host)
	}
	sw := f.subdomainSwitches["aytwi20y"]
	if sw == nil || sw["enabled"] || sw["previews_enabled"] {
		t.Errorf("绑了自定义域名后应关掉 workers.dev 链接，实际：%v", sw)
	}
}

// 没有任何自定义域名 → workers.dev 生产链接要开着（否则连入口都没有）。
func TestWorkersDataPlaneKeepsWorkersDevWithoutCustomDomain(t *testing.T) {
	f := newFakeCF()
	d := newWorkersDeployer(t, f, "")
	host, err := d.deployWorkersDataPlane(context.Background(), "aytwi20y", effective{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(host, "workers.dev") {
		t.Errorf("没有自定义域名时应回落到 workers.dev，实际 %q", host)
	}
	sw := f.subdomainSwitches["aytwi20y"]
	if sw == nil || !sw["enabled"] {
		t.Errorf("没有自定义域名时应保持 workers.dev 生产链接开启，实际：%v", sw)
	}
}

// 域名与数据面已绑定的对不上 → 必须拒绝（真机事故的根因）。
//
// 数据面已绑 data.shijingtian.dpdns.org，输入框里却是别的域名
// （切账户残留）→ 写进 DATA_HOST → 节点全部 -1。
func TestWorkersDataPlaneRejectsMismatchedHost(t *testing.T) {
	f := newFakeCF()
	f.workerDomains = append(f.workerDomains, struct {
		service  string
		hostname string
	}{"aytwi20y", "data.shijingtian.dpdns.org"})
	d := newWorkersDeployer(t, f, "cp.dongyao.dpdns.org")
	_, err := d.deployWorkersDataPlane(context.Background(), "aytwi20y", effective{})
	if err == nil {
		t.Fatal("域名与已绑定的域名不一致时必须报错")
	}
	if !strings.Contains(err.Error(), "data.shijingtian.dpdns.org") {
		t.Errorf("错误信息应说明实际绑定的域名，实际：%v", err)
	}
}

// 数据面还没绑过域名 → 放行（首次部署的正常流程：部署完用户自己去绑）。
func TestWorkersDataPlaneAllowsUnboundHost(t *testing.T) {
	f := newFakeCF()
	d := newWorkersDeployer(t, f, "new.example.com")
	host, err := d.deployWorkersDataPlane(context.Background(), "aytwi20y", effective{})
	if err != nil {
		t.Fatalf("数据面还没绑域名时应放行：%v", err)
	}
	if host != "new.example.com" {
		t.Errorf("节点域名应为用户填的值，实际 %q", host)
	}
}
