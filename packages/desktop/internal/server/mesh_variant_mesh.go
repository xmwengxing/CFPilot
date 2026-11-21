//go:build mesh

package server

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/mesh"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

// meshdAddr 是提权守护进程的本地 API 地址（安装时注册为服务）。
const meshdAddr = "http://127.0.0.1:19727"

// registerMeshControlRoutes 把面板/托盘的 mesh 控制请求转发到提权守护进程 meshd。
//
// 设计：面板 server 已带 guard（Session Cookie + Host/Origin 校验），
// 所以这里复用 s.guard，再把请求原样转给 meshd（普通进程不碰 TUN，提权只在 meshd）。
func (s *Server) registerMeshControlRoutes(mux *http.ServeMux) {
	for _, p := range []string{
		"/api/mesh/status", "/api/mesh/start", "/api/mesh/stop", "/api/mesh/peers", "/api/mesh/profiles",
		// 版本自报：排查「装了新包但服务还是旧二进制」时对照用
		"/api/mesh/version",
	} {
		mux.HandleFunc(p, s.guard(s.handleMeshProxy))
	}
	// 身份与邀请链接：纯本地处理（不提权、不碰 TUN），由面板进程生成/持久化
	mux.HandleFunc("/api/mesh/identity", s.guard(s.handleMeshIdentity))
	mux.HandleFunc("/api/mesh/invite/build", s.guard(s.handleMeshInviteBuild))
	mux.HandleFunc("/api/mesh/invite/parse", s.guard(s.handleMeshInviteParse))
	// 组网入口优选：对候选做「盲中继专用」WSS 探测（打房间路径、一次性 peer_id）。
	mux.HandleFunc("/api/mesh/relay-scan", s.guard(s.handleMeshRelayScan))
	// 组网候选源：内置清单 + 按 URL 拉取第三方优选 IP 清单（保留端口）。
	mux.HandleFunc("/api/mesh/entry-sources", s.guard(s.handleMeshEntrySources))
	mux.HandleFunc("/api/mesh/entry-fetch", s.guard(s.handleMeshEntryFetch))
}

// handleMeshEntrySources 返回内置的组网候选源清单。
func (s *Server) handleMeshEntrySources(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sources": scan.BuiltinMeshEntrySources()})
}

// handleMeshEntryFetch 拉取一份第三方清单并解析成候选（可传内置源 id 或任意 HTTPS URL）。
//
// 只用于「组网入口」：清单里的反代入口（非 CF 网段、非 443 端口）不会进外部数据源池，
// 但恰恰是盲中继最有用的候选。拉回来的只是**候选**，仍须探测 101 才算可用。
func (s *Server) handleMeshEntryFetch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req struct {
		SourceID string `json:"sourceId"`
		URL      string `json:"url"`
		Max      int    `json:"max"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}
	target := strings.TrimSpace(req.URL)
	if target == "" {
		for _, src := range scan.BuiltinMeshEntrySources() {
			if src.ID == strings.TrimSpace(req.SourceID) {
				target = src.URL
				break
			}
		}
	}
	if target == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请选择内置候选源或填写清单地址"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	list, err := scan.FetchMeshEntryCandidates(ctx, target, 20*time.Second, req.Max)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"url":        target,
		"candidates": list,
		"count":      len(list),
		"text":       strings.Join(list, "\n"),
	})
}

// handleMeshRelayScan 对候选入口做盲中继专用探测。
//
// 与「入口优选」的区别：目标是盲中继域名 + Worker 房间路径 /mesh/<room>?peer_id=…，
// 判据是「能否 101」+ 握手 RTT。候选留空时取最近一次入口优选历史的 IP。
//
// 注意：每个候选都会真的向 Worker 发起一次 WS 升级（用一次性 peer_id，不碰真实节点），
// 所以候选数有上限（默认 20）、并发有限（默认 4）。
func (s *Server) handleMeshRelayScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}
	var req struct {
		Candidates    []string `json:"candidates"`
		RelayDomain   string   `json:"relayDomain"`
		Room          string   `json:"room"`
		Network       string   `json:"network"`
		PSK           string   `json:"psk"`
		Port          int      `json:"port"`
		TimeoutMs     int      `json:"timeoutMs"`
		MaxCandidates int      `json:"maxCandidates"`
		Attempts      int      `json:"attempts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}
	if strings.TrimSpace(req.RelayDomain) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请先填写盲中继域名"})
		return
	}
	room := strings.TrimSpace(req.Room)
	if room == "" {
		if strings.TrimSpace(req.Network) == "" || req.PSK == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请先填写网络名与网络密钥"})
			return
		}
		psk := mesh.DerivePSK(req.Network, req.PSK)
		tag := mesh.DeriveRoomTag(psk)
		room = hex.EncodeToString(tag[:])
	}

	candidates := req.Candidates
	if len(candidates) == 0 {
		// 缺省候选：最近一次「入口优选」历史里的 IP（跳过组网入口自己）
		if sessions, err := s.historyStore().Load(); err == nil {
			for _, sess := range sessions {
				if sess.Source == "mesh" {
					continue
				}
				for _, e := range sess.Entries {
					if e.IP != "" {
						candidates = append(candidates, e.IP)
					}
					if len(candidates) >= 30 {
						break
					}
				}
				if len(candidates) > 0 {
					break
				}
			}
		}
	}
	if len(candidates) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "没有候选入口：请先跑一次「入口优选」，或在候选框里手动粘贴 IP",
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 150*time.Second)
	defer cancel()
	sum, err := scan.RunMeshEntry(ctx, scan.MeshEntryOptions{
		Candidates:    candidates,
		RelayDomain:   strings.TrimSpace(req.RelayDomain),
		Room:          room,
		DefaultPort:   req.Port,
		TimeoutMs:     req.TimeoutMs,
		MaxCandidates: req.MaxCandidates,
		Attempts:      req.Attempts,
	})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	ok := 0
	for _, it := range sum.Results {
		if it.OK {
			ok++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"results":   sum.Results,
		"relayHost": sum.RelayHost,
		"room":      sum.Room,
		"elapsedMs": sum.ElapsedMs,
		"usable":    ok,
		"total":     len(sum.Results),
	})
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
		"peerName":    p.Alias,
		// 云监测配置（A 生成链接时带上；B 解析后自动填入）
		"monitoringEndpoint":   p.MonitorEndpoint,
		"monitoringToken":      p.MonitorToken,
		"monitoringIntervalMs": p.MonitorIntervalMS,
		"monitorAlias":         p.MonitorAlias,
		"relayDomain":          p.RelayDomain,
		"relayRoom":            p.RelayRoom,
		"relayConnectIp":       p.RelayConnectIP,
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
		// 守护进程没装 / 没启动时，**状态接口**回一份「未运行」而不是 502。
		//
		// 面板每 2 秒轮询一次 /api/mesh/status，若这里回 5xx，日志页会被
		// 「接口 GET /api/mesh/status 返回 502」刷满（真机反馈过）。
		// 未运行是正常状态，不是服务器错误；「组网」页会把 note 显示出来。
		if r.Method == http.MethodGet && r.URL.Path == mesh.APIMeshStatus {
			writeJSON(w, http.StatusOK, map[string]any{
				"running": false,
				"daemon":  false,
				"note":    "mesh 守护进程未运行（请用 +mesh 安装包安装并启动服务）",
			})
			return
		}
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

// variantName 是界面用来区分产物的构建变体标识。
func variantName() string { return "mesh" }

func (s *Server) handleMeshEnabled(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": true})
}
