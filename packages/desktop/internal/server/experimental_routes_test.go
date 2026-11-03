package server

// 实验性功能开关与自适应采样的测试。
//
// 重点验证：
//   - 默认全部关闭（读取到的开关是关闭状态）
//   - 保存后能读回，且非法取值被纠正（探索比例、运营商、接入类型）
//   - 开关关闭时，候选生成与历史行为完全不变（不启用网络档案）

import (
	"net/http"
	"strings"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

// loadProfileStoreForTest 读取档案库（测试辅助）。
func loadProfileStoreForTest(path string) (*scan.ProfileStore, error) {
	return scan.LoadProfileStore(path)
}

func TestExperimentalDefaultsOff(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := getJSON(t, base+"/api/experimental", cookie)
	if code != http.StatusOK {
		t.Fatalf("应 200，实际 %d", code)
	}
	exp, ok := body["experimental"].(map[string]any)
	if !ok {
		t.Fatalf("experimental 应为对象，实际 %T", body["experimental"])
	}
	if exp["adaptiveSampling"] != false {
		t.Errorf("自适应采样默认必须关闭，实际 %v", exp["adaptiveSampling"])
	}
	ratio, _ := exp["exploreRatio"].(float64)
	if ratio <= 0 || ratio > 1 {
		t.Errorf("探索比例默认值不合理：%v", ratio)
	}
}

func TestExperimentalSaveAndNormalize(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	code, body := postJSON(t, base+"/api/experimental", cookie, map[string]any{
		"adaptiveSampling": true,
		"exploreRatio":     0.35,
		"isp":              "CT",
		"region":           " 福建 ",
		"access":           "fixed",
	})
	if code != http.StatusOK || body["ok"] != true {
		t.Fatalf("保存应成功：%d %v", code, body)
	}
	exp := body["experimental"].(map[string]any)
	if exp["adaptiveSampling"] != true {
		t.Errorf("自适应采样应已开启，实际 %v", exp["adaptiveSampling"])
	}
	if exp["isp"] != "ct" {
		t.Errorf("运营商应规范化为小写枚举，实际 %v", exp["isp"])
	}
	if exp["region"] != "福建" {
		t.Errorf("地区应去掉首尾空白，实际 %q", exp["region"])
	}

	// 非法取值必须被纠正，而不是被存进去。
	_, body = postJSON(t, base+"/api/experimental", cookie, map[string]any{
		"adaptiveSampling": true,
		"exploreRatio":     9,
		"isp":              "不存在的运营商",
		"access":           "卫星",
	})
	exp = body["experimental"].(map[string]any)
	ratio, _ := exp["exploreRatio"].(float64)
	if ratio <= 0 || ratio > 1 {
		t.Errorf("非法探索比例应被纠正，实际 %v", ratio)
	}
	if exp["isp"] != "other" {
		t.Errorf("未知运营商应回落到 other，实际 %v", exp["isp"])
	}
	if exp["access"] != "fixed" {
		t.Errorf("未知接入类型应回落到 fixed，实际 %v", exp["access"])
	}
}

// 开关关闭时不得启用网络档案：候选生成与历史写入都不带档案 ID。
func TestAdaptiveSamplingDisabledByDefault(t *testing.T) {
	s, _ := newTestServer(t)
	s.SetStore(newEmptyStore(t))

	ctx := s.prepareAdaptive()
	if ctx.enabled {
		t.Fatal("默认不得启用自适应采样")
	}
	if ctx.profileID != "" {
		t.Errorf("未启用时不应有档案 ID，实际 %q", ctx.profileID)
	}
	if s.observer(ctx) != nil {
		t.Error("未启用时不应有观察回调")
	}
	// 关闭时采样仍然可用（退化成原有行为）。
	if len(s.sampleCandidates(ctx, 50, false, "", nil)) == 0 {
		t.Error("关闭时应照常生成候选")
	}
	// 显式要 IPv6 时也要能出候选（不依赖预检：预检只在 auto 下决定是否启用）。
	if v6 := s.sampleCandidates(ctx, 50, false, "both", nil); len(v6) == 0 {
		t.Error("both 应同时产出候选")
	} else {
		hasV6 := false
		for _, ip := range v6 {
			if strings.Contains(ip, ":") {
				hasV6 = true
				break
			}
		}
		if !hasV6 {
			t.Error("both 模式下应包含 IPv6 候选")
		}
	}
}

// 开启后应生成档案 ID，且不同档案互不混用历史。
func TestAdaptiveSamplingEnabledCreatesProfile(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	_, body := postJSON(t, base+"/api/experimental", cookie, map[string]any{
		"adaptiveSampling": true,
		"exploreRatio":     0.2,
		"isp":              "ct",
		"region":           "福建",
		"access":           "fixed",
	})
	if body["ok"] != true {
		t.Fatalf("保存失败：%v", body)
	}

	ctx := s.prepareAdaptive()
	if !ctx.enabled || ctx.profileID == "" {
		t.Fatalf("开启后应生成档案 ID：%+v", ctx)
	}
	observer := s.observer(ctx)
	if observer == nil {
		t.Fatal("开启后应有观察回调")
	}
	observer("104.16.1.2", "tcp", true, 42)
	observer("104.16.1.3", "ws", false, 0)
	s.saveAdaptive(ctx)

	// 档案应已落盘，且观测被记录。
	store, err := loadProfileStoreForTest(ctx.path)
	if err != nil {
		t.Fatalf("档案未落盘：%v", err)
	}
	obs := store.ForProfile(ctx.profileID)
	if len(obs) == 0 {
		t.Fatal("观测未记录")
	}
	// 同一档案的观测可复用；不同档案不应共享。
	if len(store.ForProfile("other-profile")) != 0 {
		t.Error("不同档案不应共享历史")
	}
}

// 设置里的实验段应随桌面设置一起持久化。
func TestExperimentalPersistedInSettings(t *testing.T) {
	s, base := newTestServer(t)
	s.SetStore(newEmptyStore(t))
	cookie := loginCookie(t, s, base)

	_, body := postJSON(t, base+"/api/experimental", cookie, map[string]any{
		"adaptiveSampling": true,
		"exploreRatio":     0.4,
		"isp":              "cu",
		"region":           "广东",
		"access":           "mobile",
	})
	if body["ok"] != true {
		t.Fatalf("保存失败：%v", body)
	}
	settings := s.Settings()
	if !settings.Experimental.AdaptiveSampling {
		t.Error("设置里未记录开关状态")
	}
	if settings.Experimental.ISP != "cu" || settings.Experimental.Region != "广东" || settings.Experimental.Access != "mobile" {
		t.Errorf("设置内容不对：%+v", settings.Experimental)
	}
	// 归一化后的取值应可再次读出。
	if got := normalizeExperimental(settings.Experimental); got.ExploreRatio != 0.4 {
		t.Errorf("探索比例应保持：%v", got.ExploreRatio)
	}
}
