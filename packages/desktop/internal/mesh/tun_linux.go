//go:build linux

package mesh

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

// Linux TUN 设备实现（/dev/net/tun + TUNSETIFF ioctl）。
//
// 对齐 MobiHop tappers 的 AsyncFd<Tun>：本实现用 blocking fd + goroutine，
// 上层 TunDevice 接口不变。创建网卡需 CAP_NET_ADMIN（root 或 sudo -n）。

const (
	iffTUN        uint16 = 0x0001
	iffNoPI       uint16 = 0x1000
	tunDevicePath        = "/dev/net/tun"
)

// CreateTunDevice 实现 TunFactory（Linux）。
func CreateTunDevice(name string, ipv4 string, mtu int) (TunDevice, error) {
	fd, err := unix.Open(tunDevicePath, unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("mesh tun: 打开 %s 失败（需要 root/CAP_NET_ADMIN）: %w", tunDevicePath, err)
	}

	ifr, err := unix.NewIfreq(name)
	if err != nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("mesh tun: 网卡名非法: %w", err)
	}
	ifr.SetUint16(iffTUN | iffNoPI)
	if err := ioctlPtr(fd, unix.TUNSETIFF, ifr); err != nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("mesh tun: TUNSETIFF 失败（需要 root）: %w", err)
	}

	t := &linuxTun{
		fd:   fd,
		name: ifr.Name(),
		file: os.NewFile(uintptr(fd), tunDevicePath),
	}
	if mtu > 0 {
		// MTU 设置 best-effort：失败不影响运行（默认 1500 能承载 1432 帧），
		// 且不同内核 Ifreq union 布局有差异，不让它阻塞组网。
		_ = t.setMTU(mtu)
	}
	// 配置虚拟 IP + /24（对齐 MobiHop platform::configure；需 root/CAP_NET_ADMIN）
	if ipv4 != "" {
		out, err := exec.Command("ip", "addr", "add", ipv4+"/24", "dev", t.name).CombinedOutput()
		if err != nil && !strings.Contains(string(out), "File exists") {
			_ = t.Close()
			return nil, fmt.Errorf("mesh tun: 配置 IP %s 失败（需 root）: %v (%s)", ipv4, err, string(out))
		}
		_, _ = exec.Command("ip", "link", "set", t.name, "up").CombinedOutput()
	}
	return t, nil
}

// ioctlPtr 用 SYS_IOCTL 传指针（x/sys/unix 的 IoctlSetInt 只能传 int）。
func ioctlPtr(fd int, req uint, ifr *unix.Ifreq) error {
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), uintptr(req), uintptr(unsafe.Pointer(ifr)))
	if errno != 0 {
		return errno
	}
	return nil
}

type linuxTun struct {
	fd   int
	name string
	file *os.File
}

func (t *linuxTun) Name() string { return t.name }

func (t *linuxTun) setMTU(mtu int) error {
	ifr, err := unix.NewIfreq(t.name)
	if err != nil {
		return err
	}
	ifr.SetUint32(uint32(mtu))
	if err := ioctlPtr(t.fd, unix.SIOCSIFMTU, ifr); err != nil {
		return fmt.Errorf("mesh tun: 设置 MTU 失败（需要 root）: %w", err)
	}
	return nil
}

func (t *linuxTun) Recv(ctx context.Context) ([]byte, error) {
	buf := make([]byte, MaxFrame)
	// ⚠️ 不能用阻塞 Read：Linux 上 close(fd) **不会**唤醒阻塞中的 read，
	// Stop() 会一直等这条读循环 ⇒ 「停止组网」要等到下一次流量到来才返回
	// （真机实测 56 秒）。这里用 poll(100ms) 轮询 + ctx 检查，保证能及时退出。
	pfd := []unix.PollFd{{Fd: int32(t.fd), Events: unix.POLLIN}}
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		n, err := unix.Poll(pfd, 100)
		if err != nil {
			if err == unix.EINTR {
				continue
			}
			return nil, err
		}
		if n == 0 {
			continue // 超时：回上去检查 ctx
		}
		rn, rerr := t.file.Read(buf)
		if rerr != nil {
			return nil, rerr
		}
		return buf[:rn], nil
	}
}

func (t *linuxTun) Send(ctx context.Context, packet []byte) error {
	n, err := t.file.Write(packet)
	if err != nil {
		return err
	}
	if n != len(packet) {
		return fmt.Errorf("mesh tun: 短写 %d/%d", n, len(packet))
	}
	return nil
}

func (t *linuxTun) Close() error { return t.file.Close() }
