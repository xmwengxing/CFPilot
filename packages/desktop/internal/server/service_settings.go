package server

// 服务设置：局域网访问开关、本机地址查询。
//
// ## 设计说明（2026-10-26 改版）
//
// 早期版本做了独立的 `/service` 服务管理页，用户反馈
// 「多开一次标签页太繁琐」—— 该页面已移除，
// 端口切换与局域网开关**全部收进托盘右键菜单**。
//
// 本文件只保留托盘需要调用的服务端能力：
//   - SetAllowLAN：切换监听地址（127.0.0.1 ↔ 0.0.0.0）
//   - LocalAddresses：列出本机局域网 IP（托盘复制地址用）

import (
	"fmt"
	"log"
	"net"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
)

// SetAllowLAN 开启 / 关闭局域网访问，并重建监听。
//
// 开启后服务监听 0.0.0.0，同一网络的人能访问页面；
// 但业务接口仍需会话 Cookie（靠启动令牌换取），所以看不到业务数据。
//
// 失败时回滚到原设置并重新监听，避免用户点一下就把服务弄没了。
func (s *Server) SetAllowLAN(allow bool) error {
	cur := s.Settings()
	if cur.AllowLAN == allow {
		return nil
	}

	next := cur
	next.AllowLAN = allow
	next.Host = next.EffectiveHost()

	// 先保存设置（即使下面监听失败，至少记录用户意图）
	if err := config.SaveSettings(next); err != nil {
		return fmt.Errorf("保存设置失败：%w", err)
	}

	// 关旧监听 → 用新地址重开
	if err := s.Stop(); err != nil {
		return fmt.Errorf("关闭原监听失败：%w", err)
	}

	s.mu.Lock()
	s.settings = next
	s.mu.Unlock()

	if err := s.Start(); err != nil {
		// 回滚
		s.mu.Lock()
		s.settings = cur
		s.mu.Unlock()
		_ = config.SaveSettings(cur)
		if rbErr := s.Start(); rbErr != nil {
			return fmt.Errorf("切换到 %s 失败（%v），且回滚也失败（%v）",
				next.Host, err, rbErr)
		}
		return fmt.Errorf("切换到 %s 失败：%w（已回滚）", next.Host, err)
	}

	if allow {
		log.Printf("[cfpilot] 已开启局域网访问，监听 %s:%d", next.Host, next.Port)
	} else {
		log.Printf("[cfpilot] 已关闭局域网访问，恢复仅本机")
	}
	return nil
}

// LocalAddresses 返回本机非回环 IPv4 地址（局域网 IP）。
//
// 用途：托盘开启局域网后，把可用地址复制到剪贴板。
func (s *Server) LocalAddresses() []string {
	return localAddresses()
}

// localAddresses 列出本机内网 IPv4 地址。
func localAddresses() []string {
	var out []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() {
				continue
			}
			v4 := ip.To4()
			if v4 == nil {
				continue // 只列 IPv4，IPv6 地址太长不便分享
			}
			if !v4.IsPrivate() && !v4.IsLinkLocalUnicast() {
				continue // 只列内网地址
			}
			out = append(out, v4.String())
		}
	}
	return out
}

// probePortFreeOn 检查在指定地址上端口是否可用。
func probePortFreeOn(port int, host string) error {
	if host == "" {
		host = config.LoopbackHost
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(host, fmt.Sprint(port)))
	if err != nil {
		if isAddrInUse(err) {
			return fmt.Errorf("已被其他程序占用")
		}
		return err
	}
	return ln.Close()
}
