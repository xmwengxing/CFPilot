//go:build mesh

// cfpilot-meshd 是 +mesh 版的提权守护进程（Windows 服务 / Linux systemd service）。
//
// 它解决「浏览器面板 / 托盘是普通权限，建 TUN 需要管理员/root」的矛盾：
//   - 安装时把它注册为系统服务（LocalSystem / root），以提权身份常驻；
//   - 它监听本地 127.0.0.1:19727，提供 start/stop/status/peers API；
//   - 面板（普通进程）和托盘通过本地 HTTP 调用它，用户全程不碰命令行 / JSON 文件。
//
// 启动配置由面板通过本地 API 传入，保存网络档案时由守护进程写入档案库。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/mesh"
)

const listenAddr = "127.0.0.1:19727"

var version = "dev"

func main() {
	install := flag.Bool("install", false, "注册为系统服务（Windows）")
	uninstall := flag.Bool("uninstall", false, "卸载系统服务（Windows）")
	// --version 用于排查「服务跑的是旧二进制」：面板/用户可直接请求
	// http://127.0.0.1:19727/api/mesh/version 对照本程序版本。
	showVersion := flag.Bool("version", false, "打印版本后退出")
	// --console：Windows 上以前台进程运行（不开服务），用于真机调试看日志。
	// 正常安装仍走服务模式（LocalSystem，才能建 TUN）。
	console := flag.Bool("console", false, "内部参数：前台运行（调试用，Windows 不注册服务）")
	// Windows SCM 启动服务时传入（见 service_windows.go 的 CreateService），
	// 这里接收但不做额外动作——服务生命周期由 Execute 管理。
	_ = flag.Bool("mesh-daemon", false, "内部参数：以服务模式运行")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	if *install {
		installService()
		return
	}
	if *uninstall {
		uninstallService()
		return
	}

	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Printf("[meshd] 启动（版本 %s，%s/%s）", version, runtime.GOOS, runtime.GOARCH)

	// 命名网络档案由本服务独占读写（面板通过本地 API 访问），权限 0600。
	// Windows 服务账号的 HOME 是 systemprofile，与用户目录不同；安装包把 meshd
	// 放在用户可写的 %LOCALAPPDATA%\CFPilot-Mesh，所以优先用 exe 所在目录，
	// 这样服务重启后仍能找到同一份档案。Linux deb 安装到 /usr/bin，用 config.Dir()。
	var profiles *mesh.ProfileStore
	dataDir, dirErr := profileDataDir()
	if dirErr != nil {
		log.Printf("[meshd] 警告：无法定位数据目录，网络档案与自动恢复不可用: %v", dirErr)
	} else if store, err := mesh.NewProfileStore(dataDir); err != nil {
		log.Printf("[meshd] 警告：加载网络档案失败: %v", err)
	} else {
		profiles = store
	}

	// Windows 下作为服务运行（SCM 管理生命周期）；Linux 下直接跑（systemd 管理）。
	if runtime.GOOS == "windows" && !*console {
		runAsService(func() { serve(profiles) })
		return
	}
	serve(profiles)
}

func serve(profiles *mesh.ProfileStore) {
	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		log.Fatalf("[meshd] 监听失败: %v", err)
	}
	control := &meshControl{newLifecycle: mesh.NewLifecycleWithConfig}
	control.restore(profiles)
	log.Printf("[meshd] 本地 API 就绪: http://%s", listenAddr)
	if err := http.Serve(ln, control.handler(profiles)); err != nil {
		log.Fatalf("[meshd] 服务退出: %v", err)
	}
}

func (control *meshControl) handler(profiles *mesh.ProfileStore) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(mesh.APIMeshStatus, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, control.status())
	})
	// 版本自报：面板可据此发现「装的是新包，服务跑的是旧二进制」。
	mux.HandleFunc("/api/mesh/version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"version": version})
	})
	// 命名网络档案：面板负责编辑与选择，meshd 负责持久化和服务重启后的自动恢复。
	mux.HandleFunc("/api/mesh/profiles", func(w http.ResponseWriter, r *http.Request) {
		if profiles == nil {
			writeErr(w, "网络档案不可用：无法访问数据目录")
			return
		}
		if r.Method == http.MethodGet {
			writeJSON(w, http.StatusOK, profiles.State())
			return
		}
		if r.Method != http.MethodPost {
			writeErr(w, "仅支持 GET/POST")
			return
		}
		var req struct {
			Action string       `json:"action"`
			Name   string       `json:"name"`
			Config *mesh.Config `json:"config"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			writeErr(w, "参数非法: "+err.Error())
			return
		}
		switch req.Action {
		case "save":
			if req.Config == nil {
				writeErr(w, "缺少 config")
				return
			}
			if err := profiles.Save(req.Name, *req.Config); err != nil {
				writeErr(w, err.Error())
				return
			}
		case "select":
			if err := profiles.Select(req.Name); err != nil {
				writeErr(w, err.Error())
				return
			}
		case "delete":
			if err := profiles.Delete(req.Name); err != nil {
				writeErr(w, err.Error())
				return
			}
		default:
			writeErr(w, "未知 action: "+req.Action)
			return
		}
		writeJSON(w, http.StatusOK, profiles.State())
	})
	mux.HandleFunc(mesh.APIMeshStart, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, "仅支持 POST")
			return
		}
		var cfg mesh.Config
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&cfg); err != nil {
			writeErr(w, "配置非法: "+err.Error())
			return
		}
		previous, ok := control.begin(transitionStarting)
		if !ok {
			writeMeshConflict(w)
			return
		}
		started, err := control.start(cfg, previous)
		if err != nil {
			writeErr(w, "启动失败: "+err.Error())
			return
		}
		log.Printf("[meshd] 组网已启动 node=%s vip=%s", started.NodeID, started.VirtualIP)
		writeJSON(w, http.StatusOK, mesh.ActionResult{OK: true, Message: "已启动"})
	})
	mux.HandleFunc(mesh.APIMeshPeers, func(w http.ResponseWriter, r *http.Request) {
		peers := control.status().Peers
		if peers == nil {
			peers = []mesh.Peer{}
		}
		writeJSON(w, http.StatusOK, peers)
	})
	mux.HandleFunc(mesh.APIMeshStop, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, "仅支持 POST")
			return
		}
		previous, ok := control.begin(transitionStopping)
		if !ok {
			writeMeshConflict(w)
			return
		}
		if err := control.stop(previous); err != nil {
			writeErr(w, err.Error())
			return
		}
		if previous == nil {
			writeJSON(w, http.StatusOK, mesh.ActionResult{OK: true, Message: "未运行"})
			return
		}
		log.Printf("[meshd] 组网已停止")
		writeJSON(w, http.StatusOK, mesh.ActionResult{OK: true, Message: "已停止"})
	})
	return mux
}

func profileDataDir() (string, error) {
	if runtime.GOOS == "windows" {
		exe, err := os.Executable()
		if err == nil {
			return filepath.Dir(exe), nil
		}
	}
	return config.Dir()
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, msg string) {
	writeJSON(w, http.StatusBadRequest, mesh.ActionResult{OK: false, Error: msg})
}

func writeMeshConflict(w http.ResponseWriter) {
	writeJSON(w, http.StatusConflict, mesh.ActionResult{Error: "正在启动或停止组网，请等待当前操作完成"})
}
