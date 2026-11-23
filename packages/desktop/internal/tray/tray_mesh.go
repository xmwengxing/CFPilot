//go:build mesh

package tray

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/energye/systray"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/autostart"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/mesh"
)

// meshdAddr 与 server 的 mesh_variant_mesh.go 一致。
const meshdAddr = "http://127.0.0.1:19727"

const meshPeerSlots = 16 // 节点列表预建槽位（systray v1.0.3 无 Remove，用 Hide/Show）

var (
	meshStatusClient = &http.Client{Timeout: 2 * time.Second}
	meshActionClient = &http.Client{Timeout: mesh.DaemonActionTimeout}
)

func meshToggleState(status mesh.Status, pending bool) (label string, disabled bool) {
	switch status.Transition {
	case "starting":
		return "正在启动组网…", true
	case "stopping":
		return "正在停止组网…", true
	}
	if pending || status.Transition != "" {
		return "处理中…", true
	}
	if status.Running {
		return "停止组网服务", false
	}
	return "启动组网服务", false
}

// addMeshMenu 在托盘加 +mesh 专属菜单：组网服务启停 + 节点列表二级菜单。
func (a *App) addMeshMenu() {
	systray.AddSeparator()
	a.meshToggleLabel, _ = meshToggleState(mesh.Status{}, false)
	a.mMeshToggle = systray.AddMenuItem(a.meshToggleLabel, "启动 / 停止 mesh 组网")
	a.mMeshAutoStart = systray.AddMenuItemCheckbox(
		"开机自启",
		"登录系统后自动启动 CFPilot，并加载组网服务与上次选择的网络",
		autostart.Enabled(),
	)
	peersMenu := systray.AddMenuItem("组网节点", "当前 mesh 网络的节点（在线/离线）")
	a.mMeshPeers = make([]*systray.MenuItem, meshPeerSlots)
	for i := range a.mMeshPeers {
		it := peersMenu.AddSubMenuItem("（空）", "")
		it.Hide()
		a.mMeshPeers[i] = it
	}
	a.mMeshToggle.Click(func() { a.toggleMesh() })
	a.mMeshAutoStart.Click(func() { a.toggleAutoStart() })

	// 定时刷新节点列表与组网菜单状态（每 5s）
	go func() {
		a.refreshMeshMenu()
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for range t.C {
			a.refreshMeshMenu()
		}
	}()
}

func (a *App) toggleAutoStart() {
	enabled := autostart.Enabled()
	if err := autostart.Set(!enabled); err != nil {
		log.Printf("[tray] 设置开机自启失败: %v", err)
		enabled = autostart.Enabled()
	} else {
		enabled = !enabled
	}
	if a.mMeshAutoStart == nil {
		return
	}
	if enabled {
		a.mMeshAutoStart.Check()
		return
	}
	a.mMeshAutoStart.Uncheck()
}

func (a *App) toggleMesh() {
	a.mu.Lock()
	if a.mMeshToggle == nil || a.meshActionPending || a.mMeshToggle.Disabled() {
		a.mu.Unlock()
		return
	}
	a.meshActionPending = true
	a.updateMeshToggleLocked(mesh.Status{})
	a.mu.Unlock()

	go func() {
		defer func() {
			a.mu.Lock()
			a.meshActionPending = false
			a.mu.Unlock()
			a.refreshMeshMenu()
		}()
		status := fetchMeshStatus()
		if status.Transition != "" {
			return
		}
		if status.Running {
			if err := stopMesh(); err != nil {
				log.Printf("[tray] 停止组网服务失败: %v", err)
			}
			return
		}
		if a.onOpenUI != nil {
			a.onOpenUI(a.srv.WelcomeURL() + "&page=mesh")
		}
	}()
}

func (a *App) updateMeshToggleLocked(status mesh.Status) {
	if a.mMeshToggle == nil {
		return
	}
	label, disabled := meshToggleState(status, a.meshActionPending)
	if label != a.meshToggleLabel {
		a.meshToggleLabel = label
		a.mMeshToggle.SetTitle(label)
	}
	if disabled != a.mMeshToggle.Disabled() {
		if disabled {
			a.mMeshToggle.Disable()
		} else {
			a.mMeshToggle.Enable()
		}
	}
}

func fetchMeshStatus() mesh.Status {
	resp, err := meshStatusClient.Get(meshdAddr + mesh.APIMeshStatus)
	if err != nil {
		return mesh.Status{}
	}
	defer resp.Body.Close()
	var status mesh.Status
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&status) != nil {
		return mesh.Status{}
	}
	return status
}

func (a *App) refreshMeshMenu() {
	status := fetchMeshStatus()
	a.mu.Lock()
	defer a.mu.Unlock()
	a.updateMeshToggleLocked(status)
	for index, item := range a.mMeshPeers {
		if index < len(status.Peers) {
			peer := status.Peers[index]
			mark := "离线"
			if peer.Online {
				mark = "在线"
			}
			item.SetTitle(fmt.Sprintf("%s %s (%s)", mark, peer.NodeID, peer.Via))
			item.Show()
		} else {
			item.Hide()
		}
	}
}

func stopMesh() error {
	resp, err := meshActionClient.Post(meshdAddr+mesh.APIMeshStop, "application/json", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= http.StatusBadRequest {
		var action mesh.ActionResult
		if err := json.NewDecoder(resp.Body).Decode(&action); err == nil && action.Error != "" {
			return fmt.Errorf("%s: %s", resp.Status, action.Error)
		}
		return fmt.Errorf("接口 %s 返回 %s", mesh.APIMeshStop, resp.Status)
	}
	return nil
}
