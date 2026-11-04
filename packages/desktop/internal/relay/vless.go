package relay

import (
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
)

// VLESS 常量（见 RFC 无、以项目协议实现为准）。
const (
	vlessVersion  byte = 0x00
	vlessCmdTCP   byte = 0x01
	vlessAtypIPv4 byte = 0x01
	// vlessReplayHeaderLen 是响应头的前两字节：版本 + addons 长度。
	vlessReplayHeaderLen = 2
)

// ParseUUID 把带连字符或裸十六进制都解析成 16 字节。
//
// 订阅里给的是 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`，但用户手抄时
// 常把连字符丢掉 —— 两种都收。
func ParseUUID(raw string) ([16]byte, error) {
	var out [16]byte
	clean := strings.ReplaceAll(strings.TrimSpace(raw), "-", "")
	if len(clean) != 32 {
		return out, fmt.Errorf("UUID 应为 32 位十六进制，实际 %d 位", len(clean))
	}
	bytes, err := hex.DecodeString(clean)
	if err != nil {
		return out, fmt.Errorf("UUID 含非法字符：%w", err)
	}
	copy(out[:], bytes)
	return out, nil
}

// BuildVLESSRequest 构造 VLESS 请求头（CONNECT + IPv4 目标）。
//
// 布局：
//
//	0      版本（0x00）
//	1..16  UUID 原始 16 字节
//	17     addons 长度（0）
//	18     命令 0x01 = TCP
//	19..20 端口（大端）
//	21     地址类型 0x01 = IPv4
//	22..25 地址
func BuildVLESSRequest(uuid [16]byte, ipv4 [4]byte, port uint16) []byte {
	out := make([]byte, 0, 5+4+1+16)
	out = append(out, vlessVersion)
	out = append(out, uuid[:]...)
	out = append(out, 0x00) // addons 长度
	out = append(out, vlessCmdTCP)
	out = append(out, byte(port>>8), byte(port))
	out = append(out, vlessAtypIPv4)
	out = append(out, ipv4[:]...)
	return out
}

// ReadVLESSReply 读响应头并跳过 addons，之后剩下的字节就是隧道数据。
//
// 响应头只有两字节（版本 + addons 长度），但**必须精确消费 addons**，
// 否则残留的 addons 字节会被 TLS 当成记录头，报「wrong version number」。
func ReadVLESSReply(r io.Reader) (version byte, addons []byte, err error) {
	head := make([]byte, vlessReplayHeaderLen)
	if _, err := io.ReadFull(r, head); err != nil {
		return 0, nil, fmt.Errorf("读 VLESS 响应头失败：%w", err)
	}
	version = head[0]
	addonsLen := int(head[1])
	if addonsLen > 0 {
		addons = make([]byte, addonsLen)
		if _, err := io.ReadFull(r, addons); err != nil {
			return 0, nil, fmt.Errorf("读 VLESS addons 失败：%w", err)
		}
	}
	if version != vlessVersion {
		return version, addons, errors.New("VLESS 响应版本不支持")
	}
	return version, addons, nil
}

// ParseIPv4 把 `a.b.c.d` 解析成 4 字节。
func ParseIPv4(ip string) ([4]byte, error) {
	var out [4]byte
	parts := strings.Split(ip, ".")
	if len(parts) != 4 {
		return out, fmt.Errorf("不是合法的 IPv4：%s", ip)
	}
	for i, p := range parts {
		n := 0
		if p == "" || len(p) > 3 {
			return out, fmt.Errorf("不是合法的 IPv4：%s", ip)
		}
		for _, ch := range p {
			if ch < '0' || ch > '9' {
				return out, fmt.Errorf("不是合法的 IPv4：%s", ip)
			}
			n = n*10 + int(ch-'0')
		}
		if n > 255 {
			return out, fmt.Errorf("不是合法的 IPv4：%s", ip)
		}
		out[i] = byte(n)
	}
	return out, nil
}
