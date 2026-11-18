package mesh

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"github.com/zeebo/blake3"
	"golang.org/x/crypto/curve25519"
)

// Identity 是节点的本地身份（对齐 MobiHop keystore.rs:19-32）：
//   - 身份密钥（Ed25519）→ NodeId = BLAKE3(identity public)[0..8]（identity.rs:117）
//   - 隧道静态密钥（X25519）→ Noise IKpsk2 握手用的静态密钥对
//
// 两者本地生成、持久化到数据目录（0600），用户无需填写。
// NodeId 从公钥派生 => 不可伪造、各节点天然不同。
type Identity struct {
	IdentitySeed [32]byte // Ed25519 seed
	TunnelSeed   [32]byte // X25519 private scalar
	NodeID       NodeID
	IdentityPub  []byte // Ed25519 public (32B)
	TunnelPub    []byte // X25519 public (32B)
}

// LoadOrCreateIdentity 从 dataDir 读取身份，不存在则生成并持久化。
// 文件权限 0600（仅本人可读）。
func LoadOrCreateIdentity(dataDir string) (*Identity, error) {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("mesh identity: 建目录失败: %w", err)
	}
	identPath := filepath.Join(dataDir, "identity.key")
	tunnelPath := filepath.Join(dataDir, "tunnel.key")

	identSeed, err := loadOrCreateSeed(identPath)
	if err != nil {
		return nil, fmt.Errorf("mesh identity: 身份密钥: %w", err)
	}
	tunnelSeed, err := loadOrCreateSeed(tunnelPath)
	if err != nil {
		return nil, fmt.Errorf("mesh identity: 隧道密钥: %w", err)
	}

	priv := ed25519.NewKeyFromSeed(identSeed[:])
	pub := priv.Public().(ed25519.PublicKey)
	id := NodeIDFromIdentityPub(pub)

	tunnelPub, err := curve25519.X25519(tunnelSeed[:], curve25519.Basepoint)
	if err != nil {
		return nil, fmt.Errorf("mesh identity: X25519 公钥派生失败: %w", err)
	}

	return &Identity{
		IdentitySeed: identSeed,
		TunnelSeed:   tunnelSeed,
		NodeID:       id,
		IdentityPub:  []byte(pub),
		TunnelPub:    tunnelPub,
	}, nil
}

// EnsureDistinct 检测并化解 NodeId 冲突（克隆 identity.key / 虚拟机快照复制会
// 让两台机器得到相同 NodeId —— 此时 lessNodeID 双向为 false，握手死锁）。
// 若任一 peerID 与本机相同，自动重新生成身份密钥（持久化），返回新身份。
// 调用方拿到新身份后应更新自己的配置与对端列表里的本机 ID。
func (id *Identity) EnsureDistinct(dataDir string, peerIDs []NodeID) (*Identity, bool, error) {
	conflict := false
	for _, p := range peerIDs {
		if p == id.NodeID {
			conflict = true
			break
		}
	}
	if !conflict {
		return id, false, nil
	}
	// 删除旧密钥文件 → 重新生成
	_ = os.Remove(filepath.Join(dataDir, "identity.key"))
	_ = os.Remove(filepath.Join(dataDir, "tunnel.key"))
	fresh, err := LoadOrCreateIdentity(dataDir)
	if err != nil {
		return id, false, err
	}
	return fresh, true, nil
}

// IdentityFromSeeds 从传入的 seeds 构造身份（提权服务 meshd 用：面板传入密钥，不重新生成）。
func IdentityFromSeeds(identitySeed, tunnelSeed [32]byte) (*Identity, error) {
	priv := ed25519.NewKeyFromSeed(identitySeed[:])
	pub := priv.Public().(ed25519.PublicKey)
	tunnelPub, err := curve25519.X25519(tunnelSeed[:], curve25519.Basepoint)
	if err != nil {
		return nil, err
	}
	return &Identity{
		IdentitySeed: identitySeed,
		TunnelSeed:   tunnelSeed,
		NodeID:       NodeIDFromIdentityPub(pub),
		IdentityPub:  []byte(pub),
		TunnelPub:    tunnelPub,
	}, nil
}

// NodeIDFromIdentityPub 计算 NodeId = BLAKE3(pub)[0..8]（对齐 MobiHop identity.rs:117-120）。
func NodeIDFromIdentityPub(pub []byte) NodeID {
	h := blake3.Sum256(pub)
	var id NodeID
	copy(id[:], h[:8])
	return id
}

// loadOrCreateSeed 读 32 字节种子，不存在则随机生成并写 0600。
func loadOrCreateSeed(path string) ([32]byte, error) {
	var seed [32]byte
	raw, err := os.ReadFile(path)
	if err == nil {
		if len(raw) != 32 {
			return seed, fmt.Errorf("密钥文件长度非法（须 32 字节，实际 %d）", len(raw))
		}
		copy(seed[:], raw)
		return seed, nil
	}
	if !os.IsNotExist(err) {
		return seed, err
	}
	if _, err := rand.Read(seed[:]); err != nil {
		return seed, err
	}
	if err := os.WriteFile(path, seed[:], 0600); err != nil {
		return seed, err
	}
	return seed, nil
}

// ParseNodeIDHex 解析 16 hex 字符串为 NodeID（兼容旧配置的手动 ID）。
func ParseNodeIDHex(s string) (NodeID, error) {
	var id NodeID
	raw, err := hex.DecodeString(s)
	if err != nil || len(raw) != 8 {
		return id, fmt.Errorf("NodeId 须为 16 位 hex，实际 %q", s)
	}
	copy(id[:], raw)
	return id, nil
}

func (n NodeID) Hex() string { return hex.EncodeToString(n[:]) }
