package schedule

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// 内置定时任务。
//
// ## 5 个内置任务扫什么
//
//	CF 全网段_IPv4&IPv6  → 不筛国家，IPv4 + IPv6
//	亚洲组_IPv4          → 亚洲组（ASIA），仅 IPv4
//	亚洲组_IPv6          → 亚洲组（ASIA），仅 IPv6
//	美国组_IPv4          → 美国组（US），仅 IPv4
//	美国组_IPv6          → 美国组（US），仅 IPv6
//
// 其余优选参数全部取系统默认（见 BuiltinSample / BuiltinTop）。
//
// ## ⚠️ 「CF 全网段」的 IPv6 部分名不副实
//
// IPv6 只在**实测活跃的 /48 前缀**内采样（scan.IPv6ActivePrefixes），
// 不是官方公布的聚合段 —— 公布段盲采实测 0/18 全超时。
// 所以任务卡上显示「IPv4+IPv6（IPv6 仅活跃段）」，避免用户误解成「全网段」。
//
// ## 默认全部禁用
//
// 内置任务是**无人值守每天自动跑**的 —— 装上就自动对外扫描不合适。
// 建好但默认禁用，由用户在页面上逐个启用并设定时间。
// 运行时刻仍然错开（01:00…05:00），这样全部启用后也不会互相冲突。
//
// ## 按账号各生成一套
//
// 任务归属账号（每个账号有自己的部署实例），所以内置任务也按账号各一套。
// 账号之间互不影响。

// builtinSpec 是内置任务的定义。
type builtinSpec struct {
	key       string
	name      string
	family    string
	countries []string
	runAt     string
}

// builtinSpecs 是全部内置任务的定义（顺序 = 展示顺序）。
var builtinSpecs = []builtinSpec{
	{BuiltinCFAll, "CF 全网段_IPv4&IPv6", "both", nil, "01:00"},
	{BuiltinAsiaV4, "亚洲组_IPv4", "v4", []string{"ASIA"}, "02:00"},
	{BuiltinAsiaV6, "亚洲组_IPv6", "v6", []string{"ASIA"}, "03:00"},
	{BuiltinUSV4, "美国组_IPv4", "v4", []string{"US"}, "04:00"},
	{BuiltinUSV6, "美国组_IPv6", "v6", []string{"US"}, "05:00"},
}

// BuiltinKeys 返回全部内置任务的身份键。
func BuiltinKeys() []string {
	out := make([]string, 0, len(builtinSpecs))
	for _, s := range builtinSpecs {
		out = append(out, s.key)
	}
	return out
}

// DefaultScanParams 返回内置任务用的优选参数（系统默认）。
func DefaultScanParams() ScanParams {
	return ScanParams{
		Family:           "auto",
		Countries:        nil,
		Sample:           BuiltinSample,
		Top:              BuiltinTop,
		SpeedMode:        "two",
		SpeedDurationMs:  6000,
		SpeedConnections: 8,
		ProbeTransport:   "ws",
	}
}

// BuiltinTasks 为指定账号生成一套内置任务。
//
// 已存在的内置任务不会重复生成（按 BuiltinKey + ProfileID 判重）。
func BuiltinTasks(existing []Task, profileID string, now time.Time) []Task {
	var out []Task
	for _, spec := range builtinSpecs {
		if hasBuiltin(existing, spec.key, profileID) {
			continue
		}
		params := DefaultScanParams()
		params.Family = spec.family
		params.Countries = spec.countries
		ms := now.UnixMilli()
		out = append(out, Task{
			ID:           NewTaskID(),
			Name:         spec.name,
			Builtin:      true,
			BuiltinKey:   spec.key,
			ProfileID:    profileID,
			Enabled:      false,
			IntervalDays: BuiltinIntervalDays,
			RunAt:        spec.runAt,
			Scan:         params,
			AnchorAt:     ms,
			CreatedAt:    ms,
			UpdatedAt:    ms,
		})
	}
	return out
}

// hasBuiltin 判断该账号是否已有这条内置任务。
func hasBuiltin(tasks []Task, key, profileID string) bool {
	for _, t := range tasks {
		if t.Builtin && t.BuiltinKey == key && t.ProfileID == profileID {
			return true
		}
	}
	return false
}

// NewTaskID 生成任务 ID（`task_` + 12 位十六进制）。
func NewTaskID() string {
	return "task_" + randomHex(12)
}

// randomHex 生成 n 字节的十六进制串。
func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand 失败是极端情况；退化成时间戳派生值，
		// 仍能保证同一次调用内不重复（调用方会再查重）。
		return fmt.Sprintf("%024x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
