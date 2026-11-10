// Package schedule 实现桌面版的「定时优选任务」。
//
// ## 职责边界
//
// 本包只管**数据**：任务定义、内置任务、冲突判定、周期计算与落盘。
// 执行（跑扫描、解析部署清单、回填）留给 internal/server 的调度器 ——
// 那边才有凭据库、扫描互斥锁与 KV 访问能力。
//
// 放在独立包而不是塞进 internal/server，是为了能脱离 Server 单测：
// 周期计算涉及夏令时与跨月跨年，没有网络依赖才好把边界都钉死。
//
// ## 为什么任务归属账号而不是全局
//
// 一次优选要用**数据面域名**做 TLS SNI，回填要用**控制面域名**与面板密码，
// 两者都在某个 Cloudflare 账号的部署清单里。所以任务必须记住所属账号
// （ProfileID），运行时用**该账号**的凭据去解析 ——
// 绝不能回落活跃账号，否则多账号场景下会串号回填。
//
// ## 与「外部候选池」的区别
//
// ~/.cfpilot/external-candidates.json 是「外部数据源发现的入口 IP 候选」
// （发现 + 轻量校验），本包管理的 ~/.cfpilot-gui/scheduled-ip-pool.json
// 是「定时优选跑出来的精选结果」。两者用途不同，不混用。
package schedule

import (
	"fmt"
	"strings"
	"time"
)

// 任务状态（LastStatus）。
const (
	// StatusOK 表示上一轮正常跑完。
	StatusOK = "ok"
	// StatusFailed 表示上一轮失败（凭据缺失、部署不存在等）。
	StatusFailed = "failed"
	// StatusSkipped 表示上一轮因故没跑（与其它扫描冲突、错过时间窗）。
	StatusSkipped = "skipped"
	// StatusRelaxed 表示跑完了，但国家筛选没命中、结果被放宽为全量。
	StatusRelaxed = "relaxed"
)

// 内置任务的身份键（BuiltinKey）。
//
// 与展示名分离：用户可以改内置任务的名字，但它的「扫什么」
// （地址族 + 国家）由这个键决定，改名不影响身份。
const (
	BuiltinCFAll  = "CF_ALL"
	BuiltinAsiaV4 = "ASIA_V4"
	BuiltinAsiaV6 = "ASIA_V6"
	BuiltinUSV4   = "US_V4"
	BuiltinUSV6   = "US_V6"
)

// 内置任务的默认参数。
const (
	// BuiltinSample 是内置任务的候选采样数。
	//
	// ⚠️ 为什么不是优选页面的 6556：
	// 6556 采样一轮约上万次边缘握手、约 1GB 流量，而内置任务是
	// **无人值守每天自动跑**的 —— 这个量级会把本机 IP 的行为画像
	// 推向「批量扫描器」那一侧。1500 与桌面版既有的后台任务
	// （一键优选 runQuickScanFor）同口径，是「后台自动跑」该用的量级。
	BuiltinSample = 1500
	// BuiltinTop 是内置任务默认保留的节点数。
	BuiltinTop = 8
	// BuiltinIntervalDays 是内置任务默认周期（天）。
	BuiltinIntervalDays = 2
)

// MinIntervalDays 是运行周期的最小值（天）。
//
// 低于 2 天的自动扫描太频繁，对本机网络与平台侧都是不必要的压力。
const MinIntervalDays = 2

// ConflictWindowMin 是运行时刻之间的最小间隔（分钟）。
//
// 两个任务的运行时刻靠得太近会同时抢占扫描互斥锁与带宽 ——
// 机器同一时刻只能跑一个扫描，第二个要么被推迟要么被跳过。
const ConflictWindowMin = 30

// MaxEnabledPerAccount 是同一账号最多可**启用**的定时任务数。
//
// ## 为什么限 3 个
//
// 定时优选是**无人值守**跑的：每个启用中的任务到点都会做一轮
// 「采样 → TLS 握手 → WS 101 校验 → 测速」，每轮对上万个 Cloudflare
// 边缘 IP 发起握手。三个任务同时启用、周期又短（本项目最小 2 天），
// 就等于每天从本机 IP 打出好几轮「对全网 CF 节点做批量握手」——
// 这正是风控侧最容易识别的扫描器特征。
//
// 限 3 个是保守值：够一个账号同时跑「全网段 + 亚洲组 + 美国组」，
// 又不至于把流量堆到不可控。禁用的任务不计入（它不会跑）。
const MaxEnabledPerAccount = 3

// ScanParams 是任务创建时从优选页面表单抓取的**优选参数快照**。
//
// ## 为什么是快照而不是运行时读表单
//
// 优选参数在任务清单里是**只读**的（改不了，要改就删了重建），
// 所以它必须随任务一起固化下来 —— 否则表单一变，历史任务的口径就悄悄变了。
//
// ## 为什么不存 host / wsPath
//
// 数据面域名与 WS 路径属于**部署实例**，任务归属账号，
// 运行时从该账号的部署清单与 KV CONFIG 现取 ——
// 这样重新部署后任务自动跟着新路径走，不用重建任务。
type ScanParams struct {
	// Family 是地址族：auto / v4 / v6 / both。
	Family string `json:"family"`
	// Countries 是国家 / 地区过滤。
	//
	// 元素可以是分组关键字（"ASIA" / "US"）或国家码；
	// 空切片 = 不过滤。展开成机房码由 scan.ExpandCountryFilter 负责。
	Countries []string `json:"countries"`
	// Sample 是候选采样数。
	Sample int `json:"sample"`
	// Top 是最终保留的节点数。
	Top int `json:"top"`
	// SpeedMode 是测速档位：two（两轮）/ one（仅精测）/ off（跳过测速）。
	SpeedMode string `json:"speedMode"`
	// SpeedDurationMs 是单候选测速时长（毫秒）。
	SpeedDurationMs int `json:"speedDurationMs"`
	// SpeedConnections 是每个候选的并发连接数。
	SpeedConnections int `json:"speedConnections"`
	// ProbeTransport 是探测传输：ws / xhttp / both。
	ProbeTransport string `json:"probeTransport"`
}

// Task 是一条定时优选任务。
type Task struct {
	// ID 是稳定标识（`task_` + 12 位十六进制）。
	ID string `json:"id"`
	// Name 是任务名称。
	Name string `json:"name"`
	// Description 是任务说明（可选）。
	Description string `json:"description,omitempty"`
	// Builtin 表示这是内置任务（不可删除）。
	Builtin bool `json:"builtin"`
	// BuiltinKey 是内置任务的身份键（仅内置任务有值）。
	BuiltinKey string `json:"builtinKey,omitempty"`
	// ProfileID 是归属账号的 ID。
	ProfileID string `json:"profileId"`
	// Enabled 表示任务是否参与调度。
	Enabled bool `json:"enabled"`
	// IntervalDays 是运行周期（天），最小 MinIntervalDays。
	IntervalDays int `json:"intervalDays"`
	// RunAt 是运行时刻（本地时间 "HH:MM"）。
	RunAt string `json:"runAt"`
	// MinSpeedMBps 是下行速度下限（MB/s）：稳态速度低于它的候选淘汰。0 = 不过滤。
	MinSpeedMBps float64 `json:"minSpeedMBps"`
	// Scan 是优选参数快照（只读展示）。
	Scan ScanParams `json:"scan"`
	// AnchorAt 是周期锚点（创建时刻，毫秒）。
	//
	// 运行日 = 与锚点同余 IntervalDays 的日子。锚点让「每 N 天」
	// 有明确的起点，而不是「从今天数起第 N 天」那样随保存时间漂移。
	AnchorAt int64 `json:"anchorAt"`
	// LastRunAt 是上一轮实际开跑的时刻（毫秒）。
	LastRunAt int64 `json:"lastRunAt,omitempty"`
	// LastHost 是上一轮实际用的数据面域名。
	//
	// 运行期从**该账号的部署清单**取（用户不需要手动填）。
	// 记下来是为了让用户能确认「任务跑的是哪个实例」——
	// 重新部署换了域名后，这里能看出变化。
	LastHost string `json:"lastHost,omitempty"`
	// LastStatus 是上一轮的状态（StatusOK / StatusFailed / …）。
	LastStatus string `json:"lastStatus,omitempty"`
	// LastMessage 是上一轮的一句话说明。
	LastMessage string `json:"lastMessage,omitempty"`
	// LastCount 是上一轮入池的 IP 条数。
	LastCount int `json:"lastCount,omitempty"`
	// CreatedAt / UpdatedAt 是创建 / 修改时刻（毫秒）。
	CreatedAt int64 `json:"createdAt"`
	UpdatedAt int64 `json:"updatedAt"`
}

// Validate 校验任务参数，返回可直接展示给用户的一句话错误（空串 = 合法）。
func (t Task) Validate() string {
	if strings.TrimSpace(t.Name) == "" {
		return "任务名称不能为空"
	}
	if len([]rune(t.Name)) > 40 {
		return "任务名称不能超过 40 个字"
	}
	if len([]rune(t.Description)) > 200 {
		return "任务说明不能超过 200 个字"
	}
	if strings.TrimSpace(t.ProfileID) == "" {
		return "任务必须归属一个账号"
	}
	if t.IntervalDays < MinIntervalDays {
		return fmt.Sprintf("运行周期不能小于 %d 天", MinIntervalDays)
	}
	if _, _, err := parseRunAt(t.RunAt); err != nil {
		return "运行时间格式应为 00:00 - 23:59"
	}
	if t.MinSpeedMBps < 0 {
		return "速度过滤不能为负数"
	}
	if t.MinSpeedMBps > 0 && t.Scan.SpeedMode == "off" {
		return "设了速度过滤就不能用「跳过测速」—— 没有速度值可用于筛选"
	}
	return ""
}

// EnabledCount 返回某账号下**启用中**的任务数。
//
// 禁用的任务不计入 —— 它不会跑，不构成风控压力。
func EnabledCount(tasks []Task, profileID string) int {
	n := 0
	for _, t := range tasks {
		if t.ProfileID == profileID && t.Enabled {
			n++
		}
	}
	return n
}

// CanRename 判断任务能不能改名。
//
// 内置任务的名字由它的身份（BuiltinKey）决定 ——
// 「亚洲组_IPv4」这个名字本身就是用户理解它在扫什么的唯一线索，
// 改成别的名字就再也看不出它扫的是哪一组了。所以内置任务禁止改名。
func CanRename(t Task) bool {
	return !t.Builtin
}

// IsDue 判断任务在 now 时刻是否处于「该跑」的窗口内。
//
// 窗口 = [运行时刻, 运行时刻 + ConflictWindowMin)。
//
// 为什么要一个窗口而不是「恰好等于运行时刻」：
// 调度器每分钟醒一次，不可能卡在秒级命中；而扫描互斥锁被占用时
// 这一轮要能推迟重试 —— 窗口就是给重试留的余地。
// 窗口过了就跳过该轮（不补跑），避免开机后连着补好几轮。
func (t Task) IsDue(now time.Time) bool {
	if !t.Enabled {
		return false
	}
	occ := t.LastOccurrence(now)
	if occ.IsZero() {
		return false
	}
	if now.Before(occ) {
		return false
	}
	return now.Sub(occ) < ConflictWindowMin*time.Minute
}

// HasRun 判断该轮是否已经跑过。
//
// 判据是「上一轮开跑时刻 >= 本轮运行时刻」。
func (t Task) HasRun(now time.Time) bool {
	occ := t.LastOccurrence(now)
	if occ.IsZero() {
		return false
	}
	return t.LastRunAt >= occ.UnixMilli()
}

// parseRunAt 解析 "HH:MM"，返回小时与分钟。
func parseRunAt(s string) (int, int, error) {
	s = strings.TrimSpace(s)
	if len(s) != 5 || s[2] != ':' {
		return 0, 0, fmt.Errorf("运行时间格式应为 HH:MM")
	}
	hh, err := parseDigits(s[0:2])
	if err != nil {
		return 0, 0, err
	}
	mm, err := parseDigits(s[3:5])
	if err != nil {
		return 0, 0, err
	}
	if hh > 23 || mm > 59 {
		return 0, 0, fmt.Errorf("运行时间超出 00:00-23:59")
	}
	return hh, mm, nil
}

// parseDigits 把两位数字串解析成整数。
func parseDigits(s string) (int, error) {
	if len(s) != 2 {
		return 0, fmt.Errorf("数字段长度应为 2")
	}
	n := 0
	for i := 0; i < 2; i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("含非数字字符")
		}
		n = n*10 + int(c-'0')
	}
	return n, nil
}

// minuteOfDay 把 "HH:MM" 换算成当天第几分钟。
//
// 解析失败时返回 -1（调用方据此跳过该任务，不让它参与排班）。
func minuteOfDay(s string) int {
	hh, mm, err := parseRunAt(s)
	if err != nil {
		return -1
	}
	return hh*60 + mm
}

// ringDistance 返回两个「当天第几分钟」之间的环上距离（分钟）。
//
// 环上而不是直线：23:50 与 00:10 只差 20 分钟，不是 1420 分钟。
func ringDistance(a, b int) int {
	d := a - b
	if d < 0 {
		d = -d
	}
	if d > 720 {
		d = 1440 - d
	}
	return d
}

// HasConflict 判断 candidate 与既有任务是否运行时刻冲突。
//
// ## 判定规则
//
// **两个都在启用状态**、且运行时刻的环上距离小于 ConflictWindowMin ⇒ 冲突。
//
// 禁用的任务不参与判定：它不会跑，谈不上撞车。
//
// ⚠️ 候选任务自身的启用状态同样要看：禁用中的任务改时间不该被拦 ——
// 用户可能是先调好参数、之后再启用。等它被启用时（PUT 请求）会再判一次。
//
// ## 判定范围：全部账号
//
// 桌面版同一时刻只允许一个扫描（互斥锁是进程级的），带宽也是全机共享的 ——
// 所以两个**不同账号**的任务挨得太近同样会撞车。跨账号也判冲突。
//
// ## 只看时刻，不看周期
//
// 两个任务即使周期不同、运行日不重合，只要时刻挨得太近，
// 用户看到的排班就是「两个任务挤在一起」，而实际运行时仍会互相顶掉。
// 按时刻判定换来的是**可预期的排班**与**可解释的报错**。
func HasConflict(tasks []Task, candidate Task) (Task, bool) {
	if !candidate.Enabled {
		return Task{}, false
	}
	a := minuteOfDay(candidate.RunAt)
	if a < 0 {
		return Task{}, false
	}
	for _, t := range tasks {
		if t.ID == candidate.ID || !t.Enabled {
			continue
		}
		b := minuteOfDay(t.RunAt)
		if b < 0 {
			continue
		}
		if ringDistance(a, b) < ConflictWindowMin {
			return t, true
		}
	}
	return Task{}, false
}
