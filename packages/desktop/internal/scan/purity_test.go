package scan

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeReputationHTML 是一段与真实信誉页同构的最小 HTML。
const fakeReputationHTML = `
<html><body>
<div class="panel_title high_risk">Low Risk</div>
<div class="score">Fraud Score: 7</div>
<table>
<tr><th>ASN</th><td>13335</td></tr>
<tr><th>ISP Name</th><td>Cloudflare, Inc.</td></tr>
<tr><th>Organization Name</th><td>Cloudflare, Inc.</td></tr>
<tr><th>Country Name</th><td>Canada</td></tr>
<tr><th>Country Code</th><td>CA</td></tr>
<tr><th>City</th><td>Toronto</td></tr>
<tr><th>Datacenter</th><td><div class="risk yes">Yes</div></td></tr>
<tr><th>Firehol</th><td><div class="risk no">No</div></td></tr>
<tr><th>Spamhaus</th><td><div class="risk yes">Yes</div></td></tr>
<tr><th>Anonymizing VPN</th><td><div class="risk no">No</div></td></tr>
<tr><th>Tor Exit Node</th><td><div class="risk no">No</div></td></tr>
<tr><th>Public Proxy</th><td><div class="risk no">No</div></td></tr>
</table>
</body></html>`

const fakeGeoJSON = `{"success":true,"country":"Canada","country_code":"CA","city":"Toronto","connection":{"asn":13335,"org":"Cloudflare, Inc.","isp":"Cloudflare, Inc."}}`

func TestFetchPurityParsesScoreFlagsAndAttribution(t *testing.T) {
	origRep, origGeo := purityReputationURL, purityGeoURL
	defer func() { purityReputationURL, purityGeoURL = origRep, origGeo }()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/reputation/") {
			_, _ = w.Write([]byte(fakeReputationHTML))
			return
		}
		_, _ = w.Write([]byte(fakeGeoJSON))
	}))
	defer srv.Close()
	purityReputationURL = srv.URL + "/reputation/"
	purityGeoURL = srv.URL + "/geo/"

	res := FetchPurity(context.Background(), "104.16.1.1")
	if res.Score == nil || *res.Score != 7 {
		t.Fatalf("欺诈分应为 7，实际 %v", res.Score)
	}
	if res.Risk != "low" {
		t.Fatalf("风险等级应为 low，实际 %q", res.Risk)
	}
	if !res.Flags.Datacenter {
		t.Fatal("应识别出机房标记")
	}
	if len(res.Blacklists) != 1 || res.Blacklists[0] != "Spamhaus" {
		t.Fatalf("黑名单应只有 Spamhaus，实际 %v", res.Blacklists)
	}
	if res.ASN != "13335" || res.ISP != "Cloudflare, Inc." {
		t.Fatalf("归属解析不对：ASN=%q ISP=%q", res.ASN, res.ISP)
	}
	if res.CountryCode != "CA" {
		t.Fatalf("国家码应为 CA，实际 %q", res.CountryCode)
	}
	if res.Error != "" {
		t.Fatalf("两个源都成功时不应有错误：%s", res.Error)
	}
}

func TestFetchPurityPartialFailureKeepsOtherSource(t *testing.T) {
	origRep, origGeo := purityReputationURL, purityGeoURL
	defer func() { purityReputationURL, purityGeoURL = origRep, origGeo }()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/reputation/") {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(fakeGeoJSON))
	}))
	defer srv.Close()
	purityReputationURL = srv.URL + "/reputation/"
	purityGeoURL = srv.URL + "/geo/"

	res := FetchPurity(context.Background(), "104.16.1.1")
	if res.Score != nil {
		t.Fatalf("信誉源失败时不应有分数，实际 %v", *res.Score)
	}
	if res.CountryCode != "CA" {
		t.Fatalf("归属源仍应可用，实际 %q", res.CountryCode)
	}
	if res.Error == "" {
		t.Fatal("应记录信誉源失败原因")
	}
}

func TestPurityScenariosNeverGuessesWithoutEvidence(t *testing.T) {
	// 空结果 = 什么都没查到 → 全部 unknown，不能给「适合」。
	empty := PurityResult{Risk: "unknown"}
	for _, sc := range PurityScenarios(empty) {
		if sc.Verdict != "unknown" {
			t.Fatalf("%s 在无证据时不应给结论，实际 %s", sc.Label, sc.Verdict)
		}
	}
	// 机房 + 黑名单 → 风控场景应为 bad
	score := 40
	dirty := PurityResult{
		Score:      &score,
		Risk:       "medium",
		Flags:      PurityFlags{Datacenter: true},
		Blacklists: []string{"Spamhaus"},
	}
	byLabel := map[string]string{}
	for _, sc := range PurityScenarios(dirty) {
		byLabel[sc.Label] = sc.Verdict
	}
	if byLabel["风控严格站点"] != "bad" {
		t.Fatalf("命中黑名单时风控场景应为 bad，实际 %q", byLabel["风控严格站点"])
	}
	if byLabel["流媒体与 AI 服务"] != "caution" {
		t.Fatalf("机房属性时流媒体场景应为 caution，实际 %q", byLabel["流媒体与 AI 服务"])
	}
}
