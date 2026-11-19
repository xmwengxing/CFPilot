//go:build mesh

package server

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/mesh"
)

// meshdAddr 是提权守护进程的本地 API 地址（安装时注册为服务）。
const meshdAddr = "http://127.0.0.1:19727"

// registerMeshControlRoutes 把面板/托盘的 mesh 控制请求转发到提权守护进程 meshd。
//
// 设计：面板 server 已带 guard（Session Cookie + Host/Origin 校验），
// 所以这里复用 s.guard，再把请求原样转给 meshd（普通进程不碰 TUN，提权只在 meshd）。
func (s *Server) registerMeshControlRoutes(mux *http.ServeMux) {
	for _, p := range []string{
		"/api/mesh/status", "/api/mesh/start", "/api/mesh/stop", "/api/mesh/peers",
		// 版本自报：排查「装了新包但服务还是旧二进制」时对照用
		"/api/mesh/version",
	} {
		mux.HandleFunc(p, s.guard(s.handleMeshProxy))
	}
	// 身份与邀请链接：纯本地处理（不提权、不碰 TUN），由面板进程生成/持久化
	mux.HandleFunc("/api/mesh/identity", s.guard(s.handleMeshIdentity))
	mux.HandleFunc("/api/mesh/invite/build", s.guard(s.handleMeshInviteBuild))
	mux.HandleFunc("/api/mesh/invite/parse", s.guard(s.handleMeshInviteParse))
}

// handleMeshIdentity 读取/生成本机 mesh 身份（NodeId + 隧道公钥），持久化到数据目录。
// 用户无需填 NodeId；克隆密钥导致的 ID 冲突在 ensureDistinct 里化解。
func (s *Server) handleMeshIdentity(w http.ResponseWriter, r *http.Request) {
	dir := s.store.DirPath()
	ident, err := mesh.LoadOrCreateIdentity(dir)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	// 可选 ?peerIds=id1,id2：若对端里有与本机相同的 ID（克隆密钥场景），自动重生身份
	if raw := r.URL.Query().Get("peerIds"); raw != "" {
		var peers []mesh.NodeID
		for _, s := range strings.Split(raw, ",") {
			if id, e := mesh.ParseNodeIDHex(strings.TrimSpace(s)); e == nil {
				peers = append(peers, id)
			}
		}
		if fresh, changed, e := ident.EnsureDistinct(dir, peers); e == nil && changed {
			ident = fresh
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"nodeId":    ident.NodeID.Hex(),
		"tunnelPub": hex.EncodeToString(ident.TunnelPub),
		// []byte 的 JSON 编码是 base64——mesh.Config.TunnelPrivate/IdentitySeed 直接对接
		"tunnelPrivate": base64.StdEncoding.EncodeToString(ident.TunnelSeed[:]),
		"identitySeed":  base64.StdEncoding.EncodeToString(ident.IdentitySeed[:]),
		"warning":       mesh.SensitiveWarning(),
	})
}

// handleMeshInviteBuild 生成邀请链接。
func (s *Server) handleMeshInviteBuild(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req mesh.InvitePayload
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "参数非法: " + err.Error()})
		return
	}
	// TTL 通过 query 传（?ttl=秒数），0/缺省=永久
	var ttl int64
	if raw := r.URL.Query().Get("ttl"); raw != "" {
		ttl, _ = strconv.ParseInt(raw, 10, 64)
	}
	uri, err := mesh.BuildInvite(req, ttl)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"uri": uri, "warning": mesh.SensitiveWarning()})
}

// handleMeshInviteParse 解析邀请链接，返回可供 UI 一键填入的字段。
func (s *Server) handleMeshInviteParse(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req struct {
		URI string `json:"uri"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "参数非法: " + err.Error()})
		return
	}
	p, err := mesh.ParseInvite(req.URI)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"network": p.Network, "psk": p.PSK,
		"peerNodeId": p.NodeID, "peerAddr": p.Addr,
		"peerPub": p.TunnelPub, "peerVip": p.VirtualIP,
		"suggestedIp": p.Suggested,
		// 云监测配置（A 生成链接时带上；B 解析后自动填入）
		"monitoringEndpoint":   p.MonitorEndpoint,
		"monitoringToken":      p.MonitorToken,
		"monitoringIntervalMs": p.MonitorIntervalMS,
		"monitorAlias":         p.MonitorAlias,
		"warning":              mesh.SensitiveWarning(),
	})
}

func (s *Server) handleMeshProxy(w http.ResponseWriter, r *http.Request) {
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest(r.Method, meshdAddr+r.URL.Path, r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "构造请求失败: " + err.Error()})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": "mesh 守护进程未运行（请先安装并启动 +mesh 服务）: " + err.Error(),
		})
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(body)
}

// meshVariantEnabled 返回当前构建是否启用 +mesh 组网变体（+mesh 版）。
func meshVariantEnabled() bool { return true }

func (s *Server) handleMeshEnabled(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true})
}

