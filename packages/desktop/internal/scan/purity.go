package scan

// IP 纯净度与信誉画像（外部公开数据源）。
//
// ## 口径（必须如实标注，界面与报告都按这个口径写）
//
// 这里查的是**候选 IP 自身**（优选入口 IP）的信誉画像：
// 欺诈分、是否被标记为代理/VPN/Tor/机房、是否命中公开黑名单、归属与 ASN。
//
// ⚠️ 目标网站看到的**不是**这个 IP —— 走代理时对方看到的是**出口 IP**
// （本机直连出口，或 ProxyIP / SOCKS5 的落地）。因此本节的结论只回答
// 「这个入口 IP 自身干不干净」，**不能**直接当作「目标站会不会给这个节点放行」。
// 出口侧的证据在报告的「出口」一节里，两节不要混为一谈。
//
// ## 数据源
//
//	- 信誉画像：公开的 IP 信誉页（HTML），给出欺诈分与各类标记；
//	- 归属信息：公开的 IP 归属查询（JSON），给出国家/城市/ASN/ISP。
//
// 两个源都**允许失败**：任一源不可用时，另一源的结果照常返回，
// 报告里标注清楚缺哪一部分 —— 绝不把「查不到」写成「干净」。
//
// 隐私：查询内容只有用户自己选中的候选 IP（公开 Anycast 地址），
// 不带任何凭据、路径或本机信息。

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	// purityTimeout 是单个数据源的总预算。
	purityTimeout = 12 * time.Second
	// purityMaxBody 是响应体上限（页面很大，截断即可，尾部字段用不到）。
	purityMaxBody = 4 << 20
)

// 数据源地址。做成变量是为了测试时替换成本地服务器。
var (
	purityReputationURL = "https://scamalytics.com/ip/"
	purityGeoURL        = "https://ipwho.is/"
)

// PurityFlags 是各类「身份标记」。
type PurityFlags struct {
	Datacenter  bool `json:"datacenter"`
	Server      bool `json:"server"`
	PublicProxy bool `json:"publicProxy"`
	WebProxy    bool `json:"webProxy"`
	Residential bool `json:"residentialProxy"`
	VPN         bool `json:"vpn"`
	Tor         bool `json:"tor"`
	Bot         bool `json:"searchEngineBot"`
}

// PurityResult 是 IP 信誉画像。
type PurityResult struct {
	IP string `json:"ip"`
	// Score 是欺诈分（0~100，越高越可疑）。nil = 未取到。
	Score *int `json:"score,omitempty"`
	// Risk 是风险等级：low / medium / high / unknown。
	Risk string `json:"risk,omitempty"`
	// Blacklists 是命中的公开黑名单名。
	Blacklists []string    `json:"blacklists,omitempty"`
	Flags      PurityFlags `json:"flags"`
	// 归属信息
	ASN         string `json:"asn,omitempty"`
	ISP         string `json:"isp,omitempty"`
	Org         string `json:"org,omitempty"`
	Country     string `json:"country,omitempty"`
	CountryCode string `json:"countryCode,omitempty"`
	City        string `json:"city,omitempty"`
	// ObservedAt 是观测时刻（ISO）。
	ObservedAt string `json:"observedAt,omitempty"`
	// Sources 是本次实际用上的数据源。
	Sources []string `json:"sources,omitempty"`
	// Error 是整体失败原因（部分成功时为空）。
	Error string `json:"error,omitempty"`
}

// ScenarioVerdict 是某个使用场景的适配结论。
type ScenarioVerdict struct {
	Label   string `json:"label"`
	Verdict string `json:"verdict"` // good / caution / bad / unknown
	Reason  string `json:"reason,omitempty"`
}

// purityLabelRows 是信誉页面里需要读取的标签 → 字段映射。
var purityLabelRows = []struct {
	label string
	set   func(*PurityFlags, bool)
}{
	{"Datacenter", func(f *PurityFlags, v bool) { f.Datacenter = v }},
	{"Server", func(f *PurityFlags, v bool) { f.Server = v }},
	{"Public Proxy", func(f *PurityFlags, v bool) { f.PublicProxy = v }},
	{"Web Proxy", func(f *PurityFlags, v bool) { f.WebProxy = v }},
	{"Residential Proxy", func(f *PurityFlags, v bool) { f.Residential = v }},
	{"Anonymizing VPN", func(f *PurityFlags, v bool) { f.VPN = v }},
	{"Tor Exit Node", func(f *PurityFlags, v bool) { f.Tor = v }},
	{"Search Engine Robot", func(f *PurityFlags, v bool) { f.Bot = v }},
}

// purityBlacklistRows 是公开黑名单标签。
var purityBlacklistRows = []string{
	"Firehol",
	"IP2ProxyLite",
	"IPsum",
	"Spamhaus",
	"X4Bnet Spambot",
}

var (
	purityScoreRE = regexp.MustCompile(`Fraud Score:\s*(\d{1,3})`)
	purityRiskRE  = regexp.MustCompile(`>(Low|Medium|High)\s+Risk</div>`)
	purityRowRE   = regexp.MustCompile(`(?is)<tr>\s*<th>\s*([^<]{1,60}?)\s*</th>\s*<td[^>]*>(.*?)</td>\s*</tr>`)
	purityTextRE  = regexp.MustCompile(`(?s)<[^>]+>`)
)

// FetchPurity 取候选 IP 的信誉画像与归属信息。
//
// 两个源**并发**查：信誉页是大 HTML（慢），归属查询是 JSON（快），
// 串行会把总耗时拉成两者之和，用户等不起。
//
// 任一源失败都不影响另一源；两个都失败才返回整体错误。
func FetchPurity(ctx context.Context, ip string) PurityResult {
	res := PurityResult{IP: ip, ObservedAt: time.Now().UTC().Format(time.RFC3339)}
	client := &http.Client{Timeout: purityTimeout}

	// ⚠️ 两个 goroutine 各写各的结构体，**不共享** res ——
	// 共享写入会产生数据竞争（go test -race 会报）。
	var rep, geo PurityResult
	var repErr, geoErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		repErr = fetchPurityReputation(ctx, client, ip, &rep)
	}()
	go func() {
		defer wg.Done()
		geoErr = fetchPurityGeo(ctx, client, ip, &geo)
	}()
	wg.Wait()

	// 合并：归属字段优先用归属源（更权威），信誉字段用信誉源。
	res.Score = rep.Score
	res.Risk = rep.Risk
	res.Flags = rep.Flags
	res.Blacklists = rep.Blacklists
	res.Sources = append(rep.Sources, geo.Sources...)
	res.Country = firstNonEmpty(geo.Country, rep.Country)
	res.CountryCode = firstNonEmpty(geo.CountryCode, rep.CountryCode)
	res.City = firstNonEmpty(geo.City, rep.City)
	res.ASN = firstNonEmpty(rep.ASN, geo.ASN)
	res.ISP = firstNonEmpty(geo.ISP, rep.ISP)
	res.Org = firstNonEmpty(geo.Org, rep.Org)

	switch {
	case repErr != nil && geoErr != nil:
		res.Error = "信誉与归属查询都失败：" + firstNonEmpty(repErr.Error(), geoErr.Error())
	case repErr != nil:
		res.Error = "信誉查询失败：" + repErr.Error()
	case geoErr != nil:
		// 归属缺失不影响「干不干净」的结论，只少一段信息。
		res.Error = "归属查询失败：" + geoErr.Error()
	}
	if res.Risk == "" && res.Score == nil {
		res.Risk = "unknown"
	}
	return res
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// fetchPurityReputation 读取信誉页面，解析欺诈分、风险等级与各类标记。
func fetchPurityReputation(ctx context.Context, client *http.Client, ip string, res *PurityResult) error {
	body, err := fetchText(ctx, client, purityReputationURL+ip)
	if err != nil {
		return err
	}
	if m := purityScoreRE.FindStringSubmatch(body); len(m) == 2 {
		if n, err := parseScore(m[1]); err == nil {
			res.Score = &n
		}
	}
	if m := purityRiskRE.FindStringSubmatch(body); len(m) == 2 {
		res.Risk = strings.ToLower(m[1])
	}
	rows := map[string]string{}
	for _, m := range purityRowRE.FindAllStringSubmatch(body, -1) {
		label := strings.TrimSpace(m[1])
		if _, ok := rows[label]; ok {
			// 同一标签可能出现多次（页面上有重复段落），取第一个非空值。
			if rows[label] != "" {
				continue
			}
		}
		rows[label] = strings.TrimSpace(purityTextRE.ReplaceAllString(m[2], " "))
	}
	for _, spec := range purityLabelRows {
		if v, ok := rows[spec.label]; ok {
			spec.set(&res.Flags, strings.EqualFold(v, "yes"))
		}
	}
	for _, name := range purityBlacklistRows {
		if v, ok := rows[name]; ok && strings.EqualFold(v, "yes") {
			res.Blacklists = append(res.Blacklists, name)
		}
	}
	// 归属信息在同一个页面上，取不到再由 JSON 源补。
	res.ASN = firstNonEmpty(rows["ASN"])
	res.ISP = firstNonEmpty(rows["ISP Name"])
	res.Org = firstNonEmpty(rows["Organization Name"])
	res.Country = firstNonEmpty(rows["Country Name"])
	res.CountryCode = firstNonEmpty(rows["Country Code"])
	res.City = firstNonEmpty(rows["City"])
	res.Sources = append(res.Sources, "信誉画像")
	if res.Score == nil && res.Risk == "" {
		return fmt.Errorf("信誉页面未返回可识别的评分字段")
	}
	return nil
}

// purityGeoResponse 是归属查询的返回结构（只取需要的字段）。
type purityGeoResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Country string `json:"country"`
	// CountryCode 有些源给 "CA"，有些给全名；两种都按字符串收。
	CountryCode string `json:"country_code"`
	City        string `json:"city"`
	Connection  struct {
		// ASN 可能是数字（13335）也可能是字符串（"AS13335"），
		// 用 json.Number 收：数字原样、字符串也能装下（见 UnmarshalJSON）。
		ASN json.Number `json:"asn"`
		Org string      `json:"org"`
		ISP string      `json:"isp"`
	} `json:"connection"`
}

// UnmarshalJSON 兼容 ASN 的数字 / 字符串两种形态。
//
// 公开的归属接口对 ASN 的返回不统一（有的给 13335，有的给 "AS13335"），
// 按字符串收会因为类型不匹配直接失败 —— 整个查询白跑。
func (p *purityGeoResponse) UnmarshalJSON(data []byte) error {
	type alias purityGeoResponse
	aux := struct {
		*alias
		RawASN json.RawMessage `json:"asn"`
	}{alias: (*alias)(p)}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	raw := strings.Trim(strings.TrimSpace(string(aux.RawASN)), `"`)
	if raw != "" && raw != "null" {
		p.Connection.ASN = json.Number(raw)
	}
	return nil
}

func fetchPurityGeo(ctx context.Context, client *http.Client, ip string, res *PurityResult) error {
	body, err := fetchText(ctx, client, purityGeoURL+ip)
	if err != nil {
		return err
	}
	var payload purityGeoResponse
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return fmt.Errorf("归属数据不是合法 JSON")
	}
	if !payload.Success {
		return fmt.Errorf("归属查询失败：%s", firstNonEmpty(payload.Message, "未知原因"))
	}
	res.Country = firstNonEmpty(res.Country, payload.Country)
	res.CountryCode = firstNonEmpty(res.CountryCode, payload.CountryCode)
	res.City = firstNonEmpty(res.City, payload.City)
	res.ISP = firstNonEmpty(res.ISP, payload.Connection.ISP)
	res.Org = firstNonEmpty(res.Org, payload.Connection.Org)
	if res.ASN == "" && payload.Connection.ASN != "" {
		asn := payload.Connection.ASN.String()
		if !strings.HasPrefix(strings.ToUpper(asn), "AS") {
			asn = "AS" + asn
		}
		res.ASN = asn
	}
	res.Sources = append(res.Sources, "归属信息")
	return nil
}

// fetchText 取一个 URL 的文本内容（限制体积 + 总超时）。
func fetchText(ctx context.Context, client *http.Client, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Accept", "text/html,application/json;q=0.9,*/*;q=0.8")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, purityMaxBody))
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func parseScore(text string) (int, error) {
	n := 0
	for _, c := range text {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("评分不是数字")
		}
		n = n*10 + int(c-'0')
	}
	if n < 0 || n > 100 {
		return 0, fmt.Errorf("评分超出范围")
	}
	return n, nil
}

// PurityScenarios 由信誉画像推导「场景适配」结论。
//
// ## 为什么只给「倾向」而不是「结论」
//
// 目标站是否放行取决于**它自己的风控**与**出口 IP**，这里只能给出
// 「按公开信誉画像看，这个入口 IP 更适合 / 更不适合某类用途」的倾向，
// 供用户判断。任何一项缺少证据都标 unknown，不猜。
func PurityScenarios(p PurityResult) []ScenarioVerdict {
	out := []ScenarioVerdict{}
	known := p.Score != nil || p.Risk != "unknown" || len(p.Blacklists) > 0 ||
		p.Flags.Datacenter || p.Flags.VPN || p.Flags.Tor || p.Flags.PublicProxy || p.Flags.Residential

	// 常规浏览 / 内容抓取
	out = append(out, scenarioFor("常规浏览与内容抓取", p, known, func() (string, string) {
		if p.Flags.VPN || p.Flags.Tor || p.Flags.PublicProxy {
			return "caution", "被标记为代理/VPN/Tor 出口，部分站点会直接拒绝"
		}
		if p.Score != nil && *p.Score >= 25 {
			return "caution", fmt.Sprintf("欺诈分 %d，站点级风控可能提高门槛", *p.Score)
		}
		if known {
			return "good", "公开信誉画像未见异常标记"
		}
		return "unknown", "缺少信誉数据，无法判断"
	}))

	// 账号登录 / 支付
	out = append(out, scenarioFor("账号登录与支付", p, known, func() (string, string) {
		if p.Flags.VPN || p.Flags.Tor || p.Flags.PublicProxy || p.Flags.Datacenter {
			return "caution", "机房或代理属性常触发风控，账号类场景风险更高"
		}
		if p.Flags.Residential {
			return "good", "住宅属性对账号类场景更友好"
		}
		if known {
			return "caution", "非住宅属性，账号类场景可能被要求额外验证"
		}
		return "unknown", "缺少信誉数据，无法判断"
	}))

	// 流媒体 / AI
	out = append(out, scenarioFor("流媒体与 AI 服务", p, known, func() (string, string) {
		if p.Flags.VPN || p.Flags.Tor || p.Flags.PublicProxy {
			return "bad", "共享代理出口常被流媒体与 AI 服务拉黑"
		}
		if p.Flags.Residential {
			return "good", "住宅属性对解锁类服务更友好"
		}
		if p.Flags.Datacenter {
			return "caution", "机房属性通常不解锁流媒体"
		}
		if known {
			return "caution", "非住宅且无异常标记，解锁情况取决于服务方策略"
		}
		return "unknown", "缺少信誉数据，无法判断"
	}))

	// 风控严格站点
	out = append(out, scenarioFor("风控严格站点", p, known, func() (string, string) {
		if len(p.Blacklists) > 0 {
			return "bad", "命中公开黑名单：" + strings.Join(p.Blacklists, "、")
		}
		if p.Score != nil && *p.Score >= 25 {
			return "caution", fmt.Sprintf("欺诈分 %d，容易被风控拦截", *p.Score)
		}
		if known {
			return "good", "未命中公开黑名单，欺诈分较低"
		}
		return "unknown", "缺少信誉数据，无法判断"
	}))

	return out
}

// scenarioFor 统一出口：证据不足时结论一律降级为 unknown（不猜）。
func scenarioFor(label string, p PurityResult, known bool, decide func() (string, string)) ScenarioVerdict {
	verdict, reason := decide()
	if !known && verdict != "unknown" {
		verdict = "unknown"
	}
	return ScenarioVerdict{Label: label, Verdict: verdict, Reason: reason}
}
