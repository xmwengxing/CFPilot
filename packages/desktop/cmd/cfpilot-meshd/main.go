//go:build mesh

// cfpilot-meshd 是 +mesh 版的提权守护进程（Windows 服务 / Linux systemd service）。
//
// 它解决「浏览器面板 / 托盘是普通权限，建 TUN 需要管理员/root」的矛盾：
//   - 安装时把它注册为系统服务（LocalSystem / root），以提权身份常驻；
//   - 它监听本地 127.0.0.1:19727，提供 start/stop/status/peers API；
//   - 面板（普通进程）和托盘通过本地 HTTP 调用它，用户全程不碰命令行 / JSON 文件。
//
// 配置由调用方（面板）通过 POST /api/mesh/start 的 JSON body 传入，
// 守护进程内存持有，不落盘（PSK 等敏感信息不写文件）。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/mesh"
)

const listenAddr = "127.0.0.1:19727"

var (
	version  = "dev"
	mu       sync.Mutex
	life     mesh.Lifecycle
	status   = mesh.Status{Note: "未启动"}
	profiles *mesh.ProfileStore
)

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
		runAsService(func() { serve() })
		return
	}
	serve()
}

func serve() {
	// 服务重启后自动恢复最后一次选中的网络。
	// 这是「当前网络 + 自动启动」的核心：不再依赖浏览器是否打开过。
	if profiles != nil && profiles.AutoStartEnabled() {
		if cfg := profiles.SelectedConfig(); cfg != nil {
			if started, err := startLifecycle(*cfg); err != nil {
				log.Printf("[meshd] 自动恢复网络失败: %v", err)
			} else {
				log.Printf("[meshd] 已自动恢复上次选择的网络: vip=%s", started.VirtualIP)
			}
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/mesh/status", func(w http.ResponseWriter, r *http.Request) {
		// ⚠️ 必须**实时**调用 life.Status()。早前返回的是 Start 时拍下的快照，
		// 于是面板永远看到 handshakeOk=0 / online=false / tx=0，
		// 而底层其实早已握手并转发流量（真机实测踩到）。
		mu.Lock()
		l := life
		mu.Unlock()
		if l == nil {
			mu.Lock()
			st := status
			mu.Unlock()
			writeJSON(w, http.StatusOK, st)
			return
		}
		st := l.Status()
		mu.Lock()
		status = st
		mu.Unlock()
		writeJSON(w, http.StatusOK, st)
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
	mux.HandleFunc("/api/mesh/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, "仅支持 POST")
			return
		}
		var cfg mesh.Config
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&cfg); err != nil {
			writeErr(w, "配置非法: "+err.Error())
			return
		}
		// 上报给云监测台的客户端版本：由本进程注入（面板不必知道内核版本）
		if cfg.ClientVersion == "" {
			cfg.ClientVersion = version
		}
		started, err := startLifecycle(cfg)
		if err != nil {
			writeErr(w, "启动失败: "+err.Error())
			return
		}
		log.Printf("[meshd] 组网已启动 node=%s vip=%s", started.NodeID, started.VirtualIP)
		writeJSON(w, http.StatusOK, mesh.ActionResult{OK: true, Message: "已启动"})
	})
	mux.HandleFunc("/api/mesh/peers", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		st := status
		mu.Unlock()
		if st.Peers == nil {
			st.Peers = []mesh.Peer{}
		}
		writeJSON(w, http.StatusOK, st.Peers)
	})
	mux.HandleFunc("/api/mesh/stop", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, "仅支持 POST")
			return
		}
		mu.Lock()
		if life == nil {
			mu.Unlock()
			writeJSON(w, http.StatusOK, mesh.ActionResult{OK: true, Message: "未运行"})
			return
		}
		// 先摘出实例再 Stop：持全局锁等 Stop 会把 status/start 一起堵住。
		l := life
		life = nil
		status = mesh.Status{Note: "未启动"}
		mu.Unlock()
		err := l.Stop()
		if err != nil {
			writeErr(w, err.Error())
			return
		}
		log.Printf("[meshd] 组网已停止")
		writeJSON(w, http.StatusOK, mesh.ActionResult{OK: true, Message: "已停止"})
	})

	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		log.Fatalf("[meshd] 监听失败: %v", err)
	}
	log.Printf("[meshd] 本地 API 就绪: http://%s", listenAddr)
	if err := http.Serve(ln, mux); err != nil {
		log.Fatalf("[meshd] 服务退出: %v", err)
	}
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

// startLifecycle 先停旧实例再按新配置启动，返回新实例的首帧状态。
func startLifecycle(cfg mesh.Config) (mesh.Status, error) {
	// 允许「再次启动」：旧实现遇到 life != nil 直接返回「已启动」，
	// 一旦上一次停止不彻底/半运行，就永远无法再启动（用户只能卸载重装）。
	mu.Lock()
	old := life
	life = nil
	mu.Unlock()
	if old != nil {
		_ = old.Stop()
	}
	newLife := mesh.NewLifecycleWithConfig(cfg)
	ctx, cancel := context.WithCancel(context.Background())
	_ = cancel // 生命周期内部会创建自己的 runCtx；Stop 会关闭它
	if err := newLife.Start(ctx); err != nil {
		return mesh.Status{}, err
	}
	st := newLife.Status()
	mu.Lock()
	life = newLife
	status = st
	mu.Unlock()
	return st, nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, msg string) {
	writeJSON(w, http.StatusBadRequest, mesh.ActionResult{OK: false, Error: msg})
}

// runAsService / installService / uninstallService 见 platform 专属文件。
var _ = fmt.Sprintf
var _ = os.Exit
