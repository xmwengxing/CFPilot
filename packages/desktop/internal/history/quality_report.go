package history

import (
	"errors"
	"math"
	"net"
	"sort"
	"strconv"
	"time"
)

// QualityField 只有 available 才有 value；未执行和未实现不得伪装成零分。
type QualityField struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Value  any    `json:"value,omitempty"`
	Reason string `json:"reason,omitempty"`
}
type QualityBasic struct {
	TCPMs  *int64 `json:"tcpMs"`
	Status string `json:"status"`
}
type QualityProtocol struct {
	TLSMs        *int64 `json:"tlsMs"`
	WSOK         *bool  `json:"wsOk"`
	PongOK       *bool  `json:"pongOk"`
	RealTunnelOK *bool  `json:"realTunnelOk"`
}
type QualityPerformance struct {
	SpeedMBps    *float64 `json:"speedMBps"`
	PeakMBps     *float64 `json:"peakMBps"`
	StabilityP95 *float64 `json:"stabilityP95"`
	Jitter       *float64 `json:"jitter"`
}
type QualityEgress struct {
	Transport  string `json:"transport,omitempty"`
	RemoteIP   string `json:"remoteIp,omitempty"`
	ObservedAt string `json:"observedAt,omitempty"`
	AgeMs      *int64 `json:"ageMs,omitempty"`
	EgressKind string `json:"egressKind,omitempty"`
	Colo       string `json:"colo,omitempty"`
	Status     string `json:"status"`
}
type CompatibilityTarget struct {
	URLLabel          string `json:"urlLabel"`
	Status            string `json:"status"`
	HTTPStatus        *int   `json:"httpStatus,omitempty"`
	ChallengeHeader   string `json:"challengeHeader,omitempty"`
	Ms                *int64 `json:"ms,omitempty"`
	ExpectedContentOK *bool  `json:"expectedContentOk,omitempty"`
	Error             string `json:"error,omitempty"`
}
type QualityCompatibility struct {
	Targets []CompatibilityTarget `json:"targets"`
	Status  string                `json:"status"`
}
type QualityTrendPoint struct {
	At        string   `json:"at"`
	SessionID string   `json:"sessionId"`
	Kind      string   `json:"kind"`
	OK        bool     `json:"ok"`
	LatencyMs *int64   `json:"latencyMs"`
	TLSMs     *int64   `json:"tlsMs"`
	SpeedMBps *float64 `json:"speedMBps"`
	// TCPMs 是该次观测的 TCP 建连耗时（毫秒）。
	//
	// 单独保留它，是因为 P95 / 抖动必须建立在**同一个指标**上：
	// 优选记录的是 101 握手延迟，复测记录的是 TCP 延迟，
	// 混在一起算离散度会得到没有意义的数字。
	TCPMs *int64 `json:"tcpMs,omitempty"`
}
type QualityHistory struct {
	FirstSeen   string              `json:"firstSeen"`
	LastSeen    string              `json:"lastSeen"`
	TestCount   int                 `json:"testCount"`
	SuccessRate float64             `json:"successRate"`
	Trend       []QualityTrendPoint `json:"trend"`
}
type QualityReport struct {
	Version          int                  `json:"version"`
	GeneratedAt      string               `json:"generatedAt"`
	IP               string               `json:"ip"`
	Port             int                  `json:"port"`
	Colo             string               `json:"colo"`
	City             string               `json:"city"`
	Source           string               `json:"source"`
	NetworkProfileID string               `json:"networkProfileId"`
	Basic            QualityBasic         `json:"basic"`
	Protocol         QualityProtocol      `json:"protocol"`
	Performance      QualityPerformance   `json:"performance"`
	Egress           QualityEgress        `json:"egress"`
	Compatibility    QualityCompatibility `json:"compatibility"`
	History          QualityHistory       `json:"history"`
	Fields           []QualityField       `json:"fields"`
}

// minSamplesForSpread 是计算离散度（P95 / 抖动）所需的最少样本数。
//
// 样本太少时 P95 几乎等于最大值，给出数字反而误导；宁可显示「样本不足」。
const minSamplesForSpread = 3

// percentile95 用最近秩法返回样本的 95 分位。
func percentile95(values []float64) (float64, bool) {
	if len(values) == 0 {
		return 0, false
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	index := int(math.Ceil(0.95*float64(len(sorted)))) - 1
	if index < 0 {
		index = 0
	}
	if index >= len(sorted) {
		index = len(sorted) - 1
	}
	return sorted[index], true
}

// spreadRange 返回样本的最大值与最小值之差（抖动）。
func spreadRange(values []float64) (float64, bool) {
	if len(values) == 0 {
		return 0, false
	}
	low, high := values[0], values[0]
	for _, v := range values {
		if v < low {
			low = v
		}
		if v > high {
			high = v
		}
	}
	return high - low, true
}

// QualityReport 仅聚合已保存证据，不发起请求，也不将 WS101 推断为 PONG 或真实隧道。
// 历史成功率只覆盖被保留的优选和复测样本，不代表所有候选通过率。
func (s *Store) QualityReport(sessionID, ip string, port int) (*QualityReport, error) {
	list, err := s.Load()
	if err != nil {
		return nil, err
	}
	return BuildQualityReport(list, sessionID, ip, port, time.Now().UTC())
}
func BuildQualityReport(list []Session, sessionID, ip string, port int, now time.Time) (*QualityReport, error) {
	var selected *Session
	var entry *Entry
	for i := range list {
		if list[i].ID == sessionID {
			selected = &list[i]
			for j := range list[i].Entries {
				e := &list[i].Entries[j]
				if sameTarget(e.IP, e.Port, ip, port) {
					entry = e
					break
				}
			}
			break
		}
	}
	if selected == nil || entry == nil {
		return nil, errors.New("未找到指定历史 IP")
	}
	r := &QualityReport{Version: 1, GeneratedAt: now.UTC().Format(time.RFC3339Nano), IP: entry.IP, Port: entry.Port, Colo: entry.Colo, City: entry.City, Source: selected.Source, NetworkProfileID: selected.NetworkProfileID, Basic: QualityBasic{Status: "not_run"}, Egress: QualityEgress{Status: "not-run"}, Compatibility: QualityCompatibility{Targets: []CompatibilityTarget{}, Status: "not_run"}, History: QualityHistory{Trend: []QualityTrendPoint{}}, Fields: []QualityField{}}
	// 优选快照里已经带 TCP 耗时与测速峰值（历史条目由 scan.Entry 落库）。
	r.Protocol.TLSMs = &entry.TLSMs
	yes := true
	r.Protocol.WSOK = &yes
	if !selected.SkipSpeed {
		r.Performance.SpeedMBps = &entry.Speed
	}
	if entry.TCPMs > 0 {
		tcp := entry.TCPMs
		r.Basic = QualityBasic{TCPMs: &tcp, Status: "available"}
	}
	if entry.PeakSpeed > 0 {
		peak := entry.PeakSpeed
		r.Performance.PeakMBps = &peak
	}
	if entry.LastTest != nil {
		t := entry.LastTest
		// 复测的 TCP 耗时比优选快照更近，优先用它。
		if t.TCPMs > 0 {
			tcp := t.TCPMs
			r.Basic = QualityBasic{TCPMs: &tcp, Status: "available"}
		} else if r.Basic.Status == "not_run" {
			r.Basic.Status = "failed"
		}
		r.Protocol.TLSMs = &t.TLSMs
		r.Protocol.WSOK = &t.WSOK
		if !t.OK && t.TCPMs <= 0 {
			r.Basic.Status = "failed"
		}
		if t.WithSpeed {
			r.Performance.SpeedMBps = &t.Speed
		}
		if t.PeakSpeed > 0 {
			peak := t.PeakSpeed
			r.Performance.PeakMBps = &peak
		}
		if t.Colo != "" {
			r.Colo = t.Colo
		}
	}
	for _, sess := range list {
		// 不同 SNI、协议路径或网络档案的样本不合并，避免把不同通路视为同一质量。
		if sess.Host != selected.Host || sess.WSPath != selected.WSPath || sess.ProbePath != selected.ProbePath || sess.NetworkProfileID != selected.NetworkProfileID {
			continue
		}
		for _, e := range sess.Entries {
			if !sameTarget(e.IP, e.Port, ip, port) {
				continue
			}
			p := QualityTrendPoint{At: sess.At, SessionID: sess.ID, Kind: "scan", OK: true, LatencyMs: &e.Latency, TLSMs: &e.TLSMs}
			if e.TCPMs > 0 {
				tcp := e.TCPMs
				p.TCPMs = &tcp
			}
			if !sess.SkipSpeed {
				p.SpeedMBps = &e.Speed
			}
			r.History.Trend = append(r.History.Trend, p)
			tests := e.Tests
			if len(tests) == 0 && e.LastTest != nil {
				tests = []LastTest{*e.LastTest}
			}
			for _, t := range tests {
				p := QualityTrendPoint{At: t.At, SessionID: sess.ID, Kind: "retest", OK: t.OK, LatencyMs: &t.TCPMs, TLSMs: &t.TLSMs}
				if t.TCPMs > 0 {
					tcp := t.TCPMs
					p.TCPMs = &tcp
				}
				if t.WithSpeed {
					p.SpeedMBps = &t.Speed
				}
				r.History.Trend = append(r.History.Trend, p)
			}
		}
	}
	sort.SliceStable(r.History.Trend, func(i, j int) bool {
		a, _ := time.Parse(time.RFC3339Nano, r.History.Trend[i].At)
		b, _ := time.Parse(time.RFC3339Nano, r.History.Trend[j].At)
		return a.Before(b)
	})
	r.History.TestCount = len(r.History.Trend)
	ok := 0
	for _, p := range r.History.Trend {
		if p.OK {
			ok++
		}
	}
	if r.History.TestCount > 0 {
		r.History.SuccessRate = float64(ok) / float64(r.History.TestCount)
		r.History.FirstSeen = r.History.Trend[0].At
		r.History.LastSeen = r.History.Trend[len(r.History.Trend)-1].At
	}
	add := func(name, status string, value any, reason string) {
		r.Fields = append(r.Fields, QualityField{Name: name, Status: status, Value: value, Reason: reason})
	}
	if r.Basic.TCPMs != nil {
		add("basic.tcpMs", r.Basic.Status, *r.Basic.TCPMs, "")
	} else {
		add("basic.tcpMs", "not_run", nil, "优选历史未保留 TCP 耗时，可手动复测")
	}
	tlsStatus, wsStatus, protocolReason := "available", "available", ""
	if entry.LastTest != nil && !entry.LastTest.OK {
		protocolReason = entry.LastTest.Error
		if entry.LastTest.TLSMs <= 0 {
			tlsStatus = "failed"
		}
		if !entry.LastTest.WSOK {
			wsStatus = "failed"
		}
	}
	add("protocol.tlsMs", tlsStatus, *r.Protocol.TLSMs, protocolReason)
	add("protocol.wsOk", wsStatus, *r.Protocol.WSOK, protocolReason)
	// PONG / 隧道证据取**最新一次**：复测有记录用复测，否则用优选快照。
	// 三态：nil = 未做/未跑 → not_run；&true = 通过；&false = 失败。
	// 绝不把「未做」报成失败，也绝不把 101 成功推断成 PONG/隧道通过。
	var pongEvidence *bool
	var tunnelEvidence *bool
	var tunnelStage string
	if entry.LastTest != nil {
		pongEvidence = entry.LastTest.PongVerified
		tunnelEvidence = entry.LastTest.TunnelOK
		tunnelStage = entry.LastTest.TunnelStage
	} else {
		pongEvidence = entry.PongVerified
		tunnelEvidence = entry.TunnelOK
		tunnelStage = entry.TunnelStage
	}
	if pongEvidence == nil {
		add("protocol.pongOk", "not_run", nil, "未做 PONG 校验（非严格模式、无探针端点，或从未复测）")
	} else if *pongEvidence {
		add("protocol.pongOk", "available", true, "")
		r.Protocol.PongOK = pongEvidence
	} else {
		add("protocol.pongOk", "failed", false, "PONG 校验未通过（101 通但数据面未响应）")
		r.Protocol.PongOK = pongEvidence
	}
	if tunnelEvidence == nil {
		add("protocol.realTunnelOk", "not_run", nil, "未跑真实隧道校验（未提供凭据或未测到）")
	} else if *tunnelEvidence {
		add("protocol.realTunnelOk", "available", true, "")
		r.Protocol.RealTunnelOK = tunnelEvidence
	} else {
		reason := "真实隧道校验未通过"
		if tunnelStage != "" {
			reason += "（卡在 " + tunnelStage + " 阶段）"
		}
		add("protocol.realTunnelOk", "failed", false, reason)
		r.Protocol.RealTunnelOK = tunnelEvidence
	}
	if r.Performance.SpeedMBps != nil {
		add("performance.speedMBps", "available", *r.Performance.SpeedMBps, "")
	} else {
		add("performance.speedMBps", "not_run", nil, "未执行测速")
	}
	if r.Performance.PeakMBps != nil {
		add("performance.peakMBps", "available", *r.Performance.PeakMBps, "")
	} else {
		add("performance.peakMBps", "not_run", nil, "未记录测速峰值")
	}
	// 离散度建立在**同一指标**上：TCP 建连耗时的多次观测。
	tcpSamples := make([]float64, 0, len(r.History.Trend))
	for _, p := range r.History.Trend {
		if p.TCPMs != nil && *p.TCPMs > 0 {
			tcpSamples = append(tcpSamples, float64(*p.TCPMs))
		}
	}
	if len(tcpSamples) >= minSamplesForSpread {
		if p95, valid := percentile95(tcpSamples); valid {
			r.Performance.StabilityP95 = &p95
			add("performance.stabilityP95", "available", p95, "")
		}
		if spread, valid := spreadRange(tcpSamples); valid {
			r.Performance.Jitter = &spread
			add("performance.jitter", "available", spread, "")
		}
	} else {
		reason := "样本不足：至少需要 3 次 TCP 观测才能计算离散度"
		add("performance.stabilityP95", "not_run", nil, reason)
		add("performance.jitter", "not_run", nil, reason)
	}
	if entry.QualityReport != nil {
		r.Egress = entry.QualityReport.Egress
		r.Compatibility = entry.QualityReport.Compatibility
		if r.Compatibility.Targets == nil {
			r.Compatibility.Targets = []CompatibilityTarget{}
		}
		if r.Egress.Status == "observed" {
			at, parseErr := time.Parse(time.RFC3339Nano, r.Egress.ObservedAt)
			if parseErr != nil || now.Sub(at) > 5*time.Minute || at.After(now.Add(30*time.Second)) {
				r.Egress.Status = "stale"
			}
			if parseErr == nil {
				age := now.Sub(at).Milliseconds()
				if age < 0 {
					age = 0
				}
				r.Egress.AgeMs = &age
			}
		}
	}
	egressStatus, egressReason := "not_run", "出口识别仅支持显式实验调用，未自动关联到候选 IP"
	if r.Egress.Status == "observed" {
		egressStatus, egressReason = "available", ""
	} else if r.Egress.Status == "failed" || r.Egress.Status == "stale" {
		egressStatus, egressReason = r.Egress.Status, "出口观测失败或已过期"
	}
	add("egress", egressStatus, nil, egressReason)
	compatibilityStatus := "not_run"
	if r.Compatibility.Status == "available" || r.Compatibility.Status == "failed" || r.Compatibility.Status == "stale" {
		compatibilityStatus = r.Compatibility.Status
	}
	add("compatibility", compatibilityStatus, nil, "只显示已保存目标站检测证据")
	add("history.successRate", "available", r.History.SuccessRate, "仅统计保留的优选与复测样本，不代表全部候选")
	return r, nil
}
func sameTarget(a string, ap int, b string, bp int) bool {
	return net.ParseIP(a) != nil && net.ParseIP(a).Equal(net.ParseIP(b)) && ap == bp
}

// SaveQualityReport 将独立实验报告存入指定会话；调用方不得把无绑定的出口结果关联候选。
func (s *Store) SaveQualityReport(sessionID string, report QualityReport) error {
	if report.Version != 1 || net.ParseIP(report.IP) == nil || report.Port < 1 || report.Port > 65535 {
		return errors.New("IP 质量报告无效")
	}
	historyMu.Lock()
	defer historyMu.Unlock()
	list, err := s.load()
	if err != nil {
		return err
	}
	for i := range list {
		if list[i].ID != sessionID {
			continue
		}
		for j := range list[i].Entries {
			e := &list[i].Entries[j]
			if sameTarget(e.IP, e.Port, report.IP, report.Port) {
				// 字段合并：出口与兼容性各自独立保存，互不覆盖。
				if e.QualityReport != nil {
					if report.Egress.Status == "" {
						report.Egress = e.QualityReport.Egress
					}
					if len(report.Compatibility.Targets) == 0 && report.Compatibility.Status == "" {
						report.Compatibility = e.QualityReport.Compatibility
					}
				}
				e.QualityReport = &report
				return s.write(list)
			}
		}
	}
	return errors.New("未找到报告目标 " + net.JoinHostPort(report.IP, strconv.Itoa(report.Port)))
}
