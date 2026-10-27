// Package store 实现多账户凭据的本地持久化。
//
// ## 与 Electron 版的关系
//
// 两个版本**共用同一个文件**（~/.cfpilot-gui/secrets.json）与同一套格式（v2），
// 这样用户换版本不用重填 Token。因此这里的字段名、迁移规则、边界行为
// 都必须与 packages/gui/src/main/config-store.ts 严格一致，改动前先看那边。
//
// ## 磁盘格式
//
// ```json
//
//	{
//	  "version": 2,
//	  "activeId": "acc_1a2b3c4d",
//	  "profiles": [
//	    {
//	      "id": "acc_1a2b3c4d",
//	      "name": "我的账户",
//	      "cfToken": "...",
//	      "accountId": "...",
//	      "accountName": "...",
//	      "kvNamespaceId": "...",
//	      "panelPassword": "...",
//	      "createdAt": "2026-10-26T07:00:00.000Z",
//	      "updatedAt": "2026-10-26T07:00:00.000Z"
//	    }
//	  ]
//	}
//
// ```
//
// v1（扁平结构 `{cfToken, accountId, kvNamespaceId, panelPassword}`）会在
// 首次读取时自动迁移成 v2，并立刻落盘。
package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Profile 是一份账户配置。
type Profile struct {
	// ID 是稳定标识（`acc_` + 8 位十六进制）
	ID string `json:"id"`
	// Name 是展示名，默认由账号名或账号 ID 推导
	Name string `json:"name"`
	// CfToken 是 Cloudflare API Token（敏感）
	CfToken string `json:"cfToken"`
	// AccountID 是账号 ID（非敏感，方便预填）
	AccountID string `json:"accountId"`
	// AccountName 是账号名（检测账号后自动填，用于展示）
	AccountName string `json:"accountName"`
	// KVNamespaceID 是 KV 命名空间 ID
	KVNamespaceID string `json:"kvNamespaceId"`
	// PanelPassword 是**面板密码**（敏感）。
	//
	// ## 语义
	//
	// 这个字段只用于**修改已部署面板的登录密码**，
	// **绝不参与部署时的密码设置**。
	//
	// 两个用途必须彻底分开的原因：
	//   早期两个输入框都写这个字段 ——
	//     凭据页「修改密码」→ saveCredentials({panelPassword})
	//     部署时            → opt.PanelPassword = profile.PanelPassword
	//   结果：在凭据页改了密码，下次部署的密码也跟着变，
	//   而云端环境变量是加密的，用户根本不知道自己改了部署密码。
	//
	// 现在：
	//   - 部署密码只来自**部署页**输入框，或随机生成 / 清单沿用
	//   - 这里的值只用于「登录已部署的面板去改密码」
	PanelPassword string `json:"panelPassword"`

	// DeployPanelPassword 是**部署时**要用的面板密码（与上面严格分开）。
	//
	// 只在用户于部署页显式填写时才有值。
	// 为空表示「随机生成」（首次部署）或「沿用清单里的原密码」（更新部署）。
	DeployPanelPassword string `json:"deployPanelPassword"`
	CreatedAt           string `json:"createdAt"`
	UpdatedAt           string `json:"updatedAt"`
}

// ProfileView 是给界面看的视图（**不含 Token 明文**）。
//
// 界面上永远不需要看到 Token 原文，只显示「已保存 / 未保存」。
// 这样即使界面被 XSS 注入，也拿不到凭据。
type ProfileView struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	AccountID     string `json:"accountId"`
	AccountName   string `json:"accountName"`
	KVNamespaceID string `json:"kvNamespaceId"`
	HasToken      bool   `json:"hasToken"`
	HasPanelPw    bool   `json:"hasPanelPw"`
	CreatedAt     string `json:"createdAt"`
	UpdatedAt     string `json:"updatedAt"`
}

// View 把 Profile 转成不含敏感字段的视图。
func (p Profile) View() ProfileView {
	return ProfileView{
		ID:            p.ID,
		Name:          p.Name,
		AccountID:     p.AccountID,
		AccountName:   p.AccountName,
		KVNamespaceID: p.KVNamespaceID,
		HasToken:      strings.TrimSpace(p.CfToken) != "",
		HasPanelPw:    p.PanelPassword != "",
		CreatedAt:     p.CreatedAt,
		UpdatedAt:     p.UpdatedAt,
	}
}

// file 是磁盘结构。
type file struct {
	Version  int       `json:"version"`
	ActiveID string    `json:"activeId"`
	Profiles []Profile `json:"profiles"`
}

// Store 是凭据库。
//
// Dir 可注入，便于测试用临时目录隔离（绝不碰真实用户目录）。
type Store struct {
	Dir string
}

// New 创建 Store。dir 为空时用默认目录 ~/.cfpilot-gui。
func New(dir string) *Store {
	if dir == "" {
		dir = DefaultDir()
	}
	return &Store{Dir: dir}
}

// DefaultDir 返回默认配置目录（与 Electron 版一致）。
func DefaultDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".cfpilot-gui"
	}
	return filepath.Join(home, ".cfpilot-gui")
}

func (s *Store) path() string { return filepath.Join(s.Dir, "secrets.json") }

// ---------- 读 ----------

// readFile 读取磁盘结构（含 v1 自动迁移）。
func (s *Store) readFile() (*file, error) {
	raw, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return &file{Version: 2, ActiveID: "", Profiles: []Profile{}}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取凭据失败：%w", err)
	}

	// 先看是不是 v2（有 profiles 数组）
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		// 文件损坏：当成空库，不阻塞程序启动
		return &file{Version: 2, Profiles: []Profile{}}, nil
	}
	if _, isV2 := probe["profiles"]; !isV2 {
		return s.migrateV1(raw)
	}

	var f file
	if err := json.Unmarshal(raw, &f); err != nil {
		return &file{Version: 2, Profiles: []Profile{}}, nil
	}
	f.Version = 2
	for i := range f.Profiles {
		normalizeProfile(&f.Profiles[i])
	}
	// activeId 失效时回落到第一个
	if !containsID(f.Profiles, f.ActiveID) {
		if len(f.Profiles) > 0 {
			f.ActiveID = f.Profiles[0].ID
		} else {
			f.ActiveID = ""
		}
	}
	return &f, nil
}

// migrateV1 把老扁平结构迁成 v2 并落盘。
func (s *Store) migrateV1(raw []byte) (*file, error) {
	var flat struct {
		CfToken       string `json:"cfToken"`
		AccountID     string `json:"accountId"`
		KVNamespaceID string `json:"kvNamespaceId"`
		PanelPassword string `json:"panelPassword"`
	}
	_ = json.Unmarshal(raw, &flat)

	// 与 Electron 版一致：v1 没有账号名，第一个参数传空串，
	// 让 deriveName 回落到「账户 <id 前8位>」而不是拿 accountId 当名字。
	p := blankProfile(deriveName("", flat.AccountID))
	p.CfToken = strings.TrimSpace(flat.CfToken)
	p.AccountID = strings.TrimSpace(flat.AccountID)
	p.KVNamespaceID = strings.TrimSpace(flat.KVNamespaceID)
	p.PanelPassword = flat.PanelPassword

	f := &file{Version: 2, ActiveID: p.ID, Profiles: []Profile{p}}
	if err := s.writeFile(f); err != nil {
		return f, err
	}
	return f, nil
}

// ---------- 写 ----------

func (s *Store) writeFile(f *file) error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return fmt.Errorf("创建配置目录失败：%w", err)
	}
	f.Version = 2
	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	// 原子写：先写临时文件再改名，避免写一半断电留下坏文件
	// （凭据文件损坏等于用户重新输一遍 Token，代价很高）
	tmp := s.path() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("写入凭据失败：%w", err)
	}
	return os.Rename(tmp, s.path())
}

// ---------- 对外 API ----------

// List 返回全部 profile（原始结构，供内部使用）。
func (s *Store) List() ([]Profile, error) {
	f, err := s.readFile()
	if err != nil {
		return nil, err
	}
	return f.Profiles, nil
}

// ListViews 返回不含敏感字段的视图列表。
func (s *Store) ListViews() ([]ProfileView, error) {
	ps, err := s.List()
	if err != nil {
		return nil, err
	}
	out := make([]ProfileView, 0, len(ps))
	for _, p := range ps {
		out = append(out, p.View())
	}
	return out, nil
}

// ActiveID 返回当前激活的 profile id。
func (s *Store) ActiveID() (string, error) {
	f, err := s.readFile()
	if err != nil {
		return "", err
	}
	return f.ActiveID, nil
}

// Active 返回当前激活的 profile（没有则 nil）。
func (s *Store) Active() (*Profile, error) {
	f, err := s.readFile()
	if err != nil {
		return nil, err
	}
	for i := range f.Profiles {
		if f.Profiles[i].ID == f.ActiveID {
			p := f.Profiles[i]
			return &p, nil
		}
	}
	return nil, nil
}

// Get 按 id 取 profile。
func (s *Store) Get(id string) (*Profile, error) {
	f, err := s.readFile()
	if err != nil {
		return nil, err
	}
	for i := range f.Profiles {
		if f.Profiles[i].ID == id {
			p := f.Profiles[i]
			return &p, nil
		}
	}
	return nil, nil
}

// Create 新建一份 profile 并设为激活。
func (s *Store) Create(name string, init *Profile) (*Profile, error) {
	f, err := s.readFile()
	if err != nil {
		return nil, err
	}

	label := strings.TrimSpace(name)
	if label == "" && init != nil {
		label = deriveName(init.AccountName, init.AccountID)
	}
	if label == "" {
		label = "新账户"
	}

	p := blankProfile(label)
	if init != nil {
		p.CfToken = strings.TrimSpace(init.CfToken)
		p.AccountID = strings.TrimSpace(init.AccountID)
		p.AccountName = strings.TrimSpace(init.AccountName)
		p.KVNamespaceID = strings.TrimSpace(init.KVNamespaceID)
		p.PanelPassword = init.PanelPassword
		p.DeployPanelPassword = init.DeployPanelPassword
	}

	f.Profiles = append(f.Profiles, p)
	f.ActiveID = p.ID
	if err := s.writeFile(f); err != nil {
		return nil, err
	}
	return &p, nil
}

// Patch 是 Update 的可选字段集合（nil 表示不改）。
type Patch struct {
	Name          *string
	CfToken       *string
	AccountID     *string
	AccountName   *string
	KVNamespaceID *string
	PanelPassword *string
	// DeployPanelPassword 是部署时用的面板密码（与 PanelPassword 严格分开）
	DeployPanelPassword *string
}

// Update 更新指定 profile。id 不存在时返回错误。
func (s *Store) Update(id string, patch Patch) (*Profile, error) {
	f, err := s.readFile()
	if err != nil {
		return nil, err
	}
	idx := indexOf(f.Profiles, id)
	if idx < 0 {
		return nil, fmt.Errorf("账户配置不存在：%s", id)
	}
	t := &f.Profiles[idx]

	if patch.Name != nil {
		if v := strings.TrimSpace(*patch.Name); v != "" {
			t.Name = v
		}
	}
	if patch.CfToken != nil {
		t.CfToken = strings.TrimSpace(*patch.CfToken)
	}
	if patch.AccountID != nil {
		t.AccountID = strings.TrimSpace(*patch.AccountID)
	}
	if patch.AccountName != nil {
		t.AccountName = strings.TrimSpace(*patch.AccountName)
	}
	if patch.KVNamespaceID != nil {
		t.KVNamespaceID = strings.TrimSpace(*patch.KVNamespaceID)
	}
	if patch.PanelPassword != nil {
		t.PanelPassword = *patch.PanelPassword
	}
	if patch.DeployPanelPassword != nil {
		t.DeployPanelPassword = *patch.DeployPanelPassword
	}
	t.UpdatedAt = nowISO()

	// 名字没手工指定过时，跟随账号名自动更新（与 Electron 版一致）
	if patch.Name == nil && patch.AccountName != nil {
		t.Name = deriveName(t.AccountName, t.AccountID)
	}

	if err := s.writeFile(f); err != nil {
		return nil, err
	}
	out := *t
	return &out, nil
}

// Delete 删除指定 profile。
//
// 允许删到 0 份（用户可能想完全清空）；删掉激活项时顺延到下一个。
func (s *Store) Delete(id string) (deleted bool, activeID string, err error) {
	f, err := s.readFile()
	if err != nil {
		return false, "", err
	}
	idx := indexOf(f.Profiles, id)
	if idx < 0 {
		return false, f.ActiveID, nil
	}

	f.Profiles = append(f.Profiles[:idx], f.Profiles[idx+1:]...)
	if f.ActiveID == id {
		if len(f.Profiles) == 0 {
			f.ActiveID = ""
		} else {
			next := idx
			if next >= len(f.Profiles) {
				next = len(f.Profiles) - 1
			}
			f.ActiveID = f.Profiles[next].ID
		}
	}
	if err := s.writeFile(f); err != nil {
		return false, f.ActiveID, err
	}
	return true, f.ActiveID, nil
}

// SetActive 切换激活的 profile。
func (s *Store) SetActive(id string) (bool, string, error) {
	f, err := s.readFile()
	if err != nil {
		return false, "", err
	}
	if indexOf(f.Profiles, id) < 0 {
		return false, f.ActiveID, nil
	}
	f.ActiveID = id
	if err := s.writeFile(f); err != nil {
		return false, f.ActiveID, err
	}
	return true, id, nil
}

// SaveActive 更新当前激活 profile 的字段；没有激活项时自动新建一份。
//
// 这是 Electron 版 `saveSecrets()` 的对应实现，供「保存 Token」按钮使用。
func (s *Store) SaveActive(patch Patch) (*Profile, error) {
	f, err := s.readFile()
	if err != nil {
		return nil, err
	}
	idx := indexOf(f.Profiles, f.ActiveID)
	if idx < 0 {
		// 没有任何账户：自动新建
		label := "新账户"
		if patch.AccountID != nil || patch.AccountName != nil {
			var acct, acctName string
			if patch.AccountID != nil {
				acct = *patch.AccountID
			}
			if patch.AccountName != nil {
				acctName = *patch.AccountName
			}
			label = deriveName(acctName, acct)
		}
		np := blankProfile(label)
		f.Profiles = append(f.Profiles, np)
		f.ActiveID = np.ID
		idx = len(f.Profiles) - 1
	}

	t := &f.Profiles[idx]
	if patch.CfToken != nil {
		t.CfToken = strings.TrimSpace(*patch.CfToken)
	}
	if patch.AccountID != nil {
		t.AccountID = strings.TrimSpace(*patch.AccountID)
	}
	if patch.AccountName != nil {
		t.AccountName = strings.TrimSpace(*patch.AccountName)
	}
	if patch.KVNamespaceID != nil {
		t.KVNamespaceID = strings.TrimSpace(*patch.KVNamespaceID)
	}
	if patch.PanelPassword != nil {
		t.PanelPassword = *patch.PanelPassword
	}
	if patch.DeployPanelPassword != nil {
		t.DeployPanelPassword = *patch.DeployPanelPassword
	}
	if patch.Name != nil {
		if v := strings.TrimSpace(*patch.Name); v != "" {
			t.Name = v
		}
	}
	t.UpdatedAt = nowISO()

	if err := s.writeFile(f); err != nil {
		return nil, err
	}
	out := *t
	return &out, nil
}

// Clear 清除本机所有凭据。
//
// 优先移动到 `.bak` 而不是直接删：误点也能找回。
// 只有 `.bak` 已存在时才真正删掉旧备份。
func (s *Store) Clear() error {
	path := s.path()
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	backup := path + ".bak"
	if _, err := os.Stat(backup); err == nil {
		_ = os.Remove(backup)
	}
	if err := os.Rename(path, backup); err != nil {
		// 跨设备或不支持改名时退化为直接删除
		if rmErr := os.Remove(path); rmErr != nil {
			return fmt.Errorf("清除凭据失败：%w", rmErr)
		}
	}
	return nil
}

// HasToken 报告当前激活 profile 是否已保存 Token。
func (s *Store) HasToken() bool {
	p, err := s.Active()
	if err != nil || p == nil {
		return false
	}
	return strings.TrimSpace(p.CfToken) != ""
}

// ---------- 内部工具 ----------

func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func newProfileID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand 失败几乎不可能；退化成时间戳保证不空
		return "acc_" + fmt.Sprintf("%08x", time.Now().UnixNano()&0xffffffff)
	}
	return "acc_" + hex.EncodeToString(b)
}

func blankProfile(name string) Profile {
	now := nowISO()
	return Profile{
		ID:        newProfileID(),
		Name:      name,
		CreatedAt: now,
		UpdatedAt: now,
	}
}

// normalizeProfile 把磁盘上的任意 JSON 补全成合法 profile。
func normalizeProfile(p *Profile) {
	now := nowISO()
	if strings.TrimSpace(p.ID) == "" {
		p.ID = newProfileID()
	}
	if strings.TrimSpace(p.Name) == "" {
		p.Name = "未命名账户"
	}
	if p.CreatedAt == "" {
		p.CreatedAt = now
	}
	if p.UpdatedAt == "" {
		p.UpdatedAt = now
	}
}

// deriveName 推导展示名：优先账号名，其次账号 ID 前 8 位，最后「新账户」。
func deriveName(accountName, accountID string) string {
	if n := strings.TrimSpace(accountName); n != "" {
		return n
	}
	if id := strings.TrimSpace(accountID); id != "" {
		if len(id) > 8 {
			id = id[:8]
		}
		return "账户 " + id
	}
	return "新账户"
}

func indexOf(ps []Profile, id string) int {
	for i := range ps {
		if ps[i].ID == id {
			return i
		}
	}
	return -1
}

func containsID(ps []Profile, id string) bool {
	return indexOf(ps, id) >= 0
}
