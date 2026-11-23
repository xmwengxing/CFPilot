package kernel

// 「内核有没有更新」的判定口径测试。
//
// ## 守护什么
//
// 真机缺陷（2026-11-23 用户反馈）：内核更新完之后提示**反复出现**，
// 点一次、再点一次都还跳。
//
// 原因是各处判定的参照物错了：拿「通道序号」去比「本程序内置的锚点」。
// 内置锚点只在应用升级时变化，而「更新内核」更新的是**线上部署** ——
// 于是无论部署多少次，结论永远是「有更新」。
//
// 现在的口径：**线上已部署的 build** vs 「现在部署会用的那份」
// （kernel.ResolveTarget.Build）。两边一致就是没有更新。

import (
	"context"
	"fmt"
	"testing"
)

// 通道比内置新：目标内核 = 通道内核；线上已是通道内核 → 不再提示有更新。
func TestResolveTargetPrefersChannelAndSettles(t *testing.T) {
	useLocalKernel(t)
	useLocalKernelVersion(t, 202611210000, "aaa1111-bbbb2222")
	channelAssets(t,
		fmt.Sprintf(`{"seq": 202611220000, "build": %q, "minToolVersion": ""}`, "ccc3333-dddd4444"),
		map[string][]byte{ControlAssetName: []byte("x"), DataAssetName: []byte("y")})

	target := ResolveTarget(context.Background(), "0.60.0")
	if !target.FromChannel {
		t.Fatal("通道比内置新时应使用通道内核")
	}
	if target.Build != "ccc3333-dddd4444" {
		t.Errorf("目标 build 应是通道的，实际 %q", target.Build)
	}
	if target.Version != "k202611220000" {
		t.Errorf("展示版本应是 k<序号>，实际 %q", target.Version)
	}

	// 核心断言：线上已经是通道内核 → 没有更新（提示必须消掉）
	if target.HasUpdateAgainstDeployed("ccc3333-dddd4444") {
		t.Error("线上已是目标内核时不该再提示有更新（否则更新完还会跳）")
	}
	// 线上还是旧内核 → 有更新
	if !target.HasUpdateAgainstDeployed("aaa1111-bbbb2222") {
		t.Error("线上仍是旧内核时应提示有更新")
	}
	// 线上版本读不到 → 提示一次，让用户去部署页确认
	if !target.HasUpdateAgainstDeployed("") {
		t.Error("线上版本未知时应提示（去部署页确认），实际没有")
	}
}

// 通道不比内置新：目标内核 = 内置内核（避免把线上降级）。
func TestResolveTargetUsesBuiltinWhenChannelOlder(t *testing.T) {
	useLocalKernel(t)
	useLocalKernelVersion(t, 202611230000, "aaa1111-bbbb2222")
	channelAssets(t,
		fmt.Sprintf(`{"seq": 202611210000, "build": %q, "minToolVersion": ""}`, "ccc3333-dddd4444"),
		map[string][]byte{ControlAssetName: []byte("x"), DataAssetName: []byte("y")})

	target := ResolveTarget(context.Background(), "0.60.0")
	if target.FromChannel {
		t.Error("通道不比内置新时不该用通道内核")
	}
	if target.Build != "aaa1111-bbbb2222" {
		t.Errorf("目标 build 应是内置的，实际 %q", target.Build)
	}
	if target.HasUpdateAgainstDeployed("aaa1111-bbbb2222") {
		t.Error("线上 == 内置时不该提示有更新")
	}
}

// 通道不可用（离线 / 未发布）：退回内置内核，且不报错。
func TestResolveTargetFallsBackToBuiltin(t *testing.T) {
	useLocalKernel(t)
	useLocalKernelVersion(t, 202611230000, "aaa1111-bbbb2222")
	channelAssets(t, "", map[string][]byte{})

	target := ResolveTarget(context.Background(), "0.60.0")
	if target.Info != nil {
		t.Error("通道不可用时 Info 应为 nil（调用方据此回退包 Release 通道）")
	}
	if target.Build != "aaa1111-bbbb2222" {
		t.Errorf("应退回内置 build，实际 %q", target.Build)
	}
	if target.HasUpdateAgainstDeployed("aaa1111-bbbb2222") {
		t.Error("线上 == 内置时不该提示有更新")
	}
}

// 兼容护栏：通道要求更高的工具版本 → 不提示升级内核（先升级工具）。
func TestResolveTargetBlockedByMinToolVersion(t *testing.T) {
	useLocalKernel(t)
	useLocalKernelVersion(t, 202611210000, "aaa1111-bbbb2222")
	channelAssets(t,
		fmt.Sprintf(`{"seq": 202611220000, "build": %q, "minToolVersion": "0.70.0"}`, "ccc3333-dddd4444"),
		map[string][]byte{ControlAssetName: []byte("x"), DataAssetName: []byte("y")})

	target := ResolveTarget(context.Background(), "0.60.0")
	if !target.Blocked {
		t.Fatal("工具版本低于 minToolVersion 时应标记 Blocked")
	}
	if target.HasUpdateAgainstDeployed("aaa1111-bbbb2222") {
		t.Error("被兼容护栏挡住时不该催用户升级内核")
	}
}
