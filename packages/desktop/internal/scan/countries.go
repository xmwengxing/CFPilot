package scan

import "strings"

// countryColos 国家代码 → 该国的 Cloudflare 机房三字码。
//
// 与 CLI 版 packages/cli/src/scan/countries.ts 的 COUNTRY_COLOS 保持一致。
var countryColos = map[string][]string{
	"HK": {"HKG"},
	"TW": {"TPE", "KHH"},
	"JP": {"NRT", "KIX", "CTS", "FUK"},
	"KR": {"ICN", "PUS"},
	"SG": {"SIN"},
	"MY": {"KUL"},
	"TH": {"BKK"},
	"VN": {"SGN", "HAN"},
	"ID": {"CGK", "DPS"},
	"PH": {"MNL"},
	"IN": {"BOM", "MAA", "DEL"},
	"AU": {"SYD", "MEL", "BNE", "PER"},
	"NZ": {"AKL"},
	"US": {"LAX", "SJC", "SEA", "ORD", "DFW", "IAD", "EWR", "ATL", "MIA", "DEN", "PHX", "BOS"},
	"CA": {"YYZ", "YVR", "YYC"},
	"GB": {"LHR", "MAN"},
	"DE": {"FRA", "MUC", "BER"},
	"FR": {"CDG", "MRS"},
	"NL": {"AMS"},
	"IT": {"MXP", "FCO"},
	"ES": {"MAD", "BCN"},
	"SE": {"ARN"},
	"CH": {"ZRH"},
	"AT": {"VIE"},
	"PL": {"WAW"},
	"RU": {"DME", "SVO"},
	"TR": {"IST"},
	"AE": {"DXB"},
	"IL": {"TLV"},
	"ZA": {"JNB"},
	"BR": {"GRU", "GIG"},
	"AR": {"EZE"},
	"CL": {"SCL"},
	"MX": {"MEX"},
}

// regionGroups 分组关键字 → 该组包含的国家代码。
//
// 与 CLI 版 packages/cli/src/scan/countries.ts 的 REGION_GROUPS 同步：
// 分组存国家码，机房码由 countryColos 展开，避免两处各写一份机房表。
//
// 亚洲组按地理口径取「亚洲国家」（东亚 / 东南亚 / 南亚 / 西亚），
// 不含大洋洲（AU / NZ），也不含横跨欧亚、机房在欧洲一侧的 TR / RU。
var regionGroups = map[string][]string{
	"ASIA": {"HK", "TW", "JP", "KR", "SG", "MY", "TH", "VN", "ID", "PH", "IN", "AE", "IL"},
	"US":   {"US"},
}

// regionGroupOrder 分组输出顺序（与界面按钮一致：亚洲组在前）。
var regionGroupOrder = []string{"ASIA", "US"}

// RegionGroupColos 返回分组名 → 该组的全部机房三字码（按 countryColos 定义顺序）。
//
// 界面的「亚洲组 / 美国组」按钮拿它选中对应的机房码；
// 分组名未知时返回空（界面据此把按钮置灰，而不是乱选）。
func RegionGroupColos(name string) []string {
	countries, ok := regionGroups[strings.ToUpper(strings.TrimSpace(name))]
	if !ok {
		return nil
	}
	out := make([]string, 0, 16)
	seen := make(map[string]bool, 16)
	for _, country := range countries {
		for _, colo := range countryColos[country] {
			if seen[colo] {
				continue
			}
			seen[colo] = true
			out = append(out, colo)
		}
	}
	return out
}

// RegionGroupNames 返回全部分组名（按界面按钮的顺序）。
func RegionGroupNames() []string {
	out := make([]string, len(regionGroupOrder))
	copy(out, regionGroupOrder)
	return out
}

// coloToCountry 机房三字码 → 国家代码（模块加载时构建一次）。
var coloToCountry = func() map[string]string {
	out := make(map[string]string)
	for country, colos := range countryColos {
		for _, c := range colos {
			out[c] = country
		}
	}
	return out
}()

// CountryOfColo 返回机房所属国家代码；未知返回空串。
func CountryOfColo(colo string) string {
	return coloToCountry[strings.ToUpper(strings.TrimSpace(colo))]
}

// IsKnownCountry 判断国家代码是否受支持。
func IsKnownCountry(code string) bool {
	_, ok := countryColos[strings.ToUpper(strings.TrimSpace(code))]
	return ok
}

// SupportedCountries 返回全部受支持的国家代码（按定义顺序）。
func SupportedCountries() []string {
	out := make([]string, 0, len(countryColos))
	for c := range countryColos {
		out = append(out, c)
	}
	// map 遍历顺序随机，按字典序输出保证稳定
	sortStrings(out)
	return out
}

// sortStrings 简单字符串排序（避免为一个排序引入 sort 包到本文件）。
func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// ExpandCountryFilter 把用户输入的筛选条件展开成「要匹配的机房集合」。
//
// ## 为什么同时接受国家代码与机房代码
//
// CLI 版（权威实现）用**国家代码**（US、JP、HK…），
// 而 Go 版的图形界面一直用**机房代码**（LAX、NRT、HKG…）——
// 后者更细粒度（可以精确要「洛杉矶」而不是整个美国）。
//
// 两边语义不同会导致同一份脚本在 CLI 与桌面版上结果不一致，
// 违反 AGENTS.md §2.2「行为必须一致」的要求。
//
// 所以这里**三种都接受**：
//   - 分组关键字（ASIA / US）→ 展开成该组全部国家 → 再展开成机房
//   - 国家代码 → 展开成该国的全部机房
//   - 机房代码 → 直接匹配该机房
//
// 这样既不破坏界面现有的行为，也让 Go 版与 CLI 语义一致。
//
// 对应 CLI 版 packages/cli/src/scan/countries.ts 的 normalizeCountryFilter。
func ExpandCountryFilter(input []string) map[string]bool {
	out := make(map[string]bool, len(input))
	for _, raw := range input {
		code := strings.ToUpper(strings.TrimSpace(raw))
		if code == "" {
			continue
		}
		if members, ok := regionGroups[code]; ok {
			// 分组 → 组内国家 → 机房（组内只含国家码，不会递归）
			for _, country := range members {
				for _, c := range countryColos[country] {
					out[c] = true
				}
			}
			continue
		}
		if colos, ok := countryColos[code]; ok {
			// 国家代码 → 该国全部机房
			for _, c := range colos {
				out[c] = true
			}
			continue
		}
		// 机房代码 → 直接匹配
		out[code] = true
	}
	return out
}

// countryNames 国家代码 → 中文名（与 CLI 版 countries.ts 的 COUNTRY_NAMES 一致）。
var countryNames = map[string]string{
	"HK": "香港", "TW": "台湾", "JP": "日本", "KR": "韩国", "SG": "新加坡",
	"MY": "马来西亚", "TH": "泰国", "VN": "越南", "ID": "印尼", "PH": "菲律宾",
	"IN": "印度", "AU": "澳大利亚", "NZ": "新西兰", "US": "美国", "CA": "加拿大",
	"GB": "英国", "DE": "德国", "FR": "法国", "NL": "荷兰", "IT": "意大利",
	"ES": "西班牙", "SE": "瑞典", "CH": "瑞士", "AT": "奥地利", "PL": "波兰",
	"RU": "俄罗斯", "TR": "土耳其", "AE": "阿联酋", "IL": "以色列", "ZA": "南非",
	"BR": "巴西", "AR": "阿根廷", "CL": "智利", "MX": "墨西哥",
}

// CountryColosOf 返回该国家的机房三字码列表。
func CountryColosOf(country string) []string {
	colos, ok := countryColos[strings.ToUpper(strings.TrimSpace(country))]
	if !ok {
		return nil
	}
	out := make([]string, len(colos))
	copy(out, colos)
	return out
}

// CountryNameOf 返回国家中文名；未知返回空串。
func CountryNameOf(country string) string {
	return countryNames[strings.ToUpper(strings.TrimSpace(country))]
}

// coloNames 机房三字码 → 中文名。
//
// 界面地区下拉用这个（比「LAX（美国）」可读）。
// 只覆盖常见机房，未列出的按国家名兜底。
var coloNames = map[string]string{
	"HKG": "香港", "TPE": "台北", "KHH": "高雄",
	"NRT": "东京", "KIX": "大阪", "CTS": "名古屋", "FUK": "福冈",
	"ICN": "首尔", "PUS": "釜山",
	"SIN": "新加坡", "KUL": "吉隆坡", "BKK": "曼谷",
	"SGN": "胡志明", "HAN": "河内", "CGK": "雅加达", "DPS": "巴厘",
	"MNL": "马尼拉", "BOM": "孟买", "MAA": "钦奈", "DEL": "德里",
	"SYD": "悉尼", "MEL": "墨尔本", "BNE": "布里斯班", "PER": "珀斯",
	"AKL": "奥克兰",
	"LAX": "洛杉矶", "SJC": "圣何塞", "SEA": "西雅图", "ORD": "芝加哥",
	"DFW": "达拉斯", "IAD": "华盛顿", "EWR": "纽瓦克", "ATL": "亚特兰大",
	"MIA": "迈阿密", "DEN": "丹佛", "PHX": "凤凰城", "BOS": "波士顿",
	"YYZ": "多伦多", "YVR": "温哥华", "YYC": "卡尔加里",
	"LHR": "伦敦", "MAN": "曼彻斯特",
	"AMS": "阿姆斯特丹", "FRA": "法兰克福", "MUC": "慕尼黑", "BER": "柏林",
	"CDG": "巴黎", "MRS": "马赛", "MAD": "马德里", "BCN": "巴塞罗那",
	"MXP": "米兰", "FCO": "罗马", "ARN": "斯德哥尔摩", "ZRH": "苏黎世",
	"VIE": "维也纳", "WAW": "华沙", "DME": "莫斯科", "SVO": "莫斯科",
	"IST": "伊斯坦布尔", "DXB": "迪拜", "TLV": "特拉维夫",
	"JNB": "约翰内斯堡", "GRU": "圣保罗", "GIG": "里约热内卢",
	"EZE": "布宜诺斯艾利斯", "SCL": "圣地亚哥", "MEX": "墨西哥城",
}

// ColoNameOf 返回机房中文名；未知则回落到国家名。
func ColoNameOf(colo string) string {
	code := strings.ToUpper(strings.TrimSpace(colo))
	if n, ok := coloNames[code]; ok {
		return n
	}
	return CountryNameOf(CountryOfColo(code))
}
