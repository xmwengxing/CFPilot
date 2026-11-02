package server

// 节点域名（数据面域名）的**权威解析**。
//
// ## 为什么不能信部署清单
//
// 真机事故（2026-11-02）：切换账户串写 DATA_HOST 时，
// 部署清单里的 `dataCustomDomain` 已经被写成了**另一个账号**的域名。
// 之后「检查部署状态」照着清单回填输入框 → 用户看不出填错了 → 又写一次。
//
// 所以这里的口径是：**以平台上的真实绑定为准，清单只作参考**。
//
// ## 解析顺序
//
// Workers 形态：
//  1. 该 Worker **实际绑定**的自定义域名（GET /workers/domains，按 service 匹配）
//  2. 没有 → workers.dev 生产域名（`<name>.<account子域>.workers.dev`）
//  3. 账号连 workers.dev 子域都没注册 → 空串 + 提示（让用户手填）
//
// Pages 形态：
//  1. 清单里的自定义域名
//  2. 没有 → pages.dev 子域名
//  3. 都没有 → 空串 + 提示

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/cfapi"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/deploy"
)

// nodeHostResolution 是节点域名的解析结果。
type nodeHostResolution struct {
	// Host 是解析出的节点域名（空串 = 读不到）。
	Host string `json:"host"`
	// Source 是来源说明（Worker 自定义域名 / workers.dev 兜底 / Pages 自定义域名 / pages.dev 子域名）。
	Source string `json:"source"`
	// Warning 是读不到时的提示（Host 为空才有）。
	Warning string `json:"warning,omitempty"`
	// ManifestValue 是清单里记的值（仅供参考，可能已被写脏）。
	ManifestValue string `json:"manifestValue,omitempty"`
	// Stale 为 true 表示清单里的值与平台实际不一致。
	Stale bool `json:"stale"`
}

// resolveNodeHost 解析当前账号下数据面的节点域名。
//
// ⚠️ 必须按**当前账号**查询（用的是本次请求的 token 与 accountID），
// 不能拿缓存或上一个账号的值。
func (s *Server) resolveNodeHost(
	ctx context.Context,
	client *cfapi.Client,
	accountID string,
	m *deploy.Manifest,
) nodeHostResolution {
	res := nodeHostResolution{}
	if m == nil {
		res.Warning = "没有部署清单，无法确定数据面域名"
		return res
	}
	res.ManifestValue = strings.TrimSpace(m.DataCustomDomain)

	if dataPlaneModeOf(m) == "workers" {
		name := strings.TrimSpace(m.DataProject)
		if name == "" {
			res.Warning = "清单里没有数据面 Worker 名，无法确定节点域名"
			return res
		}
		// 1) 平台上的真实绑定
		if domains, err := client.ListWorkerDomains(ctx, accountID); err == nil {
			for _, dm := range domains {
				if dm.Service == name && strings.TrimSpace(dm.Hostname) != "" {
					res.Host = strings.TrimSpace(dm.Hostname)
					res.Source = "Worker 自定义域名"
					res.Stale = res.ManifestValue != "" && !strings.EqualFold(res.ManifestValue, res.Host)
					return res
				}
			}
		}
		// 2) workers.dev 兜底
		if sub, err := client.GetWorkersSubdomain(ctx, accountID); err == nil && strings.TrimSpace(sub) != "" {
			res.Host = deploy.WorkersDevHost(name, sub)
			res.Source = "workers.dev 兜底（未绑定自定义域名）"
			res.Stale = res.ManifestValue != "" && !strings.EqualFold(res.ManifestValue, res.Host)
			return res
		}
		// 3) 读不到
		res.Warning = "读不到数据面的域名（既没有绑定自定义域名，账号也没有 workers.dev 子域）\n" +
			"  → 请手动填写「节点域名」，或到控制台给数据面 Worker 绑定自定义域名。"
		return res
	}

	// Pages 形态：先查项目**实际绑定**的自定义域名，再回落 pages.dev 子域名。
	//
	// 同样不盲信清单：清单里的域名可能早已随项目迁移/改名而过期。
	if p, err := client.GetPagesProject(ctx, accountID, strings.TrimSpace(m.DataProject)); err == nil && p != nil {
		for _, dm := range p.Domains {
			host := strings.TrimSpace(dm)
			if host == "" || strings.HasSuffix(host, ".pages.dev") {
				continue
			}
			res.Host = host
			res.Source = "Pages 自定义域名"
			res.Stale = res.ManifestValue != "" && !strings.EqualFold(res.ManifestValue, host)
			return res
		}
	}
	if host := strings.TrimSpace(m.DataSubdomain); host != "" {
		res.Host = host
		res.Source = "pages.dev 子域名"
		return res
	}
	res.Warning = "清单里没有可用的数据面域名，请手动填写"
	return res
}

// repairManifestNodeHost 在清单记的域名与平台实际不一致时**修正清单**。
//
// 只在不一致时写（一次 KV 写），正常情况零写入。
// 目的是让被写脏的清单自愈：否则「检查部署状态」还会继续回填错域名。
func (s *Server) repairManifestNodeHost(
	ctx context.Context,
	client *cfapi.Client,
	accountID, kvID string,
	m *deploy.Manifest,
	res nodeHostResolution,
) {
	if !res.Stale || res.Host == "" || kvID == "" {
		return
	}
	old := m.DataCustomDomain
	m.DataCustomDomain = res.Host
	if raw, err := json.MarshalIndent(m, "", "  "); err == nil {
		if client.SetKVValue(ctx, accountID, kvID, deploy.ManifestKey, string(raw)) == nil {
			s.logLevel("已修正部署清单里的数据面域名："+old+" → "+res.Host, "ok")
		}
	}
}

// nodeHostContext 给节点域名解析配一个超时（避免拖慢界面）。
func nodeHostContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, 12*time.Second)
}
