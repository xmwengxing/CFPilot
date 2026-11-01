package server

// 本地部署快照。
//
// ## 为什么需要它
//
// 「运行状态」卡片要在**不调用 Cloudflare Token** 的前提下显示：
//   - 本程序内置的内核版本与构建指纹；
//   - 最近一次部署的记录（版本、构建、控制面/数据面名称、KV 名称）。
//
// 部署记录本身存在 KV 里（读取要令牌），所以本机在**部署完成**或
// **检查过部署状态**时把要点抄一份到本地文件：
//
//	~/.cfpilot-gui/deploy-snapshot.json
//
// 这样界面打开就能显示这些信息，不必为了看一行字去请求 Cloudflare。
//
// ## 边界
//
// - 只存**非敏感**信息：项目名、子域、KV 名称、版本号、构建指纹、时间。
// - 面板密码 / UUID / WS 路径**绝不**进这个文件（它们走「查看面板凭据」）。
// - 快照可能过期（用户在别处部署过），因此界面同时显示来源与时间。

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// snapshotFileName 是快照文件名（与凭据同目录，便于整体备份 / 迁移）。
const snapshotFileName = "deploy-snapshot.json"

// DeploySnapshot 是「最近一次部署」的本地留档。
type DeploySnapshot struct {
	// KVNamespaceID 是这次部署使用的 KV 命名空间 ID。
	KVNamespaceID string `json:"kvNamespaceId,omitempty"`
	// KVTitle 是 KV 的**名称**（不是 ID）：界面上展示名称更易读。
	KVTitle string `json:"kvTitle,omitempty"`
	// ControlProject / DataProject 是两个项目的名称。
	ControlProject string `json:"controlProject,omitempty"`
	DataProject    string `json:"dataProject,omitempty"`
	// ControlSubdomain / DataSubdomain 是两个项目的访问子域。
	ControlSubdomain string `json:"controlSubdomain,omitempty"`
	DataSubdomain    string `json:"dataSubdomain,omitempty"`
	// KernelVersion 是这次部署用的内核语义版本（如 0.13.6）。
	KernelVersion string `json:"kernelVersion,omitempty"`
	// Build 是这次部署的内核构建指纹（如 1282c1e-7232c94b）。
	Build string `json:"build,omitempty"`
	// At 是部署时间（ISO8601，UTC）。
	At string `json:"at,omitempty"`
	// AccountID / AccountName 记录当时的账号，便于界面显示账号邮箱。
	AccountID   string `json:"accountId,omitempty"`
	AccountName string `json:"accountName,omitempty"`
	// DataPlaneMode 记录数据面形态（pages / workers）。
	DataPlaneMode string `json:"dataPlaneMode,omitempty"`
	// Instances 是本机已知的 CFPilot 实例（KV 命名空间 ID → 实例信息）。
	//
	// 为什么需要它：老用户升级后没有「最近一次部署」的快照，
	// 只看快照就显示不出 KV 名称与项目名。
	// 凭据页每次读取 KV 列表时都会把实例信息存到这里，
	// 于是部署页不用再调 Token 也能显示完整的一行。
	Instances map[string]InstanceInfo `json:"instances,omitempty"`
}

// InstanceInfo 是一个已部署实例的本地索引。
type InstanceInfo struct {
	KVTitle          string `json:"kvTitle,omitempty"`
	ControlProject   string `json:"controlProject,omitempty"`
	DataProject      string `json:"dataProject,omitempty"`
	ControlSubdomain string `json:"controlSubdomain,omitempty"`
	DataSubdomain    string `json:"dataSubdomain,omitempty"`
	KernelVersion    string `json:"kernelVersion,omitempty"`
	Build            string `json:"build,omitempty"`
	At               string `json:"at,omitempty"`
}

// snapshotPath 返回快照文件路径。
func (s *Server) snapshotPath() string {
	return filepath.Join(s.store.DirPath(), snapshotFileName)
}

// loadSnapshot 读取本地快照；没有或损坏时返回 nil（界面显示「暂无记录」）。
func (s *Server) loadSnapshot() *DeploySnapshot {
	raw, err := os.ReadFile(s.snapshotPath())
	if err != nil || len(raw) == 0 {
		return nil
	}
	var snap DeploySnapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		return nil
	}
	return &snap
}

// saveSnapshot 写本地快照（原子替换，权限 0600）。
//
// saveSnapshot 写本地快照（原子替换，权限 0600）。
//
// 写失败只记日志：快照是**便利信息**，丢了不该影响部署本身。
func (s *Server) saveSnapshot(snap *DeploySnapshot) {
	if snap == nil {
		return
	}
	if snap.At == "" {
		snap.At = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	dir := s.store.DirPath()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		s.logLevel("保存部署快照失败："+err.Error(), "warn")
		return
	}
	raw, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		s.logLevel("保存部署快照失败："+err.Error(), "warn")
		return
	}
	tmp := s.snapshotPath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		s.logLevel("保存部署快照失败："+err.Error(), "warn")
		return
	}
	if err := os.Rename(tmp, s.snapshotPath()); err != nil {
		s.logLevel("保存部署快照失败："+err.Error(), "warn")
	}
}

// rememberInstances 把已知的实例信息并进本地快照。
//
// 调用点：凭据页读取 KV 列表之后。
// 作用：部署页不用再调 Token 就能显示「KV 名称 · 控制面 / 数据面」。
func (s *Server) rememberInstances(instances map[string]InstanceInfo) {
	if len(instances) == 0 {
		return
	}
	snap := s.loadSnapshot()
	if snap == nil {
		snap = &DeploySnapshot{}
	}
	if snap.Instances == nil {
		snap.Instances = map[string]InstanceInfo{}
	}
	for id, info := range instances {
		if id == "" {
			continue
		}
		snap.Instances[id] = info
	}
	// 快照里的 At 表示「最近一次部署时间」，别被这次索引刷新改写
	s.saveSnapshot(snap)
}

// instanceInfoFor 返回某个 KV 在本地已知的实例信息。
func (s *Server) instanceInfoFor(kvID string) (InstanceInfo, bool) {
	snap := s.loadSnapshot()
	if snap == nil || snap.Instances == nil {
		return InstanceInfo{}, false
	}
	info, ok := snap.Instances[kvID]
	return info, ok
}

// handleDeployLocal 返回**纯本地**的部署信息（不联网、不用 Token）。
//
// 界面「运行状态」卡片在常态下只调这个接口：
// 本程序内置版本 + 最近一次部署记录（来自本地快照）。
//
// 点了「检查部署状态」才会走 /api/deploy/check（那条路要读 KV 与线上版本）。
func (s *Server) handleDeployLocal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET/POST"})
		return
	}
	profile, _ := s.store.Active()
	accountID := ""
	accountName := ""
	if profile != nil {
		accountID = strings.TrimSpace(profile.AccountID)
		accountName = strings.TrimSpace(profile.AccountName)
	}
	snap := s.loadSnapshot()
	if snap != nil {
		// 账号以当前激活账户为准（用户可能换过账户）。
		if accountID != "" {
			snap.AccountID = accountID
		}
		if accountName != "" {
			snap.AccountName = accountName
		}
	}
	// 本机已知的实例索引（KV 命名空间 ID → 名称 / 项目名）
	instances := map[string]InstanceInfo{}
	if snap != nil {
		for id, info := range snap.Instances {
			instances[id] = info
		}
	}
	// 只有一个已知实例时直接采用它：
	// 老用户升级后还没有「最近一次部署」快照，
	// 但只要检测过一次账号，本机就已经知道那个实例是谁了。
	if snap != nil && snap.KVNamespaceID == "" && len(instances) == 1 {
		for id, info := range instances {
			snap.KVNamespaceID = id
			if snap.KVTitle == "" {
				snap.KVTitle = info.KVTitle
			}
			if snap.ControlProject == "" {
				snap.ControlProject = info.ControlProject
			}
			if snap.DataProject == "" {
				snap.DataProject = info.DataProject
			}
			if snap.ControlSubdomain == "" {
				snap.ControlSubdomain = info.ControlSubdomain
			}
			if snap.DataSubdomain == "" {
				snap.DataSubdomain = info.DataSubdomain
			}
			if snap.KernelVersion == "" {
				snap.KernelVersion = info.KernelVersion
			}
			if snap.Build == "" {
				snap.Build = info.Build
			}
			if snap.At == "" {
				snap.At = info.At
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                 true,
		"snapshot":           snap,
		"instances":          instances,
		"localKernelVersion": Version(),
		"localBuild":         localKernelBuild(),
		"accountId":          accountID,
		"accountName":        accountName,
	})
}
