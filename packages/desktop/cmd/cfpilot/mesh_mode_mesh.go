//go:build mesh

package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/mesh"
)

// meshConfigJSON 是 --mesh-config 的 JSON 格式（与 mesh.Config 对齐）。
type meshConfigJSON struct {
	NodeID        string `json:"nodeId"` // 8 字节 hex
	NetworkName   string `json:"network"`
	PSK           string `json:"psk"`
	TunnelPrivate string `json:"tunnelPrivate"` // X25519 私钥 hex（可选）
	Listen        string `json:"listen"`
	VirtualIP     string `json:"virtualIp"`
	MTU           int    `json:"mtu"`
	Verbose       bool   `json:"verbose"`
	RelayDomain   string `json:"relayDomain"`
	RelayRoom     string `json:"relayRoom"`
	EnableDegrade bool   `json:"enableDegrade"`
	TunName       string `json:"tunName"`
	Peers         []struct {
		NodeID    string `json:"nodeId"`
		Addr      string `json:"addr"`
		StaticPub string `json:"staticPub"` // 32 字节 hex
		VirtualIP string `json:"virtualIp"` // 对端虚拟 IP
	} `json:"peers"`
}

// runMeshMode 在 +mesh 变体下启动组网节点（前台运行，不启托盘/HTTP 服务）。
func runMeshMode(path string) bool {
	// windowsgui 子系统无控制台：日志写到配置文件同目录的独立文件（按配置名区分，
	// 避免同机多节点写同一文件互相 O_TRUNC 错乱）。
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	logPath := filepath.Join(filepath.Dir(path), "mesh-"+base+".log")
	if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644); err == nil {
		log.SetOutput(f)
		defer f.Close()
	}
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Printf("[mesh] 启动，配置=%s", path)
	raw, err := os.ReadFile(path)
	if err != nil {
		log.Fatalf("[mesh] 读取配置失败: %v", err)
	}
	var j meshConfigJSON
	if err := json.Unmarshal(raw, &j); err != nil {
		log.Fatalf("[mesh] 解析配置失败: %v", err)
	}

	cfg := mesh.Config{
		NetworkName:   j.NetworkName,
		PSK:           j.PSK,
		Listen:        j.Listen,
		VirtualIP:     j.VirtualIP,
		MTU:           j.MTU,
		Verbose:       j.Verbose,
		RelayDomain:   j.RelayDomain,
		RelayRoom:     j.RelayRoom,
		EnableDegrade: j.EnableDegrade,
		TunName:       j.TunName,
	}
	// NodeID
	if j.NodeID != "" {
		b, err := hex.DecodeString(j.NodeID)
		if err != nil || len(b) != 8 {
			log.Fatalf("[mesh] nodeId 必须 8 字节 hex")
		}
		copy(cfg.NodeID[:], b)
	}
	// TunnelPrivate
	if j.TunnelPrivate != "" {
		b, err := hex.DecodeString(j.TunnelPrivate)
		if err != nil || len(b) != 32 {
			log.Fatalf("[mesh] tunnelPrivate 必须 32 字节 hex")
		}
		cfg.TunnelPrivate = b
	}
	for _, p := range j.Peers {
		pub, err := hex.DecodeString(p.StaticPub)
		if err != nil || len(pub) != 32 {
			log.Fatalf("[mesh] peer staticPub 必须 32 字节 hex")
		}
		var id [8]byte
		b, err := hex.DecodeString(p.NodeID)
		if err != nil || len(b) != 8 {
			log.Fatalf("[mesh] peer nodeId 必须 8 字节 hex")
		}
		copy(id[:], b)
		cfg.Peers = append(cfg.Peers, mesh.PeerConfig{
			NodeID:    id,
			Addr:      p.Addr,
			StaticPub: pub,
			VirtualIP: p.VirtualIP,
		})
	}

	lc := mesh.NewLifecycleWithConfig(cfg)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := lc.Start(ctx); err != nil {
		log.Fatalf("[mesh] 启动失败（TUN 需管理员/root）: %v", err)
	}
	defer func() { _ = lc.Stop() }()

	fmt.Printf("[mesh] 组网节点已启动: %s\n", meshStatusString(lc.Status()))
	log.Printf("[mesh] 运行中，Ctrl+C 停止")
	<-ctx.Done()
	return true
}

func meshStatusString(st mesh.Status) string {
	return fmt.Sprintf("node=%s vip=%s peers=%d running=%v", st.NodeID, st.VirtualIP, len(st.Peers), st.Running)
}
