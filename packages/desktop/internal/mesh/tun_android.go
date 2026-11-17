//go:build android

package mesh

import (
	"context"
	"fmt"
	"os"
	"sync"
)

// Android TUN 设备（由 VpnService.Builder.establish() 创建，fd 经 JNI 传入）。
//
// 对齐 MobiHop tappers README:200-203：VpnService 没有 native API 等价物，
// 所以不包装它 —— Java 侧建 TUN，Go 侧只拿 fd 做 Read/Write。
// 地址 / 路由 / MTU 由 VpnService.Builder 下发（addAddress/addRoute/setMtu），
// 不走 Linux 的 ip 命令，也不需要 root。
//
// 协议栈（frame/Noise/AEAD/punch/route）完全不碰 TUN，无需改动。
type androidTun struct {
	name   string
	file   *os.File
	mu     sync.Mutex
	closed bool
}

// NewAndroidTun 从 VpnService 传入的 fd 构造 TunDevice。
// fd 来自 ParcelFileDescriptor.detachFd()（ownership 转移给 Go，Go 负责 Close）。
func NewAndroidTun(fd int, name string) (TunDevice, error) {
	if fd < 0 {
		return nil, fmt.Errorf("mesh android: 非法 TUN fd %d", fd)
	}
	if name == "" {
		name = "tun0"
	}
	return &androidTun{name: name, file: os.NewFile(uintptr(fd), name)}, nil
}

func (t *androidTun) Name() string { return t.name }

// Recv 从 TUN 读一个 IP 包（阻塞，直到有包或 ctx 取消）。
func (t *androidTun) Recv(ctx context.Context) ([]byte, error) {
	// TUN fd 是阻塞式；用 goroutine + select 实现 ctx 取消。
	type res struct {
		b   []byte
		err error
	}
	ch := make(chan res, 1)
	go func() {
		buf := make([]byte, MaxFrame)
		n, err := t.file.Read(buf)
		if n > 0 {
			ch <- res{b: append([]byte(nil), buf[:n]...), err: err}
		} else {
			ch <- res{err: err}
		}
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case r := <-ch:
		return r.b, r.err
	}
}

// Send 向 TUN 写一个 IP 包（VpnService 会把它投递到系统网络栈）。
func (t *androidTun) Send(ctx context.Context, packet []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return fmt.Errorf("mesh android: TUN 已关闭")
	}
	_, err := t.file.Write(packet)
	return err
}

func (t *androidTun) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil
	}
	t.closed = true
	return t.file.Close()
}
