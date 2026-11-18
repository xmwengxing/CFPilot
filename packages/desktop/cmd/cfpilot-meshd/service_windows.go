//go:build mesh && windows

package main

import (
	"fmt"
	"log"
	"os"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

const serviceName = "CFPilotMesh"

func runAsService(run func()) {
	if err := svc.Run(serviceName, &meshService{run: run}); err != nil {
		log.Fatalf("[meshd] Windows 服务运行失败: %v", err)
	}
}

type meshService struct{ run func() }

func (s *meshService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const cmdsAccepted = svc.AcceptStop | svc.AcceptShutdown
	changes <- svc.Status{State: svc.StartPending}
	go s.run()
	changes <- svc.Status{State: svc.Running, Accepts: cmdsAccepted}
	for {
		c := <-r
		switch c.Cmd {
		case svc.Interrogate:
			changes <- c.CurrentStatus
		case svc.Stop, svc.Shutdown:
			changes <- svc.Status{State: svc.StopPending}
			return false, 0
		default:
			continue
		}
	}
}

func exePath() (string, error) { return os.Executable() }

func installService() {
	exe, err := exePath()
	if err != nil {
		fmt.Println("安装服务失败:", err)
		return
	}
	m, err := mgr.Connect()
	if err != nil {
		fmt.Println("安装服务失败:", err)
		return
	}
	defer m.Disconnect()
	// ⚠️ 升级必须**删除并重建**服务，不能「已存在就返回」：
	// 服务的 ImagePath 是安装时写死的绝对路径。如果新包装到别的目录，
	// 或同一目录但旧进程还在跑，服务会一直执行**旧二进制**——
	// 表现为「装了新包，报的还是旧版本的错」，且用户完全无从察觉。
	if existing, oerr := m.OpenService(serviceName); oerr == nil {
		derr := existing.Delete()
		existing.Close()
		if derr != nil {
			fmt.Println("检测到旧服务且无法删除（通常是因为它仍在运行）。")
			fmt.Println("请先执行: net stop CFPilotMesh，然后重新运行安装程序。")
			return
		}
		fmt.Println("已移除旧服务（升级），准备按当前路径重新注册")
	}
	s, err := m.CreateService(serviceName, exe, mgr.Config{
		DisplayName: "CFPilot Mesh Daemon",
		StartType:   mgr.StartAutomatic,
	}, "--mesh-daemon")
	if err != nil {
		fmt.Println("安装服务失败:", err)
		return
	}
	defer s.Close()
	_ = eventlog.InstallAsEventCreate(serviceName, eventlog.Error|eventlog.Warning|eventlog.Info)
	fmt.Println("服务已安装：", serviceName)
}

func uninstallService() {
	m, err := mgr.Connect()
	if err != nil {
		fmt.Println("卸载服务失败:", err)
		return
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		fmt.Println("服务不存在")
		return
	}
	defer s.Close()
	_ = s.Delete()
	_ = eventlog.Remove(serviceName)
	fmt.Println("服务已卸载：", serviceName)
}
