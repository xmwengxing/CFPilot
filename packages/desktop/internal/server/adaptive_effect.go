package server

// 自适应效果 A/B 对照。
//
// ## 为什么需要它
//
// 「按网络档案学习网段权重」到底有没有收益，只有**同一网络环境**下
// 开启与关闭各跑一轮、比较分阶段通过率才能答得准。
//
// 跨省、跨运营商的样本外部拿不到，但**同机同网络的前后对照**随时可以做 ——
// 这也是把实验性能力转成正式功能前唯一可靠的验收依据。
//
// ## 口径
//
// 只比较**同一档案、同一域名**的会话；样本不足时明确说「样本不足」，不给结论。

import (
	"net/http"
	"sort"
	"strings"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/history"
)

// effectSide 是一侧（开启 / 关闭）的聚合结果。
type effectSide struct {
	// Runs 是参与统计的轮数。
	Runs int `json:"runs"`
	// AvgCandidates 是平均候选数。
	AvgCandidates float64 `json:"avgCandidates"`
	// TCPRate / TLSRate / WSRate 是阶段通过率（0~1）。
	TCPRate float64 `json:"tcpRate"`
	TLSRate float64 `json:"tlsRate"`
	WSRate  float64 `json:"wsRate"`
	// AvgNodes 是平均可用节点数。
	AvgNodes float64 `json:"avgNodes"`
	// AvgElapsedMs 是平均耗时。
	AvgElapsedMs int64 `json:"avgElapsedMs"`
	// LastAt 是最近一轮的时间。
	LastAt string `json:"lastAt,omitempty"`
}

// effectView 是一次 A/B 对照的结果。
type effectView struct {
	OK        bool        `json:"ok"`
	ProfileID string      `json:"profileId"`
	Profile   string      `json:"profile"`
	Enabled   effectSide  `json:"enabled"`
	Disabled  effectSide  `json:"disabled"`
	Notice    string      `json:"notice"`
	Recent    []effectRun `json:"recent"`
}

// effectRun 是最近若干轮的明细（界面画趋势用）。
type effectRun struct {
	At       string  `json:"at"`
	Adaptive bool    `json:"adaptive"`
	TCPRate  float64 `json:"tcpRate"`
	WSRate   float64 `json:"wsRate"`
	Nodes    int     `json:"nodes"`
}

// minEffectRuns 是给出结论所需的最少轮数。
const minEffectRuns = 2

// handleAdaptiveEffect 返回同网络环境下的自适应 A/B 对照。
func (s *Server) handleAdaptiveEffect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET/POST"})
		return
	}
	profileID := strings.TrimSpace(r.URL.Query().Get("profileId"))
	if profileID == "" {
		profileID = s.currentProfileID()
	}
	list, err := s.historyStore().Load()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "读取历史失败：" + err.Error()})
		return
	}

	// 只取同一档案、同一域名的会话 —— 换了域名或档案就不是同一实验了。
	//
	// 域名按「**会话数最多**的那个」选，而不是第一条：
	// 历史里往往混着别的域名（换过域名做优选），用第一条会让对照失真。
	hostCount := map[string]int{}
	hostAt := map[string]string{}
	for _, sess := range list {
		if sess.Stats == nil || sess.Stats.Candidates <= 0 {
			continue
		}
		if profileID != "" && sess.NetworkProfileID != profileID {
			continue
		}
		hostCount[sess.Host]++
		if sess.At > hostAt[sess.Host] {
			hostAt[sess.Host] = sess.At
		}
	}
	host := ""
	for name, count := range hostCount {
		if host == "" || count > hostCount[host] || (count == hostCount[host] && hostAt[name] > hostAt[host]) {
			host = name
		}
	}
	var sessions []history.Session
	for _, sess := range list {
		if sess.Stats == nil || sess.Stats.Candidates <= 0 {
			continue
		}
		if profileID != "" && sess.NetworkProfileID != profileID {
			continue
		}
		if sess.Host != host {
			continue
		}
		sessions = append(sessions, sess)
	}
	if len(sessions) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":     true,
			"notice": "还没有带统计的历史会话（升级前的记录没有分阶段统计）",
		})
		return
	}

	view := effectView{OK: true, ProfileID: profileID, Recent: []effectRun{}}
	for _, sess := range sessions {
		side := &view.Disabled
		if sess.Adaptive {
			side = &view.Enabled
		}
		addSide(side, sess)
		view.Recent = append(view.Recent, effectRun{
			At:       sess.At,
			Adaptive: sess.Adaptive,
			TCPRate:  ratio(sess.Stats.TCPOK, sess.Stats.Candidates),
			WSRate:   ratio(sess.Stats.WSOK, sess.Stats.Candidates),
			Nodes:    sess.Stats.SpeedOK,
		})
	}
	sort.Slice(view.Recent, func(i, j int) bool { return view.Recent[i].At > view.Recent[j].At })
	if len(view.Recent) > 20 {
		view.Recent = view.Recent[:20]
	}
	if view.ProfileID != "" {
		view.Profile = s.profileLabelOf(view.ProfileID)
	}
	finalize(&view.Enabled)
	finalize(&view.Disabled)
	switch {
	case view.Enabled.Runs == 0 || view.Disabled.Runs == 0:
		view.Notice = "需要开启与关闭各至少 1 轮才能对照（当前：" +
			itoa(view.Enabled.Runs) + " 开 / " + itoa(view.Disabled.Runs) + " 关）"
	case view.Enabled.Runs < minEffectRuns || view.Disabled.Runs < minEffectRuns:
		view.Notice = "样本仍偏少（开启 " + itoa(view.Enabled.Runs) + " 轮 / 关闭 " + itoa(view.Disabled.Runs) + " 轮），结论仅供参考"
	default:
		view.Notice = "开启 " + itoa(view.Enabled.Runs) + " 轮 / 关闭 " + itoa(view.Disabled.Runs) + " 轮，可对照"
	}
	writeJSON(w, http.StatusOK, view)
}

// addSide 把一轮会话累加进某一侧的统计。
func addSide(side *effectSide, sess history.Session) {
	st := sess.Stats
	side.Runs++
	side.AvgCandidates += float64(st.Candidates)
	side.TCPRate += ratio(st.TCPOK, st.Candidates)
	side.TLSRate += ratio(st.TLSOK, st.Candidates)
	side.WSRate += ratio(st.WSOK, st.Candidates)
	side.AvgNodes += float64(st.SpeedOK)
	side.AvgElapsedMs += st.ElapsedMs
	if sess.At > side.LastAt {
		side.LastAt = sess.At
	}
}

// finalize 把累加值换算成平均值。
func finalize(side *effectSide) {
	if side.Runs == 0 {
		return
	}
	n := float64(side.Runs)
	side.AvgCandidates /= n
	side.TCPRate /= n
	side.TLSRate /= n
	side.WSRate /= n
	side.AvgNodes /= n
	side.AvgElapsedMs /= int64(n)
}

// ratio 计算比例（分母为 0 时返回 0）。
func ratio(part, total int) float64 {
	if total <= 0 {
		return 0
	}
	return float64(part) / float64(total)
}

// profileLabelOf 返回档案的可读名称（找不到时返回空串）。
func (s *Server) profileLabelOf(profileID string) string {
	store := s.loadProfileStore()
	if store == nil {
		return ""
	}
	p, ok := store.Profiles[profileID]
	if !ok {
		return ""
	}
	return profileLabel(p)
}
