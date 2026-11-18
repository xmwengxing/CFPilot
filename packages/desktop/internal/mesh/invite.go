package mesh

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// 邀请链接（对齐 MobiHop mobihop://join/v1/<base64url(JSON)>，invite.rs:24-55）。
// 用 CFPilot 自己的 scheme 以便区分。
const InviteURIPrefix = "cfpilot-mesh://join/v1/"

// InvitePayload 是邀请链接载荷：发起方把「网络参数 + 自己作为一个 peer」编码进去，
// 对端 join 后自动填入，无需手抄 16hex ID / 64hex 公钥。
type InvitePayload struct {
	V         uint8  `json:"v"`
	Network   string `json:"network"`
	PSK       string `json:"psk"`
	Addr      string `json:"addr"`                // 发起方可达的 IP:端口
	NodeID    string `json:"node_id"`             // 发起方 NodeId（16 hex）
	TunnelPub string `json:"tunnel_pub"`          // 发起方 X25519 静态公钥（64 hex）
	VirtualIP string `json:"virtual_ip"`          // 发起方虚拟 IP
	Suggested string `json:"suggested,omitempty"` // 建议对端虚拟 IP
	Exp       int64  `json:"exp,omitempty"`       // 过期时间 Unix 秒，0=永久
}

// BuildInvite 生成邀请链接。
// ttlSeconds=0 表示永久；>0 则设置过期时间。
func BuildInvite(p InvitePayload, ttlSeconds int64) (string, error) {
	if strings.TrimSpace(p.Network) == "" || p.PSK == "" {
		return "", fmt.Errorf("生成邀请链接需要网络名与 PSK")
	}
	p.V = 1
	if ttlSeconds > 0 {
		p.Exp = time.Now().Unix() + ttlSeconds
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	return InviteURIPrefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

// ParseInvite 解析并校验邀请链接。
func ParseInvite(uri string) (*InvitePayload, error) {
	if !strings.HasPrefix(uri, InviteURIPrefix) {
		return nil, fmt.Errorf("不是有效的 CFPilot mesh 邀请链接（前缀应为 %s）", InviteURIPrefix)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(uri, InviteURIPrefix))
	if err != nil {
		return nil, fmt.Errorf("邀请链接编码非法: %w", err)
	}
	if len(raw) > 8192 {
		return nil, fmt.Errorf("邀请链接过长")
	}
	var p InvitePayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("邀请链接内容非法: %w", err)
	}
	if p.V != 1 {
		return nil, fmt.Errorf("不支持的邀请链接版本 %d", p.V)
	}
	if strings.TrimSpace(p.Network) == "" || p.PSK == "" {
		return nil, fmt.Errorf("邀请链接缺少网络名或 PSK")
	}
	if p.Exp > 0 && time.Now().Unix() >= p.Exp {
		return nil, fmt.Errorf("邀请链接已过期")
	}
	// 校验编码字段
	if p.NodeID != "" {
		if _, err := ParseNodeIDHex(p.NodeID); err != nil {
			return nil, fmt.Errorf("邀请链接里的节点 ID 非法: %w", err)
		}
	}
	return &p, nil
}

// SensitiveWarning 返回邀请链接的敏感提示（PSK 明文在链接里，base64 非加密）。
func SensitiveWarning() string {
	return "邀请链接里包含明文的网络密钥（仅 base64 编码，非加密）。" +
		"泄露=他人可加入你的网络，只能全网轮换 PSK。请勿发到公开群/日志/issue。"
}
