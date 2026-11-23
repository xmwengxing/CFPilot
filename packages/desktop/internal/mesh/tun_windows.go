//go:build windows

package mesh

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows TUN 设备实现（wintun.dll 动态加载，纯 Go syscall，CGO=0 兼容）。
//
// 对齐 MobiHop crates/mobihop-dataplane/src/wintun.rs + vendor/tappers：
//   - DLL 不捆绑：候选路径探测（exe 目录 / data_dir）→ SHA256 校验
//   - 缺失时报错并给官方 URL + 期望哈希（离线手动放置）
//   - WintunCreateAdapter / StartSession / ReceivePacket / SendPacket
//
// 常量来源：MobiHop wintun.rs:18-24（M0 spike C 核验）。

const (
	wintunVersion = "0.14.1"
	wintunURL     = "https://www.wintun.net/builds/wintun-0.14.1.zip"
	wintunDLLSHA  = "e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce"
	wintunRingCap = 0x400000 // 4 MiB session ring

	meshFirewallRuleName    = "CFPilot Mesh Interface Inbound"
	windowsPowerShellPath   = `WindowsPowerShell\v1.0\powershell.exe`
	windowsTunConfigTimeout = 8 * time.Second
)

var (
	wintunDLL  = syscall.NewLazyDLL("wintun.dll")
	procCreate = wintunDLL.NewProc("WintunCreateAdapter")
	procOpen   = wintunDLL.NewProc("WintunOpenAdapter")
	// ⚠️ wintun 0.14.1 的导出名是 **WintunCloseAdapter**（不是 DeleteAdapter，
	// 那个符号不存在，调用会让 syscall 直接 panic，且适配器永远不会被清理）。
	procCloseAdapter = wintunDLL.NewProc("WintunCloseAdapter")
	procStartSession = wintunDLL.NewProc("WintunStartSession")
	procEndSession   = wintunDLL.NewProc("WintunEndSession")
	procReceive      = wintunDLL.NewProc("WintunReceivePacket")
	procReleaseRecv  = wintunDLL.NewProc("WintunReleaseReceivePacket")
	procAllocSend    = wintunDLL.NewProc("WintunAllocateSendPacket")
	procSend         = wintunDLL.NewProc("WintunSendPacket")
	procGetLuid      = wintunDLL.NewProc("WintunGetAdapterLuid")
)

// findWintunDLL 探测 wintun.dll 候选路径并校验 SHA256（wintun.rs:56-79）。
func findWintunDLL(dataDir string) (string, error) {
	exe, _ := os.Executable()
	candidates := []string{
		filepath.Join(filepath.Dir(exe), "wintun.dll"),
		filepath.Join(dataDir, "wintun.dll"),
		filepath.Join(".", "wintun.dll"),
	}
	for _, p := range candidates {
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		sum := sha256.Sum256(raw)
		if hex.EncodeToString(sum[:]) == wintunDLLSHA {
			return p, nil
		}
	}
	return "", fmt.Errorf("mesh wintun: 未找到有效的 wintun.dll（SHA256=%s）。从 %s 下载解压 bin/amd64/wintun.dll 放到 exe 同目录或 data_dir",
		wintunDLLSHA, wintunURL)
}

// CreateTunDevice 实现 TunFactory（Windows，wintun.dll）。
func CreateTunDevice(name string, ipv4 string, mtu int) (TunDevice, error) {
	// 先确保 DLL 存在且哈希正确（候选：exe 同目录、data_dir 环境变量、当前目录）
	dataDir := os.Getenv("CFPILOT_DATA_DIR")
	if _, err := findWintunDLL(dataDir); err != nil {
		return nil, err
	}
	if err := wintunDLL.Load(); err != nil {
		return nil, fmt.Errorf("mesh wintun: LoadLibrary 失败: %w", err)
	}

	namePtr, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	tunnelPtr, err := syscall.UTF16PtrFromString("Wintun")
	if err != nil {
		return nil, err
	}

	// WintunCreateAdapter(name, tunnelType, GUID=nil → 系统生成)
	adapter, _, callErr := procCreate.Call(
		uintptr(unsafe.Pointer(namePtr)),
		uintptr(unsafe.Pointer(tunnelPtr)),
		0,
	)
	if adapter == 0 {
		return nil, fmt.Errorf("mesh wintun: WintunCreateAdapter 失败（需管理员）: %v", callErr)
	}
	session, _, callErr := procStartSession.Call(adapter, wintunRingCap)
	if session == 0 {
		_, _, _ = procCloseAdapter.Call(adapter)
		return nil, fmt.Errorf("mesh wintun: WintunStartSession 失败: %v", callErr)
	}
	// 配置虚拟 IP + /24 掩码（对齐 MobiHop platform::configure，需管理员）。
	// netsh 是 Windows 自带的接口配置工具，避免手工调 IP Helper API。
	if ipv4 != "" {
		out, err := runWindowsNetworkCommand(context.Background(), windowsTunConfigTimeout, "netsh.exe",
			"interface", "ip", "set", "address", "name="+name, "static", ipv4, "255.255.255.0")
		if err != nil {
			_, _, _ = procEndSession.Call(session)
			_, _, _ = procCloseAdapter.Call(adapter)
			return nil, fmt.Errorf("mesh wintun: 配置 IP %s 失败: %w (%s)", ipv4, err, strings.TrimSpace(string(out)))
		}
	}
	return &wintunTun{adapter: adapter, session: session, name: name}, nil
}

// configureNetwork 随组网后台运行。系统网络配置耗时不影响建立隧道。
func (t *wintunTun) configureNetwork(ctx context.Context) {
	if strings.TrimSpace(t.name) == "" {
		return
	}
	if strings.ContainsAny(t.name, "*?[]") {
		log.Print("[mesh wintun] 虚拟网卡名称含通配符，无法按单一接口配置入站规则")
		return
	}
	alias := windowsTunAliasExpression(t.name)
	steps := []struct{ name, script string }{
		{"入站规则", meshFirewallRulePowerShell(alias)},
		{"网络类别", fmt.Sprintf("Set-NetConnectionProfile -InterfaceAlias (%s) -NetworkCategory Private -ErrorAction Stop", alias)},
	}
	for _, step := range steps {
		if ctx.Err() != nil {
			return
		}
		out, err := runWindowsNetworkCommand(ctx, windowsTunConfigTimeout, windowsPowerShellPath,
			"-NoProfile", "-NonInteractive", "-Command", step.script)
		if err != nil && ctx.Err() == nil {
			log.Printf("[mesh wintun] 配置虚拟网卡%s失败: %v (%s)", step.name, err, strings.TrimSpace(string(out)))
		}
	}
}

func runWindowsNetworkCommand(ctx context.Context, timeout time.Duration, executable string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	systemDir, err := windows.GetSystemDirectory()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, filepath.Join(systemDir, executable), args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
	cmd.WaitDelay = 500 * time.Millisecond
	out, err := cmd.CombinedOutput()
	if err != nil && ctx.Err() != nil {
		return out, ctx.Err()
	}
	return out, err
}

// meshFirewallRulePowerShell 返回幂等创建 TUN 入站放行规则的 PowerShell 脚本。
func meshFirewallRulePowerShell(aliasExpression string) string {
	return fmt.Sprintf(`$ErrorActionPreference='Stop'; `+
		`$n=%s; $r=Get-NetFirewallRule -DisplayName '%s' -ErrorAction SilentlyContinue; `+
		`if($r){ $f=$r | Get-NetFirewallInterfaceFilter -ErrorAction SilentlyContinue; `+
		`$aliases=@($f.InterfaceAlias); if(@($r).Count -ne 1 -or @($f).Count -ne 1 -or $aliases.Count -ne 1 -or $aliases[0] -ne $n -or $r.Enabled -ne 'True' -or $r.Action -ne 'Allow' -or $r.Direction -ne 'Inbound' -or $r.Profile -ne 'Any'){ `+
		`Remove-NetFirewallRule -DisplayName '%s' -ErrorAction Stop; $r=$null } }; `+
		`if(-not $r){ New-NetFirewallRule -DisplayName '%s' -Description 'Allow all inbound traffic arriving through the CFPilot virtual mesh adapter' -Direction Inbound -Action Allow -Enabled True -Profile Any -InterfaceAlias $n -ErrorAction Stop | Out-Null }`,
		aliasExpression, meshFirewallRuleName, meshFirewallRuleName, meshFirewallRuleName)
}

func windowsTunAliasExpression(name string) string {
	encoded := base64.StdEncoding.EncodeToString([]byte(name))
	return "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "'))"
}

type wintunTun struct {
	mu      sync.Mutex
	adapter uintptr
	session uintptr
	name    string
	closed  bool
}

func (t *wintunTun) Name() string { return t.name }

func (t *wintunTun) Recv(ctx context.Context) ([]byte, error) {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil, io.EOF
	}
	if err := ctx.Err(); err != nil {
		t.mu.Unlock()
		return nil, err
	}

	var size uint32
	ptr, _, receiveErr := procReceive.Call(t.session, uintptr(unsafe.Pointer(&size)))
	if ptr == 0 {
		t.mu.Unlock()
		if receiveErr == windows.ERROR_HANDLE_EOF {
			return nil, io.EOF
		}
		if receiveErr != windows.ERROR_NO_MORE_ITEMS {
			return nil, fmt.Errorf("mesh wintun: WintunReceivePacket 失败: %w", receiveErr)
		}
		timer := time.NewTimer(2 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			return nil, nil
		}
	}
	buf := make([]byte, int(size))
	copy(buf, unsafe.Slice((*byte)(unsafe.Pointer(ptr)), size))
	_, _, _ = procReleaseRecv.Call(t.session, ptr)
	t.mu.Unlock()
	return buf, nil
}

func (t *wintunTun) Send(ctx context.Context, packet []byte) error {
	if len(packet) == 0 || len(packet) > MaxFrame {
		return fmt.Errorf("mesh wintun: 包长非法 %d", len(packet))
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return io.ErrClosedPipe
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	ptr, _, _ := procAllocSend.Call(t.session, uintptr(len(packet)))
	if ptr == 0 {
		return fmt.Errorf("mesh wintun: WintunAllocateSendPacket 失败（ring 满）")
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(ptr)), len(packet)), packet)
	_, _, _ = procSend.Call(t.session, ptr)
	return nil
}

func (t *wintunTun) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil
	}
	t.closed = true
	if t.session != 0 {
		_, _, _ = procEndSession.Call(t.session)
	}
	if t.adapter != 0 {
		_, _, _ = procCloseAdapter.Call(t.adapter)
	}
	return nil
}
