package schedule

import (
	"time"
)

// 周期计算：任务在什么时刻跑。
//
// ## 为什么不用 time.Duration 除 24 小时
//
// `t.Sub(anchor).Hours() / 24` 在有夏令时的时区会算错 ——
// 有一天是 23 小时、有一天是 25 小时，除出来不是整数，
// 「每 2 天」的余数判断会漂。
// 所以这里用**民用日序号**（days since epoch，纯整数运算）算日期差。
//
// ## 锚点语义
//
// AnchorAt 是任务创建时刻。运行日 = 与锚点同余 IntervalDays 的日子：
//
//	锚点 2026-11-10 10:00，周期 2 天，运行时刻 09:00
//	→ 运行日 11-10 / 11-12 / 11-14 …
//	→ 创建当天 09:00 已过，首跑落在 11-12 09:00
//
// 锚点让「每 N 天」有明确起点，不会因为保存 / 编辑任务而漂移。

// dayNumber 返回该日期距 1970-01-01 的天数（民用日，纯整数）。
//
// 用经典的 civil-from-days 算法（Hinnant），不做时区换算 ——
// 入参必须是本地日历日期。
func dayNumber(y int, m time.Month, d int) int {
	yy := y
	if m <= 2 {
		yy--
	}
	era := yy / 400
	if yy < 0 {
		era = (yy - 399) / 400
	}
	yoe := yy - era*400
	mp := int(m) - 3
	if mp < 0 {
		mp += 12
	}
	doy := (153*mp+2)/5 + d - 1
	doe := yoe*365 + yoe/4 - yoe/100 + doy
	return era*146097 + doe - 719468
}

// dateFromDayNumber 是 dayNumber 的逆运算，返回该日的本地零点。
func dateFromDayNumber(z int) time.Time {
	zz := z + 719468
	era := zz / 146097
	if zz < 0 {
		era = (zz - 146096) / 146097
	}
	doe := zz - era*146097
	yoe := (doe - doe/1460 + doe/36524 - doe/146096) / 365
	yy := yoe + era*400
	doy := doe - (365*yoe + yoe/4 - yoe/100)
	mp := (5*doy + 2) / 153
	d := doy - (153*mp+2)/5 + 1
	m := time.Month(mp + 3)
	if mp >= 10 {
		m = time.Month(mp - 9)
	}
	if m <= 2 {
		yy++
	}
	return time.Date(yy, m, d, 0, 0, 0, 0, time.UTC)
}

// occurrenceOn 计算某个民用日序号上的运行时刻（本地时区）。
func occurrenceOn(day int, hh, mm int, loc *time.Location) time.Time {
	base := dateFromDayNumber(day)
	// dateFromDayNumber 返回 UTC 零点，这里取它的日历日期再按本地时区重建，
	// 保证「哪一天」这个语义不受时区影响。
	y, m, d := base.Date()
	return time.Date(y, m, d, hh, mm, 0, 0, loc)
}

// anchorDayNumber 返回锚点所在的民用日序号。
func anchorDayNumber(t Task, loc *time.Location) int {
	a := time.UnixMilli(t.AnchorAt).In(loc)
	y, m, d := a.Date()
	return dayNumber(y, m, d)
}

// offsetDays 返回 from 相对 to 相差的天数（可为负）。
func offsetDays(to, from int) int {
	return from - to
}

// modDays 返回 a 在模 n 意义下的余数（结果恒为非负）。
func modDays(a, n int) int {
	if n <= 0 {
		return 0
	}
	r := a % n
	if r < 0 {
		r += n
	}
	return r
}

// occurrenceOnOrAfter 返回不早于 from 的最近一次运行时刻。
//
// 找不到（理论上不会，搜索窗口足够大）时返回零值。
func (t Task) occurrenceOnOrAfter(from time.Time, loc *time.Location) time.Time {
	hh, mm, err := parseRunAt(t.RunAt)
	if err != nil {
		return time.Time{}
	}
	interval := t.IntervalDays
	if interval < MinIntervalDays {
		interval = MinIntervalDays
	}
	anchor := anchorDayNumber(t, loc)
	fy, fm, fd := from.Date()
	base := dayNumber(fy, fm, fd)

	// 最多往后找 400 天：周期再大也够覆盖一个完整周期。
	for i := 0; i <= 400; i++ {
		day := base + i
		if modDays(offsetDays(anchor, day), interval) != 0 {
			continue
		}
		cand := occurrenceOn(day, hh, mm, loc)
		if cand.Before(from) {
			continue
		}
		return cand
	}
	return time.Time{}
}

// LastOccurrence 返回不晚于 now 的最近一次运行时刻。
//
// 调度器用它判断「这一轮是否该跑」以及「是否已经跑过」。
func (t Task) LastOccurrence(now time.Time) time.Time {
	loc := now.Location()
	hh, mm, err := parseRunAt(t.RunAt)
	if err != nil {
		return time.Time{}
	}
	interval := t.IntervalDays
	if interval < MinIntervalDays {
		interval = MinIntervalDays
	}
	anchor := anchorDayNumber(t, loc)
	ny, nm, nd := now.Date()
	base := dayNumber(ny, nm, nd)

	// 从当天往回找，最多回溯 400 天。
	for i := 0; i <= 400; i++ {
		day := base - i
		if modDays(offsetDays(anchor, day), interval) != 0 {
			continue
		}
		cand := occurrenceOn(day, hh, mm, loc)
		if cand.After(now) {
			continue
		}
		return cand
	}
	return time.Time{}
}

// NextOccurrence 返回 now 之后的下一次运行时刻。
func (t Task) NextOccurrence(now time.Time) time.Time {
	return t.occurrenceOnOrAfter(now, now.Location())
}
