//go:build linux && (amd64 || arm64)

package mesh

import (
	"net"
	"strconv"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// W3：Linux 批收（recvmmsg）。
//
// 为什么值得做：hub 是单 socket 多 peer，每个数据报一次 recvfrom 就是一次系统调用；
// 多跳 / 中继场景下每秒数千帧时，系统调用本身成了可观测的 CPU 开销。
// recvmmsg 一次取回至多 hubReadBatch 个数据报，把调用次数摊薄到 1/8。
//
// 为什么不用 x/net/ipv4.ReadBatch：它要求 AF_INET socket，而 CFPilot 的 hub
// 默认绑 IPv6 双栈 socket（v4-mapped 帧在同一 socket 上收），x/net 的路由在这里不适用；
// 直接调 SYS_RECVMMSG 才能保留双栈行为。
//
// 为什么只支持 amd64 / arm64：msghdr / mmsghdr 的布局是按架构手写的，32 位架构
// 的指针宽度与对齐都不同。布局错了不是「性能差」而是内存踩踏，所以宁可只覆盖
// 主流 64 位架构，其余架构走单包回退（udp_batch_other.go）。

// mmsghdr 是 recvmmsg 的向量元素：一个 msghdr + 本条实际收到的字节数。
//
// 直接复用 x/sys 生成的 unix.Msghdr（按架构保证与内核一致），只在外面套
// 「长度 + 对齐填充」。两个编译期断言保证 64 位布局：任何架构上 Msghdr ≠ 56
// 或 mmsghdr ≠ 64 都会直接编译失败。
type mmsghdr struct {
	Hdr unix.Msghdr
	Len uint32
	_   [4]byte
}

const (
	_ = uint(unsafe.Sizeof(unix.Msghdr{}) - 56) // 小于 56 字节 ⇒ 编译失败
	_ = uint(56 - unsafe.Sizeof(unix.Msghdr{})) // 大于 56 字节 ⇒ 编译失败
	_ = uint(unsafe.Sizeof(mmsghdr{}) - 64)     // 小于 64 字节 ⇒ 编译失败
	_ = uint(64 - unsafe.Sizeof(mmsghdr{}))     // 大于 64 字节 ⇒ 编译失败
)

// recvmmsgReader 用一次 SYS_RECVMMSG 取回一批数据报。
type recvmmsgReader struct {
	rc    syscall.RawConn
	msgs  []mmsghdr
	iovs  []unix.Iovec
	names []unix.RawSockaddrAny
	lens  []int
}

// newHubPacketReader 优先返回批读实现；拿不到 RawConn 时退回单包读。
func newHubPacketReader(conn *net.UDPConn) hubPacketReader {
	if r, err := newRecvmmsgReader(conn); err == nil {
		return r
	}
	return &singleReader{conn: conn}
}

func newRecvmmsgReader(conn *net.UDPConn) (*recvmmsgReader, error) {
	rc, err := conn.SyscallConn()
	if err != nil {
		return nil, err
	}
	n := hubReadBatch
	return &recvmmsgReader{
		rc:    rc,
		msgs:  make([]mmsghdr, n),
		iovs:  make([]unix.Iovec, n),
		names: make([]unix.RawSockaddrAny, n),
		lens:  make([]int, n),
	}, nil
}

func (r *recvmmsgReader) readBatch(bufs [][]byte, remotes []*net.UDPAddr) (int, error) {
	n := len(bufs)
	if n > hubReadBatch {
		n = hubReadBatch
	}
	// 每轮重填 msghdr：内核会改写 Len / Flags / Namelen，必须复位。
	for i := 0; i < n; i++ {
		buf := bufs[i]
		base := (*byte)(nil)
		if len(buf) > 0 {
			base = &buf[0]
		}
		r.iovs[i] = unix.Iovec{Base: base, Len: uint64(len(buf))}
		r.msgs[i] = mmsghdr{Hdr: unix.Msghdr{
			Name:    (*byte)(unsafe.Pointer(&r.names[i])),
			Namelen: uint32(unsafe.Sizeof(r.names[i])),
			Iov:     &r.iovs[i],
			Iovlen:  1,
		}}
	}
	var (
		got   int
		errno unix.Errno
	)
	// rc.Read 会在 EAGAIN 时把 goroutine park 到 netpoll 上（Go 的 UDP socket 是
	// 非阻塞的），回调返回 true 表示这一轮已经拿到结果或遇到真错误。
	err := r.rc.Read(func(fd uintptr) bool {
		v, _, e := unix.Syscall6(unix.SYS_RECVMMSG,
			fd, uintptr(unsafe.Pointer(&r.msgs[0])), uintptr(n), 0, 0, 0)
		if e != 0 {
			errno = e
			if e == unix.EAGAIN || e == unix.EWOULDBLOCK {
				return false
			}
			return true
		}
		got = int(v)
		return true
	})
	if err != nil {
		return 0, err
	}
	if errno != 0 {
		return 0, errno
	}
	if got <= 0 {
		return 0, nil
	}
	for i := 0; i < got; i++ {
		r.lens[i] = int(r.msgs[i].Len)
		remotes[i] = sockaddrToUDP(&r.names[i])
	}
	return got, nil
}

func (r *recvmmsgReader) length(i int) int {
	if i < 0 || i >= len(r.lens) {
		return 0
	}
	return r.lens[i]
}

// ntohs 把内核写的网络序端口还原成主机序整数。
func ntohs(v uint16) uint16 { return v>>8 | v<<8 }

// sockaddrToUDP 把 recvmmsg 回填的 sockaddr 还原成 net.UDPAddr。
//
// 只处理 AF_INET / AF_INET6：hub 绑的是双栈 socket，其他族不会出现在这里；
// 认不出就返回 nil，由上层按损坏帧处理（不能拿 nil 去查表）。
func sockaddrToUDP(sa *unix.RawSockaddrAny) *net.UDPAddr {
	switch sa.Addr.Family {
	case unix.AF_INET:
		p := (*unix.RawSockaddrInet4)(unsafe.Pointer(sa))
		return &net.UDPAddr{
			IP:   net.IPv4(p.Addr[0], p.Addr[1], p.Addr[2], p.Addr[3]),
			Port: int(ntohs(p.Port)),
		}
	case unix.AF_INET6:
		p := (*unix.RawSockaddrInet6)(unsafe.Pointer(sa))
		ip := make(net.IP, net.IPv6len)
		copy(ip, p.Addr[:])
		zone := ""
		if p.Scope_id != 0 {
			if ifi, err := net.InterfaceByIndex(int(p.Scope_id)); err == nil {
				zone = ifi.Name
			} else {
				zone = strconv.Itoa(int(p.Scope_id))
			}
		}
		return &net.UDPAddr{IP: ip, Port: int(ntohs(p.Port)), Zone: zone}
	}
	return nil
}
