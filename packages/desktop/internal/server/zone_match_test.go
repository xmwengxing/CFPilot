package server

import (
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
)

// Zone 自动匹配：域名后缀 → 最长匹配 zone（避免用户必须手选 Zone）。
func TestMatchZoneID(t *testing.T) {
	zones := []cfapi.Zone{
		{ID: "z-apex", Name: "dpdns.org"},
		{ID: "z-sub", Name: "shijingtian.dpdns.org"},
		{ID: "z-other", Name: "example.com"},
	}
	cases := []struct{ domain, want string }{
		{"edge.shijingtian.dpdns.org", "z-sub"},
		{"shijingtian.dpdns.org", "z-sub"},
		{"a.b.dpdns.org", "z-apex"},
		{"relay.example.com", "z-other"},
		{"edge.unknown.org", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := matchZoneID(zones, c.domain); got != c.want {
			t.Errorf("matchZoneID(%q)=%q want %q", c.domain, got, c.want)
		}
	}
}
