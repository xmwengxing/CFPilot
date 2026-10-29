package scan

import "testing"

// TestExpandCountryFilterCountryCode 验证国家代码展开成该国全部机房。
func TestExpandCountryFilterCountryCode(t *testing.T) {
	got := ExpandCountryFilter([]string{"US"})
	for _, colo := range []string{"LAX", "SJC", "SEA", "ORD", "IAD"} {
		if !got[colo] {
			t.Errorf("US 应包含机房 %s", colo)
		}
	}
	if got["LHR"] {
		t.Error("US 不应包含英国的 LHR")
	}
}

// TestExpandCountryFilterColoCode 验证机房代码直接匹配（界面现有行为）。
func TestExpandCountryFilterColoCode(t *testing.T) {
	got := ExpandCountryFilter([]string{"LAX"})
	if !got["LAX"] {
		t.Error("LAX 应直接匹配")
	}
	if got["SJC"] {
		t.Error("只给 LAX 时不应包含 SJC")
	}
}

// TestExpandCountryFilterMixed 验证两种写法可以混用。
func TestExpandCountryFilterMixed(t *testing.T) {
	got := ExpandCountryFilter([]string{"JP", "LAX", "hk", "  "})
	for _, colo := range []string{"NRT", "KIX", "LAX", "HKG"} {
		if !got[colo] {
			t.Errorf("混合筛选应包含 %s", colo)
		}
	}
	if got["SYD"] {
		t.Error("不应包含无关机房 SYD")
	}
}

// TestCountryOfColo 验证机房 → 国家映射。
func TestCountryOfColo(t *testing.T) {
	cases := map[string]string{
		"LAX": "US",
		"lax": "US",
		"NRT": "JP",
		"HKG": "HK",
		"XXX": "",
	}
	for colo, want := range cases {
		if got := CountryOfColo(colo); got != want {
			t.Errorf("CountryOfColo(%q) = %q，期望 %q", colo, got, want)
		}
	}
}

// TestRegionGroupColos 验证分组展开成机房集合。
//
// 界面的「亚洲组 / 美国组」按钮直接按这个集合选中多选框，
// 多选或少选一个国家，用户看到的筛选范围就与 CLI 版不一致。
func TestRegionGroupColos(t *testing.T) {
	asia := RegionGroupColos("ASIA")
	found := map[string]bool{}
	for _, c := range asia {
		found[c] = true
	}
	for _, want := range []string{"HKG", "NRT", "SIN", "BOM", "DXB", "TLV"} {
		if !found[want] {
			t.Errorf("亚洲组应包含机房 %s", want)
		}
	}
	// 大洋洲与横跨欧亚的 TR / RU 不属于亚洲组
	for _, notAsia := range []string{"SYD", "AKL", "IST", "DME", "LAX"} {
		if found[notAsia] {
			t.Errorf("亚洲组不应包含 %s", notAsia)
		}
	}

	us := RegionGroupColos("US")
	if len(us) != len(countryColos["US"]) {
		t.Errorf("美国组应包含美国全部 %d 个机房，实际 %d", len(countryColos["US"]), len(us))
	}
	for _, colo := range us {
		if CountryOfColo(colo) != "US" {
			t.Errorf("美国组混入了非美国机房 %s", colo)
		}
	}

	if RegionGroupColos("NOPE") != nil {
		t.Error("未知分组应返回 nil（界面据此置灰按钮）")
	}
}

// TestRegionGroupNamesOrder 验证分组顺序与界面按钮一致（亚洲组在前）。
func TestRegionGroupNamesOrder(t *testing.T) {
	names := RegionGroupNames()
	if len(names) != 2 || names[0] != "ASIA" || names[1] != "US" {
		t.Errorf("分组顺序应为 [ASIA US]，实际 %v", names)
	}
}

// TestExpandCountryFilterRegionGroup 验证分组关键字也能进筛选，
// 且两个分组可以同时生效。
func TestExpandCountryFilterRegionGroup(t *testing.T) {
	got := ExpandCountryFilter([]string{"ASIA", "US"})
	for _, colo := range []string{"HKG", "NRT", "LAX"} {
		if !got[colo] {
			t.Errorf("亚洲组+美国组应包含 %s", colo)
		}
	}
	if got["SYD"] || got["LHR"] {
		t.Error("不应包含大洋洲 / 欧洲机房")
	}
}

// TestSupportedCountriesStable 验证国家列表稳定且非空。
func TestSupportedCountriesStable(t *testing.T) {
	a := SupportedCountries()
	b := SupportedCountries()
	if len(a) == 0 {
		t.Fatal("国家列表不应为空")
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("两次调用顺序不一致：%v vs %v", a, b)
		}
	}
}
