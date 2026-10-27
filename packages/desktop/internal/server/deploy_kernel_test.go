package server

// 「检查状态」里的内核版本对比字段的测试。
//
// ## 为什么要有这些字段
//
// 内核的 **build 指纹**（`<hash>-<hash>`）精确，但**没有大小顺序** ——
// 「线上 ≠ 本地」只能说明「不一样」，说不清「谁更新」。
//
// 而内核的 **semver**（如 "0.7.6"）自带大小顺序，
// 所以响应里要同时给出三方的版本号，让界面能回答：
//
//	线上 0.7.3 / 本地 0.7.5 / 远程 0.7.6 → 可以更新
//
// ⚠️ 远程查询**必须能失败**（离线时不能让整个检查状态失败）：
// 查不到就返回空串 + kernelUpdatable=false，并给出说明字段。

import (
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/deploy"
)

// 响应里必须有内核版本对比的四个字段 + 说明字段。
func TestDeployStatusHasKernelVersionFields(t *testing.T) {
	m := &deploy.Manifest{
		Build:         "abc1234-deadbeef",
		KernelVersion: "0.7.3",
		At:            "2026-10-28T00:00:00.000Z",
	}
	ks := kernelStatus{
		Deployed: "0.7.3",
		Local:    "0.7.5",
		Remote:   "0.7.6",
	}

	body := buildDeployStatusResponse(m, "outdated", "abc1234-deadbeef", "abc1234-deadbeef", ks)

	for _, key := range []string{
		"kernelVersion",
		"localKernelVersion",
		"remoteKernelVersion",
		"kernelUpdatable",
		"kernelRemoteError",
	} {
		if _, has := body[key]; !has {
			t.Errorf("响应必须包含字段 %s", key)
		}
	}

	if body["kernelVersion"] != "0.7.3" {
		t.Errorf("kernelVersion 应是线上版本 0.7.3，实际 %v", body["kernelVersion"])
	}
	if body["localKernelVersion"] != "0.7.5" {
		t.Errorf("localKernelVersion 应是本地版本 0.7.5，实际 %v", body["localKernelVersion"])
	}
	if body["remoteKernelVersion"] != "0.7.6" {
		t.Errorf("remoteKernelVersion 应是远程版本 0.7.6，实际 %v", body["remoteKernelVersion"])
	}
	if body["kernelUpdatable"] != true {
		t.Errorf("远程比线上新时 kernelUpdatable 应为 true，实际 %v", body["kernelUpdatable"])
	}
	// 契约字段不能被改坏
	if body["build"] != "abc1234-deadbeef" {
		t.Errorf("build 字段必须保留，实际 %v", body["build"])
	}
	if body["at"] != "2026-10-28T00:00:00.000Z" {
		t.Errorf("at 字段必须保留，实际 %v", body["at"])
	}
}

// 旧清单没有 kernelVersion → 线上版本未知（空串）。
func TestDeployStatusLegacyManifestKernelVersion(t *testing.T) {
	m := &deploy.Manifest{Build: "abc1234-deadbeef"}
	ks := kernelStatus{Local: "0.7.5", Remote: "0.7.6"}

	body := buildDeployStatusResponse(m, "outdated", "abc1234-deadbeef", "abc1234-deadbeef", ks)

	if body["kernelVersion"] != "" {
		t.Errorf("旧清单的 kernelVersion 应为空串（版本未知），实际 %v", body["kernelVersion"])
	}
	// 版本未知时仍可提示「有更新」—— 让用户重新部署一次拿到确定版本
	if body["kernelUpdatable"] != true {
		t.Errorf("线上版本未知时应提示可更新，实际 %v", body["kernelUpdatable"])
	}
}

// 远程查询失败时不能影响其它字段，也不能谎报「可更新」。
func TestDeployStatusRemoteUnavailable(t *testing.T) {
	m := &deploy.Manifest{KernelVersion: "0.7.6"}
	ks := kernelStatus{
		Deployed:  "0.7.6",
		Local:     "0.7.6",
		RemoteErr: "无法连接 GitHub",
	}

	body := buildDeployStatusResponse(m, "latest", "b", "b", ks)

	if body["remoteKernelVersion"] != "" {
		t.Errorf("查不到远程版本时应为空串，实际 %v", body["remoteKernelVersion"])
	}
	if body["kernelUpdatable"] != false {
		t.Errorf("查不到远程版本时不该判定可更新，实际 %v", body["kernelUpdatable"])
	}
	if body["kernelRemoteError"] != "无法连接 GitHub" {
		t.Errorf("应给出远程查询失败的原因，实际 %v", body["kernelRemoteError"])
	}
}

// Updatable 的判定规则。
func TestKernelStatusUpdatable(t *testing.T) {
	cases := []struct {
		name             string
		remote, deployed string
		want             bool
	}{
		{"远程更新", "0.7.6", "0.7.3", true},
		{"远程同版本", "0.7.6", "0.7.6", false},
		{"远程更旧", "0.7.3", "0.7.6", false},
		{"远程查不到", "", "0.7.3", false},
		{"线上版本未知", "0.7.6", "", true},
		{"两边都空", "", "", false},
	}
	for _, tc := range cases {
		ks := kernelStatus{Remote: tc.remote, Deployed: tc.deployed}
		if got := ks.Updatable(); got != tc.want {
			t.Errorf("%s：Updatable() = %v，期望 %v", tc.name, got, tc.want)
		}
	}
}
