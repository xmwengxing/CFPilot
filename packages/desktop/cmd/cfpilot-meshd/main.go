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
	"runtime"
	"sync"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/mesh"
)

const listenAddr = "127.0.0.1:19727"

var (
	version = "dev"
	mu      sync.Mutex
	life    mesh.Lifecycle
	status  = mesh.Status{Note: "未启动"}
)

func main() {
	install := flag.Bool("install", false, "注册为系统服务（Windows）")
	uninstall := flag.Bool("uninstall", false, "卸载系统服务（Windows）")
	// Windows SCM 启动服务时传入（见 service_windows.go 的 CreateService），
	// 这里接收但不做额外动作——服务生命周期由 Execute 管理。
	_ = flag.Bool("mesh-daemon", false, "内部参数：以服务模式运行")
	flag.Parse()

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

	// Windows 下作为服务运行（SCM 管理生命周期）；Linux 下直接跑（systemd 管理）。
	if runtime.GOOS == "windows" {
		runAsService(func() { serve() })
		return
	}
	serve()
}

func serve() {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/mesh/status", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		st := status
		mu.Unlock()
		writeJSON(w, http.StatusOK, st)
	})
	mux.HandleFunc("/api/mesh/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, "仅支持 POST")
			return
		}
		mu.Lock()
		if life != nil {
			mu.Unlock()
			writeErr(w, "已启动")
			return
		}
		var cfg mesh.Config
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&cfg); err != nil {
			mu.Unlock()
			writeErr(w, "配置非法: "+err.Error())
			return
		}
		life = mesh.NewLifecycleWithConfig(cfg)
		ctx, cancel := context.WithCancel(context.Background())
		_ = cancel
		if err := life.Start(ctx); err != nil {
			life = nil
			mu.Unlock()
			writeErr(w, "启动失败: "+err.Error())
			return
		}
		st := life.Status()
		status = st
		mu.Unlock()
		log.Printf("[meshd] 组网已启动 node=%s vip=%s", st.NodeID, st.VirtualIP)
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
		err := life.Stop()
		life = nil
		status = mesh.Status{Note: "未启动"}
		mu.Unlock()
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
