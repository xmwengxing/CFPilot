package schedule

import (
	"fmt"
	"net"
	"sort"
	"strings"
	"time"
)

// 定时优选结果的本地 IP 池。
//
// ## 与「外部候选池」的区别
//
// ~/.cfpilot/external-candidates.json 是**外部数据源发现的入口候选**
// （发现 + 轻量校验，尚未测速），本池是**定时优选跑出来的精选结果**
// （已过完整三阶校验与测速）。两者用途不同，不混用。
//
// ## 去重键 = IP
//
// 同一个 IP 再次入池 ⇒ 整条覆盖为最新一轮的记录。
// 池因此始终反映「最近一次测到的这些 IP 的质量」，
// 不会出现同一个 IP 在池里躺着一条三天前的旧数据。
//
// ## 条目带 ProfileID
//
// 池里可能同时躺着多个账号的任务结果。回填要打到**各自账号**的控制面
// （数据面没有面板接口），所以归属账号必须逐条记。

// PoolEntry 是池里的一条 IP 记录。
type PoolEntry struct {
	// IP 是优选出来的地址（纯 IP，不含端口）。
	IP string `json:"ip"`
	// Port 是端口（默认 443）。
	Port int `json:"port"`
	// ProfileID 是产出这条记录的账号。
	ProfileID string `json:"profileId"`
	// TaskID / TaskName 是来源任务。
	TaskID   string `json:"taskId"`
	TaskName string `json:"taskName"`
	// Speed 是稳态下行速度（MB/s）。
	Speed float64 `json:"speed"`
	// Latency 是握手延迟（毫秒）。
	Latency int64 `json:"latency"`
	// Colo 是边缘机房三字码。
	Colo string `json:"colo"`
	// Family 是地址族：v4 / v6。
	Family string `json:"family"`
	// Remark 是回填 / 复制用的备注（形如 `IPv4_SJC圣何塞_12_35.5`）。
	//
	// 入池时由调用方用既有的 preferredRemark 生成 —— 备注格式只有一处定义，
	// 本包不重复实现（格式漂移会让面板的 parseScannerRemark 认不出备注，
	// 机房 / 延迟 / 速度三列全空）。
	Remark string `json:"remark"`
	// At 是最近一次入池时刻（毫秒）。
	At int64 `json:"at"`
}

// AddEntries 把一批结果并入池。
//
// 同 IP 覆盖（保留最新一轮的数据），返回入池后的总条数与本次新增条数。
func AddEntries(pool []PoolEntry, incoming []PoolEntry) ([]PoolEntry, int) {
	index := make(map[string]int, len(pool))
	out := make([]PoolEntry, 0, len(pool)+len(incoming))
	for _, e := range pool {
		key := poolKey(e.IP)
		if _, dup := index[key]; dup {
			continue
		}
		index[key] = len(out)
		out = append(out, e)
	}
	added := 0
	for _, e := range incoming {
		key := poolKey(e.IP)
		if idx, ok := index[key]; ok {
			out[idx] = e
			continue
		}
		index[key] = len(out)
		out = append(out, e)
		added++
	}
	return out, added
}

// RemoveEntries 从池里移除指定 IP（返回移除后的池与移除条数）。
func RemoveEntries(pool []PoolEntry, ips []string) ([]PoolEntry, int) {
	drop := make(map[string]bool, len(ips))
	for _, ip := range ips {
		drop[poolKey(ip)] = true
	}
	out := make([]PoolEntry, 0, len(pool))
	removed := 0
	for _, e := range pool {
		if drop[poolKey(e.IP)] {
			removed++
			continue
		}
		out = append(out, e)
	}
	return out, removed
}

// poolKey 是池内的去重键。
//
// IP 字面量先按 IP 解析再归一 —— 只做小写化**不够**：
// `2606:4700:0000::1` 与 `2606:4700::1` 是同一个地址但写法不同，
// 字符串比较会把它们当成两条，池里就会出现「重复 IP」。
// net.ParseIP + String() 会归一成同一形式。
// 解析不了（不是 IP 字面量）时退回小写化。
func poolKey(ip string) string {
	s := strings.ToLower(strings.TrimSpace(ip))
	if parsed := net.ParseIP(s); parsed != nil {
		return parsed.String()
	}
	return s
}

// SortPool 按「速度降序、延迟升序」排序，让池顶部的就是最好的。
func SortPool(pool []PoolEntry) {
	sort.SliceStable(pool, func(i, j int) bool {
		if pool[i].Speed != pool[j].Speed {
			return pool[i].Speed > pool[j].Speed
		}
		return pool[i].Latency < pool[j].Latency
	})
}

// CopyLines 返回可复制 / 可回填的行（`IP:Port#备注`）。
//
// 备注用条目里存好的 Remark（入池时由既有的 preferredRemark 生成），
// 本包不自己拼 —— 备注格式只有一处定义，重复实现必然漂移。
func CopyLines(entries []PoolEntry) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		host := e.IP
		// IPv6 字面量带端口时必须加方括号，否则 `2606:4700::1:443` 会被
		// 解析成「地址 2606:4700::1，端口 443」以外的东西。
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
		port := e.Port
		if port <= 0 {
			port = 443
		}
		out = append(out, fmt.Sprintf("%s:%d#%s", host, port, e.Remark))
	}
	return out
}

// NowMS 返回当前时刻（毫秒）。
func NowMS() int64 { return time.Now().UnixMilli() }

func nowMS() int64 { return time.Now().UnixMilli() }
