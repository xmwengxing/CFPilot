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
