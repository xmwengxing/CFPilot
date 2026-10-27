package scan

import (
	"strings"
	"testing"
)

// TestColoNameOfFallback 验证机房中文名的回落逻辑。
func TestColoNameOfFallback(t *testing.T) {
	cases := map[string]string{
		"LAX":  "洛杉矶",
		"lax":  "洛杉矶",
		"NRT":  "东京",
		"HKG":  "香港",
		"XXX":  "", // 未知机房 → 空（CountryOfColo 也认不出）
		"MIA":  "迈阿密",
		" PEK": "", // PEK（北京）早已不在 Cloudflare 机房表里
	}
	for colo, want := range cases {
		if got := ColoNameOf(colo); got != want {
			t.Errorf("ColoNameOf(%q) = %q，期望 %q", colo, got, want)
		}
	}
}

// TestColoNamesCoverCountryColos 验证常用机房都有中文名。
func TestColoNamesCoverCountryColos(t *testing.T) {
	missing := []string{}
	for country := range countryColos {
		for _, colo := range countryColos[country] {
			if _, ok := coloNames[colo]; !ok {
				missing = append(missing, colo)
			}
		}
	}
	if len(missing) > 0 {
		t.Errorf("这些机房没有中文名：%s", strings.Join(missing, ", "))
	}
}
