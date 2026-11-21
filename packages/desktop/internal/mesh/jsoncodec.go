package mesh

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

// JSON 编解码适配（面板 / CLI / meshd 之间用 JSON 传配置）。
//
// ## 为什么需要单独实现
//
// `NodeID` / `PeerConfig.StaticPub` 在 **wire**（MessagePack）上是整数数组/字节序列，
// 但配置 JSON 里 IDE 传的是**十六进制字符串**（16 hex / 64 hex）。
// Go 的 `[8]byte` 与 `[]byte` 默认按「数组 / base64」解码，
// 于是面板传字符串时会直接报：
//
//	json: cannot unmarshal string into Go struct field Config.nodeId of type mesh.NodeID
//
// 这里补上 JSON 层：NodeID 只认 16 hex 字符串；
// 公钥同时接受 64 hex（面板/邀请链接）与 base64（旧 CLI 配置），两种都收。

// MarshalJSON 把 NodeID 输出为 16 位小写 hex 字符串。
func (n NodeID) MarshalJSON() ([]byte, error) { return json.Marshal(n.Hex()) }

// UnmarshalJSON 从 16 位 hex 字符串解析 NodeID。
// 也接受 8 元素整数数组（极少数直接 dump 结构体的调用方），避免再次踩同类坑。
func (n *NodeID) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		// 空串 = 「还没拿到身份」：按零值处理，交给 Lifecycle 用 identitySeed 派生。
		// 直接报错会让「身份接口稍慢一点就点启动」变成 400，用户完全看不懂。
		if strings.TrimSpace(s) == "" {
			*n = NodeID{}
			return nil
		}
		id, perr := ParseNodeIDHex(s)
		if perr != nil {
			return perr
		}
		*n = id
		return nil
	}
	var arr []int
	if err := json.Unmarshal(b, &arr); err != nil {
		return fmt.Errorf("mesh json: nodeId 必须是 16 hex 字符串")
	}
	if len(arr) != 8 {
		return fmt.Errorf("mesh json: nodeId 数组长度应为 8，实际 %d", len(arr))
	}
	for i, v := range arr {
		n[i] = byte(v)
	}
	return nil
}

// UnmarshalJSON 解析对端配置，兼容面板的 camelCase 键与十六进制公钥。
//
// 键名同时接受 `nodeId` / `NodeID` 等大小写变体（encoding/json 对 tag 做忽略大小写匹配），
// 所以老配置（PascalCase）与新面板（camelCase）不用二选一。
func (p *PeerConfig) UnmarshalJSON(b []byte) error {
	var raw struct {
		NodeID    NodeID          `json:"nodeId"`
		Addr      string          `json:"addr"`
		StaticPub json.RawMessage `json:"staticPub"`
		VirtualIP string          `json:"virtualIp"`
		Name      string          `json:"name"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	p.NodeID = raw.NodeID
	p.Addr = raw.Addr
	p.VirtualIP = raw.VirtualIP
	p.Name = raw.Name
	if len(raw.StaticPub) > 0 {
		pub, err := decodeKeyJSON(raw.StaticPub)
		if err != nil {
			return fmt.Errorf("mesh json: peers.staticPub %w", err)
		}
		p.StaticPub = pub
	}
	return nil
}

// MarshalJSON 按面板口径输出对端（十六进制公钥）。
func (p PeerConfig) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		NodeID    NodeID `json:"nodeId"`
		Addr      string `json:"addr"`
		StaticPub string `json:"staticPub"`
		VirtualIP string `json:"virtualIp"`
		Name      string `json:"name,omitempty"`
	}{p.NodeID, p.Addr, hex.EncodeToString(p.StaticPub), p.VirtualIP, p.Name})
}

// decodeKeyJSON 解析公钥：64 hex 或 base64（Std / Raw 都试）。
func decodeKeyJSON(raw json.RawMessage) ([]byte, error) {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("必须是字符串")
	}
	s = strings.TrimSpace(s)
	if len(s) == 64 {
		if b, err := hex.DecodeString(s); err == nil {
			return b, nil
		}
	}
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.RawStdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return nil, fmt.Errorf("格式非法（需 64 hex 或 base64）")
}
