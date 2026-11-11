// CFPilot 安卓版入口（纯逻辑部分）。
//
// # 为什么单独一个 cmd
//
// 桌面版（cmd/cfpilot）的主流程里有托盘、自动开浏览器、命令行参数解析、
// 优雅退出信号处理 —— 这些在手机上全都没有意义（安卓没有托盘、没有「双击运行」）。
// 与其塞一堆 if runtime.GOOS == "android" 进去，不如单开一个入口，
// 只保留「起服务 + 把地址交给界面」这两件事。
//
// 复用的部分全是 internal 包：config / server / logfile / store / scan ……
// **业务逻辑与桌面版完全一致**，不会出现「两套实现慢慢漂移」。
//
// # 与 Java 层的接口
//
// 用 `-buildmode=c-shared` 编成 .so，由 export.go 导出两个 C 函数：
//
//	StartServer(dataDir) -> "http://127.0.0.1:19726/?t=<令牌>"
//	StopServer()
//
// 令牌必须走 URL —— 界面脚本（adapter.js）从地址栏的 ?t= 里取它换会话 Cookie。
// 所以「地址 + 令牌」要一起交回 Java 层，由它喂给 WebView。
//
// # 为什么不带定时优选任务
//
// 手机系统随时可能回收后台进程，「每天几点自动跑一轮」这件事在手机上不可靠。
// 定时优选交给常驻的容器形态做（见 docker/ 目录），两边分工明确。
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/logfile"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/server"
)

// Version 由构建时 ldflags 注入（与桌面版同一份来源）。
var Version = "dev"

// 服务器实例。Java 层可能重复调用 StartServer（比如界面重建后重连），
// 所以这里做「已存在就复用」的处理。
var (
	mu      sync.Mutex
	current *server.Server
)

// serverInfo 是交回 Java 层的启动信息。
type serverInfo struct {
	URL     string `json:"url"`
	Port    int    `json:"port"`
	Token   string `json:"token"`
	DataDir string `json:"dataDir"`
	Version string `json:"version"`
	// Error 非空表示启动失败。失败也返回 JSON（而不是 NULL），
	// Java 侧统一按 JSON 解析，少一套空指针分支。
	Error string `json:"error,omitempty"`
}

// startServer 启动本地服务并返回对外信息。
//
// dataDir 为空时用默认位置（~/.cfpilot-gui）；安卓上由 Java 层传入应用私有目录。
func startServer(dataDir string) serverInfo {
	mu.Lock()
	defer mu.Unlock()

	// 复用已有实例
	if current != nil {
		if info, err := describe(current, dataDir); err == nil {
			return info
		}
	}

	if dataDir != "" {
		// 配置目录（设置、凭据、内核缓存）放在应用私有目录下。
		if err := os.Setenv(config.EnvDataDir, dataDir); err != nil {
			return serverInfo{Error: fmt.Sprintf("设置数据目录失败：%v", err)}
		}
	}
	if _, err := config.EnsureDir(); err != nil {
		return serverInfo{Error: fmt.Sprintf("创建配置目录失败：%v", err)}
	}

	// 日志：与桌面版同一个文件（滚动上限一致）。
	// 手机上没法直接看文件，但界面「日志」页签读的就是它 ✓
	if dir, err := config.EnsureDir(); err == nil {
		if w, werr := logfile.New(
			filepath.Join(dir, "cfpilot.log"),
			logfile.DefaultMaxBytes,
			logfile.DefaultMaxBackups,
		); werr == nil {
			log.SetOutput(w)
		}
	}

	settings, err := config.LoadSettings()
	if err != nil {
		log.Printf("[cfpilot] 读取设置失败，使用默认值：%v", err)
	}

	// 注入版本号（构建时 ldflags 写入 Version 变量）。
	//
	// ⚠️ 版本号存在 **server 包**里（server.appVersion），不是 main 包 ——
	//    只写 ldflags 不调用 SetVersion 的话，界面右上角会一直显示「vdev」。
	server.SetVersion(Version)

	// 手机上固定用回环地址：界面在同一个应用进程里，通过 WebView 访问。
	//
	// ⚠️ 「允许局域网访问」要走**同一套语义**（与桌面版一致）：
	// 默认不开；用户主动开启时才放开。
	settings.AllowLAN = config.EnvAllowLANValue()

	srv, err := server.New(settings)
	if err != nil {
		return serverInfo{Error: fmt.Sprintf("创建服务失败：%v", err)}
	}
	if err := srv.Start(); err != nil {
		return serverInfo{Error: fmt.Sprintf("启动服务失败：%v", err)}
	}
	current = srv

	info, err := describe(srv, dataDir)
	if err != nil {
		return serverInfo{Error: err.Error()}
	}
	return info
}

// stopServer 停止本地服务（应用退出时调用）。
func stopServer() {
	mu.Lock()
	defer mu.Unlock()
	if current != nil {
		_ = current.Stop()
		current = nil
	}
}

// describe 汇总当前服务的对外信息。
func describe(srv *server.Server, dataDir string) (serverInfo, error) {
	if srv == nil {
		return serverInfo{}, fmt.Errorf("服务未启动")
	}
	port := 0
	if st := srv.Settings(); st.Port > 0 {
		port = st.Port
	}
	return serverInfo{
		URL:     srv.WelcomeURL(),
		Port:    port,
		Token:   srv.BootToken(),
		DataDir: dataDir,
		Version: Version,
	}, nil
}

// toJSON 把结构体编成 JSON。
func toJSON(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return `{"error":"内部错误"}`
	}
	return string(raw)
}

// main 在安卓上不会被调用（入口是 JNI 调 StartServer）。
// 保留一个空实现是为了让 `go vet` / 单元测试能编译这个包。
func main() {}
