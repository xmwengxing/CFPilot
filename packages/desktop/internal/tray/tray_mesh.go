//go:build mesh

package tray

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/energye/systray"
)

// meshdAddr 与 server 的 mesh_variant_mesh.go 一致。
const meshdAddr = "http://127.0.0.1:19727"

const meshPeerSlots = 16 // 节点列表预建槽位（systray v1.0.3 无 Remove，用 Hide/Show）

// addMeshMenu 在托盘加 +mesh 专属菜单：组网服务启停 + 节点列表二级菜单。
func (a *App) addMeshMenu() {
	systray.AddSeparator()
	a.mMeshToggle = systray.AddMenuItem("启动组网服务", "启动 / 停止 mesh 组网")
	peersMenu := systray.AddMenuItem("组网节点", "当前 mesh 网络的节点（在线/离线）")
	a.mMeshPeers = make([]*systray.MenuItem, meshPeerSlots)
	for i := range a.mMeshPeers {
		it := peersMenu.AddSubMenuItem("（空）", "")
		it.Hide()
		a.mMeshPeers[i] = it
	}
	a.mMeshToggle.Click(func() { a.toggleMesh() })

	// 定时刷新节点列表（每 5s）
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for range t.C {
			a.refreshMeshPeers()
		}
	}()
}

func (a *App) toggleMesh() {
	st := a.meshStatus()
	if st.Running {
		postMesh("/api/mesh/stop")
		a.mMeshToggle.SetTitle("启动组网服务")
	} else {
		// 启动需要配置（PSK 等），托盘不重复做表单——打开面板「组网」页，
		// 用户点面板里的「启动组网」按钮（带配置），托盘只负责停止与查看节点。
		a.mMeshToggle.SetTitle("启动组网服务")
		if a.onOpenUI != nil {
			a.onOpenUI(a.srv.WelcomeURL() + "&page=mesh")
		}
	}
}

func (a *App) meshStatus() (st struct {
	Running           bool
	NodeID, VirtualIP string
	Peers             []struct {
		NodeID, VirtualIP string
		Online            bool
		Via               string
	}
}) {
	resp, err := http.Get(meshdAddr + "/api/mesh/status")
	if err != nil {
		return
	}
	defer resp.Body.Close()
	_ = json.NewDecoder(resp.Body).Decode(&st)
	return
}

func (a *App) refreshMeshPeers() {
	st := a.meshStatus()
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.mMeshPeers) == 0 {
		return
	}
	for i, item := range a.mMeshPeers {
		if i < len(st.Peers) {
			p := st.Peers[i]
			mark := "离线"
			if p.Online {
				mark = "在线"
			}
			item.SetTitle(fmt.Sprintf("%s %s (%s)", mark, p.NodeID, p.Via))
			item.Show()
		} else {
			item.Hide()
		}
	}
}

func postMesh(path string) {
	resp, err := http.Post(meshdAddr+path, "application/json", nil)
	if err == nil {
		resp.Body.Close()
	}
}
