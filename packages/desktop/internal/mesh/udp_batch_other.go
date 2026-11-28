//go:build !linux || (!amd64 && !arm64)

package mesh

import "net"

// newHubPacketReader 返回单包读实现。
//
// 非 Linux（Windows / macOS / BSD）与 Linux 的 32 位架构走这里：没有可用的
// recvmmsg，逐包 ReadFromUDP 的行为与 W3 之前一致。批读只是系统调用摊薄，
// 不影响协议语义，因此两边可以共存。
func newHubPacketReader(conn *net.UDPConn) hubPacketReader {
	return &singleReader{conn: conn}
}
