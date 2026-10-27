// CFPilot 桌面版入口。
//
// ## 这是什么
//
// 一个 ~10 MB 的 Go 单文件程序，替代 78 MB 的 Electron 版：
//   - 托盘常驻，提供「服务状态 / 打开界面 / 换端口 / 启动停止 / 退出」
//   - 本地 HTTP 服务监听 127.0.0.1，界面用系统浏览器打开
//   - 界面源码与 Electron 版同一份（packages/gui/src/renderer），一字不改
//
// ## 为什么不内置浏览器内核
//
// Electron 的 78 MB 里 77.8 MB 是 Chromium + Node，而我们只用到了
// DOM + CSS 渲染一个表单页。改用系统浏览器后体积降到个位数 MB，
// 代价是界面变成浏览器标签页（用户已确认接受）。
//
// ## 启动参数
//
//	--port <n>       覆盖监听端口（不写入配置，只对本次生效）
//	--no-browser     启动后不自动打开浏览器
//	--console        前台运行并输出日志（默认 Windows 下无控制台窗口）
//	--check          只做自检（配置可读 / 端口可用），不启动托盘
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/kernel"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/notify"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/server"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/tray"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/update"
)

// Version 由构建时通过 -ldflags 注入（见 scripts/build-desktop.mjs）。
var Version = "dev"

func main() {
	var (
		portFlag    = flag.Int("port", 0, "监听端口（覆盖配置，仅本次生效）")
		noBrowser   = flag.Bool("no-browser", false, "启动后不自动打开浏览器")
		checkOnly   = flag.Bool("check", false, "只做自检，不启动托盘")
		versionFlag = flag.Bool("version", false, "打印版本号")
		// --console 只影响日志落点：Windows 下产物是 windowsgui 子系统，
		// 没有控制台时 stderr 无效，这里改为写文件，便于排查。
		consoleFlag = flag.Bool("console", false, "把日志写到文件（便于排查）")
		// --no-tray 不启托盘，前台只跑 HTTP 服务（无桌面会话时使用）
		noTray = flag.Bool("no-tray", false, "不启托盘，只运行本地服务")
	)
	flag.Parse()

	if *versionFlag {
		fmt.Printf("CFPilot Desktop %s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)
		return
	}

	if *consoleFlag {
		// 与配置同目录的 cfpilot.log，追加写入
		dir, err := config.EnsureDir()
		if err == nil {
			if f, ferr := os.OpenFile(dir+string(os.PathSeparator)+"cfpilot.log",
				os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); ferr == nil {
				log.SetOutput(f)
				defer func() { _ = f.Close() }()
			}
		}
	}

	// 配置目录必须可写，否则后面写凭据全失败 —— 启动就检查，早失败早报错
	if _, err := config.EnsureDir(); err != nil {
		fatal(err)
	}

	settings, err := config.LoadSettings()
	if err != nil {
		log.Printf("[cfpilot] 读取设置失败，使用默认值：%v", err)
	}
	if *portFlag > 0 {
		if *portFlag < 1 || *portFlag > 65535 {
			fatal(fmt.Errorf("端口 %d 超出范围（1-65535）", *portFlag))
		}
		settings.Port = *portFlag
	}

	if *checkOnly {
		fmt.Printf("配置目录：%s\n", config.SettingsPathForDisplay())
		fmt.Printf("监听端口：%d\n", settings.Port)
		if isPortFree(settings.Port) {
			fmt.Println("端口状态：可用")
		} else {
			fmt.Println("端口状态：已被占用")
		}
		fmt.Printf("版本：%s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)
		return
	}

	// 注入版本号（构建时 ldflags 写入 Version 变量）
	server.SetVersion(Version)

	srv, err := server.New(settings)
	if err != nil {
		fatal(err)
	}
	if err := srv.Start(); err != nil {
		// 端口占用时给出可操作的提示，而不是直接崩
		fatal(fmt.Errorf("%w\n提示：用 --port <端口> 换一个，或先关掉占用该端口的程序", err))
	}

	url := srv.WelcomeURL()
	log.Printf("[cfpilot] 管理界面：%s", url)

	// 启动后自动打开 WebUI。
	//
	// ⚠️ 不再受设置项 OpenBrowserOnStart 控制（2026-10-28）：
	// 那是个默认 false 的开关，用户第一次双击 exe 时浏览器不打开，
	// 表现为「双击了但什么都没发生」—— 极难自解释。
	// 现在只有 --no-browser 能关掉它。
	if !*noBrowser {
		// 给监听器一点时间就绪，再打开浏览器
		go func() {
			time.Sleep(300 * time.Millisecond)
			if err := openBrowser(url); err != nil {
				log.Printf("[cfpilot] 打开浏览器失败，请手动访问 %s：%v", url, err)
			}
		}()
	}

	// --no-tray：不启托盘，前台常驻。
	//
	// 两个用途：
	//   1. 无桌面会话的环境（CI / SSH / 纯命令行 Linux）里 systray 起不来，
	//      这时用本模式只跑 HTTP 服务；
	//   2. 自动化测试要验证服务行为时，避免托盘线程干扰与阻塞。
	if *noTray {
		log.Printf("[cfpilot] 以无托盘模式运行，Ctrl+C 退出")
		// 无托盘也发系统通知（Linux 服务器上能通过桌面通知/日志确认启动）
		notify.ShowViaShell(notify.StartupMessage(url, settings.Port, settings.AllowLAN))
		waitForSignal()
		_ = srv.Stop()
		return
	}

	app := tray.New(srv)
	app.SetRunning(true)
	app.SetOpenHandler(func(u string) {
		if err := openBrowser(u); err != nil {
			log.Printf("[cfpilot] 打开浏览器失败：%v", err)
		}
	})
	app.SetExitHandler(func() {
		_ = srv.Stop()
		os.Exit(0)
	})

	// ---- 后台更新检查 ----
	//
	// 两个独立的版本：
	//   应用更新 = 换 exe（外壳 / 界面 / 优选器）
	//   部署更新 = 换线上内核（数据面 / 控制面）
	//
	// 部署更新的「远程最新内核版本」来自 GitHub Release，
	// 与应用自身版本比较 —— 远程更新时托盘菜单会出现「（有新版 x.y.z）」。
	// 真正的「线上 vs 最新」对比在界面的一键部署页里显示。
	checker := tray.NewUpdateChecker(
		func(ctx context.Context) (*update.CheckResult, error) {
			return update.Check(ctx, server.Version()), nil
		},
		func(ctx context.Context) (*tray.DeployCheckResult, error) {
			info, err := kernel.FetchRemoteInfo(ctx)
			if err != nil {
				return nil, err
			}
			if info == nil {
				return &tray.DeployCheckResult{}, nil
			}
			return &tray.DeployCheckResult{
				RemoteVersion: info.Version,
				RemoteNewer:   kernel.CompareSemver(info.Version, server.Version()) > 0,
			}, nil
		},
	)
	app.SetUpdateChecker(checker)

	// 点菜单项的行为：
	//   「检查应用更新」→ 立刻查一次 + 打开说明页（有新版时说明页已有提示）
	//   「检查部署更新」→ 立刻查一次 + 打开一键部署页
	app.SetCheckAppUpdateHandler(func() {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			st := checker.Check(ctx)
			logUpdateState(st)
			openPage(url, "about")
		}()
	})
	app.SetCheckDeployUpdateHandler(func() {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			st := checker.Check(ctx)
			logUpdateState(st)
			openPage(url, "deploy")
		}()
	})

	// 平时自动检查：启动 20 秒后查一次，之后每小时一次。
	//
	// 延迟 20 秒是为了不和用户第一次打开界面抢网络。
	checker.StartAutoCheck(context.Background(), 20*time.Second, time.Hour, func(st *tray.UpdateState) {
		logUpdateState(st)
		if st.AppHasUpdate {
			notify.ShowViaShell(notify.Message{
				Title: "CFPilot 有新版本",
				Body:  fmt.Sprintf("发现新版本 %s，可从托盘菜单「检查应用更新」查看。", st.AppLatest),
			})
		}
	})

	app.Run()

	// 走到这里有两种可能：
	//   1. 用户在托盘里点了「退出」→ onExit 已 os.Exit(0)，不会到这
	//   2. **托盘启动失败**（图标坏 / 建窗口类失败 / 无桌面会话）→ 消息循环立即返回
	//
	// 第 2 种情况如果直接往下走，进程会静默退出，用户看到的是
	// 「双击毫无反应，托盘也没图标」—— 这个坑实测踩过，极难定位。
	// 所以这里降级为「无托盘模式」：服务继续跑并打开浏览器，至少还能用。
	if app.Failed() {
		log.Printf("[cfpilot] 托盘不可用，降级为无托盘模式（服务继续运行）")
		log.Printf("[cfpilot] 管理界面：%s", url)
		if !*noBrowser {
			if err := openBrowser(url); err != nil {
				log.Printf("[cfpilot] 打开浏览器失败，请手动访问 %s：%v", url, err)
			}
		}
		showMessageBox("CFPilot 托盘无法启动",
			"系统托盘不可用（可能是无桌面会话或图标资源异常）。\n\n"+
				"服务已在后台运行，界面地址：\n"+url+"\n\n"+
				"浏览器会自动打开。关掉本提示后程序继续在后台运行，\n"+
				"需要退出时请用任务管理器结束本进程。")
		waitForSignal()
	}

	_ = srv.Stop()
}

// waitForSignal 阻塞直到收到退出信号。
func waitForSignal() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	<-ch
}

// openPage 打开管理界面的指定页签。
//
// 界面读 URL 的 `page` 参数决定初始页签（cred / deploy / scan / about），
// 所以托盘菜单点「检查部署更新」能直接落到「一键部署」页。
func openPage(baseURL, page string) {
	u := baseURL
	if strings.Contains(u, "?") {
		u += "&page=" + url.QueryEscape(page)
	} else {
		u += "?page=" + url.QueryEscape(page)
	}
	if err := openBrowser(u); err != nil {
		log.Printf("[cfpilot] 打开浏览器失败：%v", err)
	}
}

// logUpdateState 把检查结果记到日志。
func logUpdateState(st *tray.UpdateState) {
	if st == nil {
		return
	}
	if st.AppHasUpdate {
		log.Printf("[cfpilot] 应用有新版本：%s（当前 %s）", st.AppLatest, server.Version())
	}
	if st.DeployHasUpdate {
		log.Printf("[cfpilot] 线上内核有新版本可用：%s", st.DeployLatest)
	}
	if st.Err != "" {
		log.Printf("[cfpilot] 更新检查部分失败：%s", st.Err)
	}
}

// openBrowser 用系统默认浏览器打开 URL。
func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		// Linux：优先 xdg-open，回落其他
		for _, c := range []string{"xdg-open", "sensible-browser", "x-www-browser", "firefox"} {
			if _, err := exec.LookPath(c); err == nil {
				return exec.Command(c, url).Start()
			}
		}
		return fmt.Errorf("未找到可用的浏览器启动命令")
	}
}

// isPortFree 检查 127.0.0.1 上的端口是否可绑定。
func isPortFree(port int) bool {
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

func fatal(err error) {
	log.Printf("[cfpilot] %v", err)
	if runtime.GOOS != "windows" {
		os.Exit(1)
	}
	// Windows 下本程序以 -H=windowsgui 编译，没有控制台；
	// 这里尝试弹一个系统消息框，保证用户看得到错误。
	showMessageBox("CFPilot 启动失败", err.Error())
	os.Exit(1)
}
