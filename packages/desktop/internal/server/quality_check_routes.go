package server

// 「质量检测」：把一条优选结果的证据补齐，并写回优选历史。
//
//	window.cfpilot.runQualityCheck({ sessionId, ip, port, withSpeed? })
//	  → POST /api/scan/quality-check
//
// ## 为什么要有这个接口
//
// 早前只有「质量报告」：**只读**本地已保存的证据。
// 于是刚跑完的优选里，PONG、真实隧道、纯净度这些字段全是「未执行」——
// 明明都能测，报告却交不出结论，用户只能看到一堆「未执行」。
//
// 现在改成「质量检测」：点一次就把**能做的都做一遍**：
//  1. 分层复测（TCP → TLS → WS101 + PING → 真实隧道，可选测速）
//     —— 直接复用优选与复测的同一套探测原语，结论写回历史条目；
//  2. IP 纯净度（公开信誉画像 + 归属）—— 写回同一条目；
//  3. 返回重建后的完整报告。
//
// ## 参数一律取历史会话，不取界面表单
//
// 历史会话里存了当次优选用的 host / wsPath / probePath。
// 用表单值会打到别的域名上，结论就与这条 IP 的优选记录对不上了。
//
// ## 凭据
//
// 真实隧道校验需要 UUID / Trojan 口令。界面拿不到就由后端从**本机保存的
// KV 配置**里读（部署时写进去的 uuid / trojanPassword）；读不到就跳过
// 隧道校验，报告如实显示「未执行」，绝不假装通过。

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/deploy"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/history"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

// maxQualityCheckTargets 是单次质量检测的目标数上限。
//
// 质量检测是「给某一条 IP 补证据」，不是批量扫描器；上限挡住误用。
const maxQualityCheckTargets = 20

// qualityCheckRequest 是质量检测的请求体。
type qualityCheckRequest struct {
	SessionID string `json:"sessionId"`
	IP        string `json:"ip"`
	Port      int    `json:"port"`
	// WithSpeed 是否带真实下行测速（慢，但能把「性能」一节补全）。
	WithSpeed bool `json:"withSpeed"`
	// UUID / TrojanPassword 可由界面显式传入；留空则后端从本机 KV 配置读。
	UUID           string `json:"uuid"`
	TrojanPassword string `json:"trojanPassword"`
}

// handleQualityCheck 对选中的 IP 补齐质量证据并写回历史。
func (s *Server) handleQualityCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "仅支持 POST"})
		return
	}
	var req qualityCheckRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求体不是合法 JSON"})
		return
	}

	sessionID := strings.TrimSpace(req.SessionID)
	ip := strings.TrimSpace(req.IP)
	if sessionID == "" || len(sessionID) > 256 || net.ParseIP(ip) == nil || req.Port < 1 || req.Port > 65535 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "需要合法的 sessionId、IP 与端口"})
		return
	}

	st := s.historyStore()
	sessions, err := st.Load()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "读取优选历史失败：" + err.Error()})
		return
	}
	var sess *history.Session
	for i := range sessions {
		if sessions[i].ID == sessionID {
			sess = &sessions[i]
			break
		}
	}
	if sess == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "未找到该优选历史会话"})
		return
	}
	// 目标必须在这条会话里：否则报告与历史对不上。
	found := false
	for _, e := range sess.Entries {
		if e.IP == ip && e.Port == req.Port {
			found = true
			break
		}
	}
	if !found {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "该 IP 不在这次优选结果里"})
		return
	}

	host := strings.TrimSpace(sess.Host)
	if host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "这次优选没有记录数据面域名，无法复测"})
		return
	}

	// 凭据：界面传的优先，否则从本机 KV 配置读。
	uuid := strings.TrimSpace(req.UUID)
	trojanPassword := strings.TrimSpace(req.TrojanPassword)
	if uuid == "" && trojanPassword == "" {
		uuid, trojanPassword = s.readLocalTunnelCredentials()
	}

	// ⚠️ 不能绑 r.Context()：检测要跑十几秒，请求断开就全废。
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	s.logf(fmt.Sprintf("质量检测：%s（域名 %s%s）", ip, host, map[bool]string{true: "，带测速", false: ""}[req.WithSpeed]))

	// ---- 1. 分层复测：把「未执行」的协议证据补齐 ----
	results := scan.TestIPs(ctx, []scan.TestTarget{{IP: ip, Port: req.Port}}, scan.TestOptions{
		Host:           host,
		WSPath:         sess.WSPath,
		ProbePath:      sess.ProbePath,
		WithSpeed:      req.WithSpeed,
		VerifyPayload:  true,
		UUID:           uuid,
		TrojanPassword: trojanPassword,
		Concurrency:    1,
		PerIPTimeout:   30 * time.Second,
	})
	// 复测结论写回历史条目（同时重建该条目的质量报告）。
	if err := st.UpdateEntryTests(sessionID, results, req.WithSpeed); err != nil {
		s.logLevel("写回复测结论失败："+err.Error(), "warn")
	}

	// ---- 2. IP 纯净度（公开信誉画像 + 归属）----
	purity := s.fetchQualityPurity(ctx, ip)

	// ---- 3. 把纯净度并进该条目的质量报告 ----
	report, err := st.QualityReport(sessionID, ip, req.Port)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	report.Purity = purity
	report.Version = 1
	report.IP = ip
	report.Port = req.Port
	if err := st.SaveQualityReport(sessionID, *report); err != nil {
		s.logLevel("保存纯净度结论失败："+err.Error(), "warn")
	}

	final, err := st.QualityReport(sessionID, ip, req.Port)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"report":  final,
		"results": results,
	})
}

// fetchQualityPurity 查询候选 IP 的公开信誉画像并转成报告结构。
//
// 失败不阻断：报告里如实标注「失败」，其余字段照常给。
func (s *Server) fetchQualityPurity(ctx context.Context, ip string) history.QualityPurity {
	res := scan.FetchPurity(ctx, ip)
	out := history.QualityPurity{
		Status:      "available",
		Risk:        res.Risk,
		Score:       res.Score,
		Blacklists:  res.Blacklists,
		ASN:         res.ASN,
		ISP:         res.ISP,
		Org:         res.Org,
		Country:     res.Country,
		CountryCode: res.CountryCode,
		City:        res.City,
		ObservedAt:  res.ObservedAt,
		Scenarios:   make([]history.PurityScenario, 0, 4),
	}
	if res.Flags.Datacenter {
		out.Flags = append(out.Flags, "机房")
	}
	if res.Flags.Server {
		out.Flags = append(out.Flags, "服务器")
	}
	if res.Flags.PublicProxy {
		out.Flags = append(out.Flags, "公开代理")
	}
	if res.Flags.WebProxy {
		out.Flags = append(out.Flags, "网页代理")
	}
	if res.Flags.Residential {
		out.Flags = append(out.Flags, "住宅")
	}
	if res.Flags.VPN {
		out.Flags = append(out.Flags, "VPN")
	}
	if res.Flags.Tor {
		out.Flags = append(out.Flags, "Tor")
	}
	if res.Flags.Bot {
		out.Flags = append(out.Flags, "搜索引擎爬虫")
	}
	for _, sc := range scan.PurityScenarios(res) {
		out.Scenarios = append(out.Scenarios, history.PurityScenario{
			Label:   sc.Label,
			Verdict: sc.Verdict,
			Reason:  sc.Reason,
		})
	}
	if res.Error != "" {
		// 部分成功也算可用：信誉拿到了但归属没拿到，仍然是有效结论。
		if res.Score != nil || res.Risk != "unknown" {
			out.Status = "available"
			out.Reason = res.Error
		} else {
			out.Status = "failed"
			out.Reason = res.Error
		}
	}
	return out
}

// readLocalTunnelCredentials 从本机保存的 KV 配置里读隧道凭据。
//
// 部署时把 uuid / trojanPassword 写进了 CONFIG，因此这里能拿到真实凭据，
// 质量检测的「真实隧道」一项就可以真的跑起来，不用用户手抄。
//
// 读不到就返回空串 —— 调用方据此跳过隧道校验（报告显示「未执行」）。
func (s *Server) readLocalTunnelCredentials() (uuid string, trojanPassword string) {
	profile, err := s.store.Active()
	if err != nil || profile == nil || strings.TrimSpace(profile.CfToken) == "" {
		return "", ""
	}
	if strings.TrimSpace(profile.AccountID) == "" || strings.TrimSpace(profile.KVNamespaceID) == "" {
		return "", ""
	}
	client := s.newCFClient(profile.CfToken)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	raw, ok := client.GetKVValue(ctx, profile.AccountID, profile.KVNamespaceID, deploy.ConfigKey)
	if !ok || strings.TrimSpace(raw) == "" {
		return "", ""
	}
	var cfg struct {
		UUID           string `json:"uuid"`
		TrojanPassword string `json:"trojanPassword"`
	}
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return "", ""
	}
	return strings.TrimSpace(cfg.UUID), strings.TrimSpace(cfg.TrojanPassword)
}
