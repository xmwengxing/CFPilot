package server

// 定时优选任务的 HTTP 接口。
//
//	window.cfpilot.listScheduledTasks()      → GET    /api/schedule/tasks
//	window.cfpilot.createScheduledTask(p)     → POST   /api/schedule/tasks
//	window.cfpilot.updateScheduledTasks(p)    → PUT    /api/schedule/tasks
//	window.cfpilot.deleteScheduledTasks(ids)  → DELETE /api/schedule/tasks
//	window.cfpilot.listScheduledPool()        → GET    /api/schedule/pool
//	window.cfpilot.pushScheduledPool(...)     → POST   /api/schedule/pool/push
//	window.cfpilot.deleteScheduledPool(ips)   → DELETE /api/schedule/pool
//
// ## 归属账号
//
// 任务归属**当前激活账号**（s.store.Active()）。
// 创建时把账号 id 写死进任务，之后切换账号，页面切到新账号的任务，
// 旧账号的任务仍按其归属账号的凭据运行 —— 绝不回落活跃账号。
//
// ## 冲突校验
//
// 运行时刻的 30 分钟窗口内不得有其它任务运行。
// 判定范围是**全部账号**的全部启用任务：桌面版同一时刻只允许一个扫描
// （互斥锁是进程级的），带宽也是全机共享的 —— 跨账号挨太近同样会撞车。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/schedule"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/store"
)

// registerScheduleRoutes 挂载定时任务路由。
func (s *Server) registerScheduleRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/schedule/tasks", s.guard(s.handleScheduleTasks))
	mux.HandleFunc("/api/schedule/pool", s.guard(s.handleSchedulePool))
	mux.HandleFunc("/api/schedule/pool/push", s.guard(s.handleSchedulePoolPush))
}

// scheduleStore 返回定时任务的本地存储。
//
// 目录取凭据库目录（~/.cfpilot-gui），与优选历史、网络档案同级。
func (s *Server) scheduleStore() *schedule.Store {
	return schedule.New(s.store.DirPath())
}

// accountInfo 是界面上显示的归属账号信息。
type accountInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	AccountName string `json:"accountName"`
	Active      bool   `json:"active"`
}

// currentAccount 返回当前激活账号的展示信息。
func (s *Server) currentAccount() (accountInfo, *store.Profile) {
	p, err := s.store.Active()
	if err != nil || p == nil {
		return accountInfo{}, nil
	}
	return accountInfo{
		ID:          p.ID,
		Name:        p.Name,
		AccountName: p.AccountName,
		Active:      true,
	}, p
}

// handleScheduleTasks 处理任务清单的增删改查。
func (s *Server) handleScheduleTasks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleScheduleTasksList(w)
	case http.MethodPost:
		s.handleScheduleTasksCreate(w, r)
	case http.MethodPut:
		s.handleScheduleTasksUpdate(w, r)
	case http.MethodDelete:
		s.handleScheduleTasksDelete(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET / POST / PUT / DELETE"})
	}
}

// handleScheduleTasksList 返回当前账号的任务清单。
//
// 首次访问某账号时会物化它的 5 条内置任务（落盘一次）。
func (s *Server) handleScheduleTasksList(w http.ResponseWriter) {
	account, profile := s.currentAccount()
	if profile == nil {
		// 没有账号是**正常状态**（用户还没添加），不是错误 ——
		// 用 hint 而不是 error，界面直接显示提示即可。
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"account": nil,
			"tasks":   []schedule.Task{},
			"hint":    "还没有账号，请先在「凭据」页添加",
		})
		return
	}
	st := s.scheduleStore()
	// 物化内置任务（已存在则不动）。
	_ = st.UpdateTasks(func(tasks []schedule.Task) []schedule.Task {
		builtin := schedule.BuiltinTasks(tasks, profile.ID, time.Now())
		if len(builtin) == 0 {
			return nil
		}
		return append(tasks, builtin...)
	})
	tasks := st.Tasks()
	// 只返回当前账号的任务。
	own := make([]schedule.Task, 0, len(tasks))
	for _, t := range tasks {
		if t.ProfileID == profile.ID {
			own = append(own, t)
		}
	}
	sort.SliceStable(own, func(i, j int) bool {
		// 内置任务排前面，其余按创建时间倒序。
		if own[i].Builtin != own[j].Builtin {
			return own[i].Builtin
		}
		return own[i].CreatedAt > own[j].CreatedAt
	})
	running, lastRun, lastError := s.sched.status()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"account": account,
		"tasks":   own,
		"scheduler": map[string]any{
			"running":   running,
			"lastRun":   lastRun,
			"lastError": lastError,
		},
		// 启用数上限（见 schedule.MaxEnabledPerAccount）—— 界面要显示出来，
		// 否则用户只能等保存失败才知道有这个限制。
		"enabledCount": schedule.EnabledCount(own, profile.ID),
		"enabledLimit": schedule.MaxEnabledPerAccount,
	})
}

// taskCreateRequest 是新建任务的请求体。
type taskCreateRequest struct {
	Name         string              `json:"name"`
	Description  string              `json:"description"`
	IntervalDays int                 `json:"intervalDays"`
	RunAt        string              `json:"runAt"`
	MinSpeedMBps float64             `json:"minSpeedMBps"`
	Scan         schedule.ScanParams `json:"scan"`
}

// handleScheduleTasksCreate 新建任务。
func (s *Server) handleScheduleTasksCreate(w http.ResponseWriter, r *http.Request) {
	account, profile := s.currentAccount()
	if profile == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "account": nil, "tasks": []schedule.Task{},
			"hint": "还没有账号，请先在「凭据」页添加",
		})
		return
	}
	var req taskCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体解析失败"})
		return
	}
	now := schedule.NowMS()
	task := schedule.Task{
		ID:           schedule.NewTaskID(),
		Name:         strings.TrimSpace(req.Name),
		Description:  strings.TrimSpace(req.Description),
		ProfileID:    profile.ID,
		Enabled:      true,
		IntervalDays: req.IntervalDays,
		RunAt:        strings.TrimSpace(req.RunAt),
		MinSpeedMBps: req.MinSpeedMBps,
		Scan:         req.Scan,
		AnchorAt:     now,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if task.IntervalDays < schedule.MinIntervalDays {
		task.IntervalDays = schedule.MinIntervalDays
	}
	if task.Scan.Sample <= 0 {
		task.Scan.Sample = schedule.BuiltinSample
	}
	if task.Scan.Top <= 0 {
		task.Scan.Top = schedule.BuiltinTop
	}
	if task.Scan.SpeedMode == "" {
		task.Scan.SpeedMode = "two"
	}
	if task.Scan.SpeedDurationMs <= 0 {
		task.Scan.SpeedDurationMs = 6000
	}
	if task.Scan.SpeedConnections <= 0 {
		task.Scan.SpeedConnections = 8
	}
	if task.Scan.ProbeTransport == "" {
		task.Scan.ProbeTransport = "ws"
	}
	st := s.scheduleStore()
	if msg := task.Validate(); msg != "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": msg})
		return
	}
	// 启用数上限：同一账号最多 3 个启用中的任务（见 MaxEnabledPerAccount）。
	projected := append(append([]schedule.Task{}, st.Tasks()...), task)
	if n := schedule.EnabledCount(projected, profile.ID); n > schedule.MaxEnabledPerAccount {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": false,
			"error": fmt.Sprintf("同一账号最多只能启用 %d 个定时任务（当前 %d 个）—— "+
				"定时优选是无人值守跑的，任务太多会让本机 IP 的行为看起来像批量扫描器",
				schedule.MaxEnabledPerAccount, n),
		})
		return
	}
	// 冲突校验：与全部账号的启用任务比。
	if hit, ok := schedule.HasConflict(st.Tasks(), task); ok {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": s.conflictMessage(hit),
			"conflict": map[string]any{
				"id":    hit.ID,
				"name":  hit.Name,
				"runAt": hit.RunAt,
			},
		})
		return
	}
	var created schedule.Task
	_ = st.UpdateTasks(func(tasks []schedule.Task) []schedule.Task {
		created = task
		return append(tasks, task)
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "task": created, "account": account})
}

// taskUpdateRequest 是批量修改任务的请求体。
//
// ⚠️ 用指针区分「没传这个字段」与「传了 0」——
// 批量套用时空白字段必须保持原值，不能被抹平成 0。
type taskUpdateRequest struct {
	IDs          []string `json:"ids"`
	Name         *string  `json:"name"`
	Description  *string  `json:"description"`
	IntervalDays *int     `json:"intervalDays"`
	RunAt        *string  `json:"runAt"`
	MinSpeedMBps *float64 `json:"minSpeedMBps"`
	Enabled      *bool    `json:"enabled"`
}

// handleScheduleTasksUpdate 批量修改任务（多选后「保存应用」）。
func (s *Server) handleScheduleTasksUpdate(w http.ResponseWriter, r *http.Request) {
	_, profile := s.currentAccount()
	if profile == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "tasks": []schedule.Task{},
			"hint": "还没有账号，请先在「凭据」页添加",
		})
		return
	}
	var req taskUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体解析失败"})
		return
	}
	if len(req.IDs) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "没有选中任何任务"})
		return
	}
	st := s.scheduleStore()
	all := st.Tasks()
	updated := make([]schedule.Task, 0, len(req.IDs))
	for _, id := range req.IDs {
		for _, t := range all {
			if t.ID != id {
				continue
			}
			next := t
			if req.Name != nil {
				next.Name = strings.TrimSpace(*req.Name)
			}
			if req.Description != nil {
				next.Description = strings.TrimSpace(*req.Description)
			}
			if req.IntervalDays != nil {
				next.IntervalDays = *req.IntervalDays
			}
			if req.RunAt != nil {
				next.RunAt = strings.TrimSpace(*req.RunAt)
			}
			if req.MinSpeedMBps != nil {
				next.MinSpeedMBps = *req.MinSpeedMBps
			}
			if req.Enabled != nil {
				next.Enabled = *req.Enabled
			}
			updated = append(updated, next)
			break
		}
	}
	if len(updated) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "选中的任务不存在"})
		return
	}
	// 内置任务禁止改名 —— 名字（亚洲组_IPv4）本身就是它在扫什么的唯一线索。
	if req.Name != nil {
		for _, t := range updated {
			if !schedule.CanRename(t) {
				writeJSON(w, http.StatusOK, map[string]any{
					"ok":    false,
					"error": "内置任务不能改名 —— 名称里的地址族与地区就是它的用途说明",
				})
				return
			}
		}
	}
	for _, t := range updated {
		if msg := t.Validate(); msg != "" {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": msg})
			return
		}
	}
	// 启用数上限：把改动套用上去之后，该账号的启用任务数不能超过 3。
	projected := make([]schedule.Task, 0, len(all))
	replaced := map[string]bool{}
	for _, u := range updated {
		replaced[u.ID] = true
	}
	for _, o := range all {
		if replaced[o.ID] {
			continue
		}
		projected = append(projected, o)
	}
	projected = append(projected, updated...)
	if n := schedule.EnabledCount(projected, profile.ID); n > schedule.MaxEnabledPerAccount {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": false,
			"error": fmt.Sprintf("同一账号最多只能启用 %d 个定时任务（当前 %d 个）—— "+
				"定时优选是无人值守跑的，任务太多会让本机 IP 的行为看起来像批量扫描器",
				schedule.MaxEnabledPerAccount, n),
		})
		return
	}
	// 冲突校验：把每个目标任务的新时刻与「除它自己以外」的全部启用任务比。
	//
	// 用 projected（已套用本次改动）而不是改动前的列表 ——
	// 同一批里被启用的任务也要参与判定。
	for _, t := range updated {
		others := make([]schedule.Task, 0, len(projected))
		for _, o := range projected {
			if o.ID != t.ID {
				others = append(others, o)
			}
		}
		if hit, ok := schedule.HasConflict(others, t); ok {
			writeJSON(w, http.StatusOK, map[string]any{
				"ok":    false,
				"error": s.conflictMessage(hit),
				"conflict": map[string]any{
					"id":    hit.ID,
					"name":  hit.Name,
					"runAt": hit.RunAt,
				},
			})
			return
		}
	}
	// 批量内部也要互不冲突（两个选中任务被改成同一时刻）。
	for i := range updated {
		for j := range updated {
			if i >= j {
				continue
			}
			if hit, ok := schedule.HasConflict([]schedule.Task{updated[j]}, updated[i]); ok {
				writeJSON(w, http.StatusOK, map[string]any{
					"ok":    false,
					"error": s.conflictMessage(hit),
				})
				return
			}
		}
	}
	now := schedule.NowMS()
	_ = st.UpdateTasks(func(tasks []schedule.Task) []schedule.Task {
		for i := range tasks {
			for _, u := range updated {
				if tasks[i].ID == u.ID {
					tasks[i] = u
					tasks[i].UpdatedAt = now
				}
			}
		}
		return tasks
	})
	out := make([]schedule.Task, 0, len(updated))
	for _, t := range updated {
		out = append(out, t)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tasks": out})
}

// handleScheduleTasksDelete 删除任务（内置任务不可删）。
func (s *Server) handleScheduleTasksDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体解析失败"})
		return
	}
	if len(req.IDs) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "没有选中任何任务"})
		return
	}
	st := s.scheduleStore()
	drop := map[string]bool{}
	for _, id := range req.IDs {
		drop[id] = true
	}
	var skipped []map[string]string
	deleted := 0
	_ = st.UpdateTasks(func(tasks []schedule.Task) []schedule.Task {
		out := make([]schedule.Task, 0, len(tasks))
		for _, t := range tasks {
			if !drop[t.ID] {
				out = append(out, t)
				continue
			}
			if t.Builtin {
				skipped = append(skipped, map[string]string{
					"id":     t.ID,
					"reason": "内置任务不可删除",
				})
				out = append(out, t)
				continue
			}
			deleted++
		}
		return out
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"deleted": deleted,
		"skipped": skipped,
	})
}

// conflictMessage 生成冲突提示（写明是哪个账号的哪个任务）。
func (s *Server) conflictMessage(hit schedule.Task) string {
	label := hit.Name
	if p, err := s.store.Get(hit.ProfileID); err == nil && p != nil {
		acct := strings.TrimSpace(p.Name)
		if acct == "" {
			acct = strings.TrimSpace(p.AccountName)
		}
		if acct != "" {
			label = acct + " / " + hit.Name
		}
	}
	return fmt.Sprintf("与「%s」（%s）冲突：运行时刻需相隔 %d 分钟以上",
		label, hit.RunAt, schedule.ConflictWindowMin)
}

// handleSchedulePool 返回本地优选 IP 池。
func (s *Server) handleSchedulePool(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		entries := s.scheduleStore().Pool()
		schedule.SortPool(entries)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "entries": entries})
	case http.MethodDelete:
		s.handleSchedulePoolDelete(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET / DELETE"})
	}
}

// handleSchedulePoolDelete 从池里移除条目。
func (s *Server) handleSchedulePoolDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IPs []string `json:"ips"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体解析失败"})
		return
	}
	if len(req.IPs) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "没有选中任何 IP"})
		return
	}
	st := s.scheduleStore()
	removed := 0
	_ = st.UpdatePool(func(cur []schedule.PoolEntry) []schedule.PoolEntry {
		next, n := schedule.RemoveEntries(cur, req.IPs)
		removed = n
		return next
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": removed})
}

// handleSchedulePoolPush 把选中的池内条目回填到面板。
//
// 按条目归属账号分组：每个账号用**它自己的**凭据解析控制面域名与面板密码。
// 混在一起回填会把 A 账号的 IP 写进 B 账号的订阅。
func (s *Server) handleSchedulePoolPush(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Entries []schedule.PoolEntry `json:"entries"`
		Mode    string               `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体解析失败"})
		return
	}
	if len(req.Entries) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "没有选中任何 IP"})
		return
	}
	mode := req.Mode
	if mode != "append" {
		mode = "replace"
	}

	// 按账号分组。
	groups := map[string][]schedule.PoolEntry{}
	for _, e := range req.Entries {
		groups[e.ProfileID] = append(groups[e.ProfileID], e)
	}

	total := 0
	var firstErr string
	for profileID, items := range groups {
		n, err := s.pushPoolToPanel(r.Context(), profileID, items, mode)
		total += n
		if err != nil && firstErr == "" {
			firstErr = err.Error()
		}
	}
	if firstErr != "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": firstErr, "count": total})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "count": total, "mode": mode})
}

// pushPoolToPanel 把一批条目回填到某个账号的面板。
func (s *Server) pushPoolToPanel(ctx context.Context, profileID string, entries []schedule.PoolEntry, mode string) (int, error) {
	profile, err := s.store.Get(profileID)
	if err != nil || profile == nil {
		return 0, fmt.Errorf("归属账号已不存在")
	}
	if strings.TrimSpace(profile.CfToken) == "" {
		return 0, fmt.Errorf("归属账号没有 API Token")
	}
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()

	manifest, host, password := s.resolvePanelAccess(ctx, profile)
	if host == "" {
		return 0, fmt.Errorf("清单里没有控制面域名，请先完成一次部署")
	}
	if password == "" && manifest != nil {
		password = strings.TrimSpace(manifest.Credentials.PanelPassword)
	}
	if password == "" {
		password = strings.TrimSpace(profile.PanelPassword)
	}
	if password == "" {
		return 0, fmt.Errorf("找不到面板密码，请先在部署页填写并保存")
	}

	// 现取一次性令牌（10 分钟有效，点按钮时才取不会过期）。
	tok := scan.FetchScannerToken(ctx, host, password, 25*time.Second)
	if !tok.OK {
		return 0, fmt.Errorf("%s", tok.Error)
	}
	lines := schedule.CopyLines(entries)
	res := scan.PostResults(ctx, scan.DefaultCallbackURL(host), tok.Token, lines, mode, 20*time.Second)
	if !res.OK {
		return 0, fmt.Errorf("%s", res.Error)
	}
	s.logLevel(fmt.Sprintf("已回填 %d 条到面板的「手动优选 IP」（%s）", len(lines), mode), "ok")
	return len(lines), nil
}
