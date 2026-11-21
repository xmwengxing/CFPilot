package mesh

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// SavedProfile 是一套可重复启动的组网配置档案。
//
// Name 是本机管理用的档案名（下拉框里显示的那个），与 Config.NetworkName
// （真正的组网网络名，影响握手隔离）不是一回事。
type SavedProfile struct {
	Name   string `json:"name"`
	Config Config `json:"config"`
}

// ProfileState 是落盘格式。
//
// Selected 指向下次服务启动时要恢复的档案；AutoStart 为 true 时 meshd 在服务
// 启动时直接拉起它。配置文件含 PSK / 隧道私钥 / 监测令牌，权限 0600。
type ProfileState struct {
	Version   int            `json:"version"`
	Selected  string         `json:"selected"`
	AutoStart bool           `json:"autoStart"`
	Profiles  []SavedProfile `json:"profiles"`
}

// ProfileStore 管理命名网络档案的持久化。
type ProfileStore struct {
	mu    sync.Mutex
	path  string
	state ProfileState
}

// NewProfileStore 打开（或创建）档案库。
func NewProfileStore(dataDir string) (*ProfileStore, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("mesh profiles: 建目录失败: %w", err)
	}
	s := &ProfileStore{path: filepath.Join(dataDir, "mesh-profiles.json")}
	raw, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		s.state = ProfileState{Version: 1, Profiles: []SavedProfile{}}
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("mesh profiles: 读取失败: %w", err)
	}
	if err := json.Unmarshal(raw, &s.state); err != nil {
		return nil, fmt.Errorf("mesh profiles: 解析失败: %w", err)
	}
	if s.state.Version == 0 {
		s.state.Version = 1
	}
	if s.state.Profiles == nil {
		s.state.Profiles = []SavedProfile{}
	}
	return s, nil
}

// List 返回全部档案（含配置，供「修改网络」回填表单）。
func (s *ProfileStore) List() []SavedProfile {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]SavedProfile(nil), s.state.Profiles...)
}

// State 返回档案库摘要与全部档案。
func (s *ProfileStore) State() ProfileState {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.state
	out.Profiles = append([]SavedProfile(nil), s.state.Profiles...)
	return out
}

// SelectedConfig 返回当前选中档案的配置；没有选中时返回 nil。
func (s *ProfileStore) SelectedConfig() *Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.Profiles {
		if s.state.Profiles[i].Name == s.state.Selected {
			cfg := s.state.Profiles[i].Config
			return &cfg
		}
	}
	return nil
}

// AutoStartEnabled 返回服务启动时是否应恢复当前选中网络。
func (s *ProfileStore) AutoStartEnabled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.AutoStart && s.state.Selected != ""
}

// Save 新增或覆盖一个档案，并把刚保存的档案设为当前网络。
func (s *ProfileStore) Save(name string, cfg Config) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("mesh profiles: 档案名不能为空")
	}
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("mesh profiles: 配置无效: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	replaced := false
	for i := range s.state.Profiles {
		if s.state.Profiles[i].Name == name {
			s.state.Profiles[i].Config = cfg
			replaced = true
			break
		}
	}
	if !replaced {
		s.state.Profiles = append(s.state.Profiles, SavedProfile{Name: name, Config: cfg})
	}
	s.state.Selected = name
	s.state.AutoStart = true
	return s.saveLocked()
}

// Select 设置当前网络（只影响下次启动恢复，不中断正在运行的网络）。
func (s *ProfileStore) Select(name string) error {
	name = strings.TrimSpace(name)
	s.mu.Lock()
	defer s.mu.Unlock()
	found := false
	for i := range s.state.Profiles {
		if s.state.Profiles[i].Name == name {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("mesh profiles: 未找到档案 %s", name)
	}
	s.state.Selected = name
	s.state.AutoStart = true
	return s.saveLocked()
}

// Delete 删除档案；删掉当前选中档案时同步清空选中状态。
func (s *ProfileStore) Delete(name string) error {
	name = strings.TrimSpace(name)
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := make([]SavedProfile, 0, len(s.state.Profiles))
	for _, p := range s.state.Profiles {
		if p.Name != name {
			kept = append(kept, p)
		}
	}
	if len(kept) == len(s.state.Profiles) {
		return fmt.Errorf("mesh profiles: 未找到档案 %s", name)
	}
	s.state.Profiles = kept
	if s.state.Selected == name {
		s.state.Selected = ""
		s.state.AutoStart = false
	}
	return s.saveLocked()
}

func (s *ProfileStore) saveLocked() error {
	s.state.Version = 1
	raw, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return fmt.Errorf("mesh profiles: 编码失败: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("mesh profiles: 写临时文件失败: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		// Windows 上 Rename 不会覆盖已存在文件；先删旧文件再改名。
		if removeErr := os.Remove(s.path); removeErr == nil {
			if retryErr := os.Rename(tmp, s.path); retryErr != nil {
				return fmt.Errorf("mesh profiles: 替换失败: %w", retryErr)
			}
		} else if !os.IsNotExist(removeErr) {
			return fmt.Errorf("mesh profiles: 替换失败: %w", removeErr)
		} else {
			return fmt.Errorf("mesh profiles: 替换失败: %w", err)
		}
	}
	return nil
}
