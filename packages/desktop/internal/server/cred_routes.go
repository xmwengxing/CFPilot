package server

// 本文件实现「账户类」API。
//
// ## 与 Electron 版的对应关系
//
// 界面上调用的 `window.cfpilot.xxx()` 在 Go 版里变成
// `fetch('/api/cred/xxx')`。方法名与入参出参必须严格对齐，
// 否则界面会在某个分支上静默失效（渲染层没有类型检查，只会在运行时炸）。
//
// ## 一条铁律：Token 明文绝不出后端
//
// 所有返回给界面的结构都是 ProfileView（只有 hasToken 布尔值）。
// 界面上的 Token 输入框永远是空的、只放 placeholder。
// 这样即使界面被注入脚本，也拿不到凭据。

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/store"
)

// registerCredRoutes 挂载账户相关路由。
func (s *Server) registerCredRoutes(mux *http.ServeMux) {
	// 凭据状态（对应 renderer 的 credentialsState）
	mux.HandleFunc("/api/cred/state", s.guard(s.handleCredState))
	// 保存当前账户的 Token / 密码（对应 saveCredentials）
	mux.HandleFunc("/api/cred/save", s.guard(s.handleCredSave))
	// 清除本机凭据（对应 wipeCredentials）
	mux.HandleFunc("/api/cred/wipe", s.guard(s.handleCredWipe))

	// 多账户（对应 listProfiles / createProfile / updateProfile /
	// deleteProfile / switchProfile / currentProfile）
	mux.HandleFunc("/api/profile/list", s.guard(s.handleProfileList))
	mux.HandleFunc("/api/profile/create", s.guard(s.handleProfileCreate))
	mux.HandleFunc("/api/profile/update", s.guard(s.handleProfileUpdate))
	mux.HandleFunc("/api/profile/delete", s.guard(s.handleProfileDelete))
	mux.HandleFunc("/api/profile/switch", s.guard(s.handleProfileSwitch))
	mux.HandleFunc("/api/profile/current", s.guard(s.handleProfileCurrent))
}

// handleCredState 返回凭据状态。
//
// 对应 Electron 的 credentialsState()：
//
//	{ hasToken: boolean; accountId: string; kvNamespaceId: string }
//
// 注意：只返回「是否已保存」，绝不返回 Token 明文。
func (s *Server) handleCredState(w http.ResponseWriter, r *http.Request) {
	p, err := s.store.Active()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if p == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"hasToken":      false,
			"accountId":     "",
			"kvNamespaceId": "",
			"hasPanelPw":    false,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"hasToken":      strings.TrimSpace(p.CfToken) != "",
		"accountId":     p.AccountID,
		"accountName":   p.AccountName,
		"kvNamespaceId": p.KVNamespaceID,
		"hasPanelPw":    p.PanelPassword != "",
	})
}

// credSaveRequest 是保存凭据的请求体。
//
// 字段都用指针：区分「没传」与「传了空串」。
// 没传的字段不动，传空串表示清空。
//
// ⚠️ `name` 也必须在这里 —— 界面的「更新账户」接口会同时传 name，
// 少了这个字段会让改名静默失效（json 解码直接丢掉未知字段，
// 不报错也不提示，表现为「点了保存但名字没变」）。
type credSaveRequest struct {
	Name          *string `json:"name"`
	CfToken       *string `json:"cfToken"`
	AccountID     *string `json:"accountId"`
	AccountName   *string `json:"accountName"`
	KVNamespaceID *string `json:"kvNamespaceId"`
	PanelPassword *string `json:"panelPassword"`
}

// handleCredSave 保存当前账户的凭据。
func (s *Server) handleCredSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req credSaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}

	updated, err := s.store.SaveActive(store.Patch{
		CfToken:       req.CfToken,
		AccountID:     req.AccountID,
		AccountName:   req.AccountName,
		KVNamespaceID: req.KVNamespaceID,
		PanelPassword: req.PanelPassword,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "profile": updated.View()})
}

// handleCredWipe 清除本机全部凭据（移到 .bak，可找回）。
func (s *Server) handleCredWipe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	if err := s.store.Clear(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":   true,
		"note": "凭据已清除（原文件移到 secrets.json.bak，需要时可手动恢复）",
	})
}

// handleProfileList 列出全部账户（不含 Token 明文）。
func (s *Server) handleProfileList(w http.ResponseWriter, r *http.Request) {
	views, err := s.store.ListViews()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	activeID, err := s.store.ActiveID()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"profiles": views,
		"activeId": activeID,
	})
}

// handleProfileCreate 新建账户。
func (s *Server) handleProfileCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req struct {
		Name string `json:"name"`
		// 可选：建的时候直接把 Token 一起带上（界面「新建账户」就是这么用的）
		CfToken   *string `json:"cfToken"`
		AccountID *string `json:"accountId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}

	var init *store.Profile
	if req.CfToken != nil || req.AccountID != nil {
		init = &store.Profile{}
		if req.CfToken != nil {
			init.CfToken = *req.CfToken
		}
		if req.AccountID != nil {
			init.AccountID = *req.AccountID
		}
	}

	p, err := s.store.Create(req.Name, init)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "profile": p.View()})
}

// handleProfileUpdate 更新指定账户。
func (s *Server) handleProfileUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req struct {
		ID string `json:"id"`
		credSaveRequest
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}
	if strings.TrimSpace(req.ID) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "缺少 id"})
		return
	}

	p, err := s.store.Update(req.ID, store.Patch{
		Name:          req.Name,
		CfToken:       req.CfToken,
		AccountID:     req.AccountID,
		AccountName:   req.AccountName,
		KVNamespaceID: req.KVNamespaceID,
		PanelPassword: req.PanelPassword,
	})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "profile": p.View()})
}

// handleProfileDelete 删除指定账户。
func (s *Server) handleProfileDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}

	deleted, activeID, err := s.store.Delete(req.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deleted":  deleted,
		"activeId": activeID,
	})
}

// handleProfileSwitch 切换激活账户。
func (s *Server) handleProfileSwitch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}

	ok, activeID, err := s.store.SetActive(req.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": ok, "activeId": activeID})
}

// handleProfileCurrent 返回当前账户。
func (s *Server) handleProfileCurrent(w http.ResponseWriter, r *http.Request) {
	p, err := s.store.Active()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if p == nil {
		writeJSON(w, http.StatusOK, map[string]any{"profile": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": p.View()})
}
