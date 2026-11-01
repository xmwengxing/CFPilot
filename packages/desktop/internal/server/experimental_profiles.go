package server

// 网络档案的状态与管理接口。
//
// ## 为什么需要这一层
//
// 自适应采样是**实验性能力**：它改变候选生成，代价是「用户看不见它在干什么」。
// 这一层提供三件事：
//
//  1. 状态：当前档案是什么、攒了多少样本、权重能不能用（样本不足会退回全局先验）；
//  2. 管理：列出 / 重命名 / 删除档案（地区写法不同会分裂出多个档案，必须能清理）；
//  3. 错配提醒：档案太久没用，通常意味着换了网络环境，历史结论已经不可信。

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

// 档案管理用到的错误。
var (
	errNoProfileStore  = errors.New("没有可用的网络档案库")
	errProfileNotFound = errors.New("找不到该网络档案")
)

// profileStageStat 是某一阶段的累计样本。
type profileStageStat struct {
	Attempts  float64 `json:"attempts"`
	Successes float64 `json:"successes"`
}

// profileStatusView 是给界面看的档案状态。
type profileStatusView struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	ISP     string `json:"isp"`
	Region  string `json:"region"`
	Access  string `json:"access"`
	Current bool   `json:"current"`
	// Stages 是各阶段（tcp / tls / ws）的累计样本。
	Stages map[string]profileStageStat `json:"stages"`
	// PrefixCount 是有观测记录的前缀（/24）数量。
	PrefixCount int `json:"prefixCount"`
	// LastUpdated 是最近一次观测时间。
	LastUpdated string `json:"lastUpdated,omitempty"`
	// LastUsedAt 是最近一次使用该档案做优选的时间。
	LastUsedAt string `json:"lastUsedAt,omitempty"`
	// EnoughSamples 表示样本是否足以影响权重。
	EnoughSamples bool `json:"enoughSamples"`
	// Notice 是给用户的一句话说明（样本不足 / 久未使用 / 一切正常）。
	Notice string `json:"notice"`
	// IdleDays 是距离上次使用过去的天数（用于错配提醒）。
	IdleDays int `json:"idleDays"`
}

// enoughSampleThreshold 是「样本足以影响权重」的门槛。
//
// 为什么是 20：Beta 平滑的先验折算成 8 个虚拟样本，
// 少于 20 个真实样本时，历史对权重的影响不足两成，改了也像没改。
const enoughSampleThreshold = 20

// staleProfileDays 是「该档案可能已过期」的天数。
const staleProfileDays = 3

// ispLabel 把运营商代码翻成可读名称。
func ispLabel(isp string) string {
	switch strings.ToLower(strings.TrimSpace(isp)) {
	case "ct":
		return "中国电信"
	case "cu":
		return "中国联通"
	case "cm":
		return "中国移动"
	default:
		return "其他网络"
	}
}

// accessLabel 把接入类型翻成可读名称。
func accessLabel(access string) string {
	switch strings.ToLower(strings.TrimSpace(access)) {
	case "mobile":
		return "移动网络"
	case "fixed":
		return "固定宽带"
	default:
		return "未知接入"
	}
}

// profileLabel 生成档案的可读名称。
func profileLabel(p scan.NetworkProfile) string {
	parts := []string{ispLabel(p.ISP)}
	if p.Region != "" {
		parts = append(parts, p.Region)
	}
	parts = append(parts, accessLabel(p.Access))
	return strings.Join(parts, " · ")
}

// buildProfileStatus 计算某个档案的状态视图。
func buildProfileStatus(p scan.NetworkProfile, observations []scan.PrefixObservation, current bool, now time.Time) profileStatusView {
	view := profileStatusView{
		ID:      p.ID,
		Label:   profileLabel(p),
		ISP:     p.ISP,
		Region:  p.Region,
		Access:  p.Access,
		Current: current,
		Stages:  map[string]profileStageStat{},
	}
	prefixes := map[string]bool{}
	total := 0
	for _, o := range observations {
		stat := view.Stages[o.Stage]
		stat.Attempts += o.Attempts
		stat.Successes += o.Successes
		view.Stages[o.Stage] = stat
		prefixes[o.Prefix] = true
		total += int(o.Attempts)
		if o.UpdatedAt.After(mustParseTime(view.LastUpdated)) {
			view.LastUpdated = o.UpdatedAt.UTC().Format(time.RFC3339)
		}
	}
	view.PrefixCount = len(prefixes)
	if !p.LastUsedAt.IsZero() {
		view.LastUsedAt = p.LastUsedAt.UTC().Format(time.RFC3339)
		view.IdleDays = int(now.Sub(p.LastUsedAt).Hours() / 24)
	}
	view.EnoughSamples = total >= enoughSampleThreshold
	switch {
	case total == 0:
		view.Notice = "还没有任何观测样本，权重按全局先验计算"
	case !view.EnoughSamples:
		view.Notice = "样本不足 " + itoa(total) + "/" + itoa(enoughSampleThreshold) + "，权重仍以全局先验为主"
	case view.IdleDays >= staleProfileDays:
		view.Notice = "该档案已 " + itoa(view.IdleDays) + " 天没用了；若你换了网络，请新建档案或修正地区"
	default:
		view.Notice = "样本充足，已按本机网络历史调整采样权重"
	}
	return view
}

// mustParseTime 解析时间字符串，失败时返回零值。
func mustParseTime(value string) time.Time {
	if value == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}
	}
	return t
}

// itoa 把整数转成字符串（避免为一个数字引入 strconv 的额外依赖说明）。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	buf := [12]byte{}
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// currentProfileID 返回当前设置对应的档案 ID（未启用时为空）。
func (s *Server) currentProfileID() string {
	settings := normalizeExperimental(s.Settings().Experimental)
	if !settings.AdaptiveSampling {
		return ""
	}
	profile := scan.NewNetworkProfile(scan.NetworkProfile{
		ISP:    settings.ISP,
		Region: settings.Region,
		Access: settings.Access,
		Family: "ipv4",
		Source: "manual",
	})
	return profile.ID
}

// profileStatus 返回当前档案与全部档案的状态。
func (s *Server) profileStatus() (profileStatusView, []profileStatusView) {
	now := time.Now().UTC()
	current := s.currentProfileID()
	store := s.loadProfileStore()
	if store == nil {
		return profileStatusView{}, nil
	}
	byProfile := map[string][]scan.PrefixObservation{}
	for _, o := range store.AllObservations() {
		byProfile[o.ProfileID] = append(byProfile[o.ProfileID], o)
	}
	ids := make([]string, 0, len(store.Profiles))
	for id := range store.Profiles {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	views := make([]profileStatusView, 0, len(ids))
	var currentView profileStatusView
	for _, id := range ids {
		view := buildProfileStatus(store.Profiles[id], byProfile[id], id == current, now)
		views = append(views, view)
		if id == current {
			currentView = view
		}
	}
	return currentView, views
}

// handleExperimentalProfiles 列出 / 重命名 / 删除网络档案。
//
//	GET    → 全部档案 + 当前档案状态
//	PUT    → 重命名（改地区等维度）→ 档案 ID 变化，观测一并迁移
//	DELETE → 删除档案及其观测
func (s *Server) handleExperimentalProfiles(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		current, list := s.profileStatus()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "current": current, "profiles": list})
	case http.MethodPut:
		var body struct {
			ID     string `json:"id"`
			ISP    string `json:"isp"`
			Region string `json:"region"`
			Access string `json:"access"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
			return
		}
		if err := s.renameProfile(body.ID, body.ISP, body.Region, body.Access); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case http.MethodDelete:
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "缺少 id 参数"})
			return
		}
		if err := s.deleteProfile(id); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET/PUT/DELETE"})
	}
}

// renameProfile 修改档案维度并迁移观测。
//
// 改了维度 → 档案 ID 会变；观测必须跟着迁移，否则样本会丢。
func (s *Server) renameProfile(id, isp, region, access string) error {
	store := s.loadProfileStore()
	if store == nil {
		return errNoProfileStore
	}
	old, ok := store.Profiles[id]
	if !ok {
		return errProfileNotFound
	}
	next := scan.NewNetworkProfile(scan.NetworkProfile{
		ISP:        isp,
		Region:     region,
		Access:     access,
		Family:     old.Family,
		Source:     old.Source,
		Confidence: old.Confidence,
		LastUsedAt: old.LastUsedAt,
	})
	if next.ID == id {
		return nil // 没变化
	}
	store.RenameProfile(id, next)
	return store.Save(s.profileStorePath())
}

// deleteProfile 删除档案及其观测。
func (s *Server) deleteProfile(id string) error {
	store := s.loadProfileStore()
	if store == nil {
		return errNoProfileStore
	}
	if _, ok := store.Profiles[id]; !ok {
		return errProfileNotFound
	}
	store.DeleteProfile(id)
	return store.Save(s.profileStorePath())
}
