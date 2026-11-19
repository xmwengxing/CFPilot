//go:build mesh && android

// Package mobile 是 gomobile 绑定门面（Android +mesh 版）。
//
// gomobile bind 只能绑定简单类型（string/int/bool/[]byte/error），
// 所以这里用 JSON string 传递配置/状态，内部包装 internal/mesh 的 Lifecycle。
//
// Java 侧调用流程：
//  1. VpnService.Builder.establish() 拿到 ParcelFileDescriptor
//  2. m = NewMesh()
//  3. m.Start(configJSON, pfd.detachFd())  // fd ownership 转给 Go
//  4. 定时 m.StatusJSON() 刷新面板
//  5. 停止时 m.Stop()
package mobile

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/mesh"
)

// Mesh 是 gomobile 导出的组网控制器。
type Mesh struct {
	mu     sync.Mutex
	life   mesh.Lifecycle
	ctx    context.Context
	cancel context.CancelFunc
	status string
}

// NewMesh 创建一个 Mesh 实例。
func NewMesh() *Mesh { return &Mesh{status: `{"running":false,"note":"未启动"}`} }

// Start 启动组网。configJSON 是 mesh.Config 的 JSON（字段同桌面版 --mesh-config），
// tunFd 来自 Android VpnService.Builder.establish().detachFd()。
func (m *Mesh) Start(configJSON string, tunFd int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.life != nil {
		return fmt.Errorf("mesh: 已启动，请先 Stop")
	}
	var cfg mesh.Config
	if err := json.Unmarshal([]byte(configJSON), &cfg); err != nil {
		return fmt.Errorf("mesh: 配置 JSON 非法: %w", err)
	}
	// 云监测台上报的版本号由绑定库自报（Android 面板无需知道内核版本）
	if cfg.ClientVersion == "" {
		cfg.ClientVersion = m.Version()
	}
	tun, err := mesh.NewAndroidTun(tunFd, cfg.TunName)
	if err != nil {
		return err
	}
	life := mesh.NewLifecycleWithTun(cfg, tun)
	ctx, cancel := context.WithCancel(context.Background())
	if err := life.Start(ctx); err != nil {
		cancel()
		return err
	}
	m.life = life
	m.ctx = ctx
	m.cancel = cancel
	raw, _ := json.Marshal(life.Status())
	m.status = string(raw)
	return nil
}

// Stop 停止组网并释放 TUN。
func (m *Mesh) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.life == nil {
		return nil
	}
	err := m.life.Stop()
	if m.cancel != nil {
		m.cancel()
	}
	m.life = nil
	m.cancel = nil
	m.status = `{"running":false,"note":"已停止"}`
	return err
}

// StatusJSON 返回当前状态快照（mesh.Status 的 JSON）。
func (m *Mesh) StatusJSON() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.life != nil {
		raw, _ := json.Marshal(m.life.Status())
		m.status = string(raw)
	}
	return m.status
}

// Version 返回绑定库版本（供 Android 侧展示）。
func (m *Mesh) Version() string { return "0.50.0+mesh" }

// IdentityJSON 派生本机节点身份并返回 JSON（供 App 展示 nodeId / 公钥）。
//
// 两个 seed 都是 base64 的 32 字节：任一为空则随机生成，**并在返回值里带上
// 生成的 seeds**。App 必须把它们存下来、下次启动原样传回 —— 否则每次启动
// 都会重新生成密钥，NodeId 变化，对端配置里记的 ID 立刻失效。
//
// 返回：{"nodeId":"<16hex>","identityPublic":"<64hex>","tunnelPublic":"<64hex>",
//
//	"identitySeed":"<base64>","tunnelSeed":"<base64>"}
func (m *Mesh) IdentityJSON(identitySeedB64, tunnelSeedB64 string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	identSeed, err := seedFromBase64OrRandom(identitySeedB64)
	if err != nil {
		return "", fmt.Errorf("mesh: identitySeed 非法: %w", err)
	}
	tunnelSeed, err := seedFromBase64OrRandom(tunnelSeedB64)
	if err != nil {
		return "", fmt.Errorf("mesh: tunnelSeed 非法: %w", err)
	}
	ident, err := mesh.IdentityFromSeeds(identSeed, tunnelSeed)
	if err != nil {
		return "", err
	}
	out, err := json.Marshal(map[string]string{
		"nodeId":         ident.NodeID.Hex(),
		"identityPublic": hex.EncodeToString(ident.IdentityPub),
		"tunnelPublic":   hex.EncodeToString(ident.TunnelPub),
		"identitySeed":   base64.StdEncoding.EncodeToString(identSeed[:]),
		"tunnelSeed":     base64.StdEncoding.EncodeToString(tunnelSeed[:]),
	})
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// seedFromBase64OrRandom 解 base64 的 32 字节种子；空串则随机生成。
func seedFromBase64OrRandom(b64 string) ([32]byte, error) {
	var seed [32]byte
	b64 = strings.TrimSpace(b64)
	if b64 == "" {
		if _, err := rand.Read(seed[:]); err != nil {
			return seed, err
		}
		return seed, nil
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return seed, err
	}
	if len(raw) != 32 {
		return seed, fmt.Errorf("需要 32 字节，实际 %d", len(raw))
	}
	copy(seed[:], raw)
	return seed, nil
}
