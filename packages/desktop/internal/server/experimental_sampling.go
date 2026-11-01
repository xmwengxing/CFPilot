package server

// 自适应网段采样（实验性）的服务端接线。
//
// ## 它解决什么问题
//
// Cloudflare 的 IP 段可用性**因网络而异**：在福建电信测得 0% 的网段，
// 在广东联通可能完全可用。用一份全局静态权重去采样，等于把某个运营商的
// 结论套到所有用户身上。
//
// 开启后：
//   1. 用「运营商 + 地区 + 接入方式」组成**网络档案**身份；
//   2. 采样时参考**该档案**的历史成败调整网段权重，并保留固定探索比例；
//   3. 优选过程中把每个候选的真实成败写回档案，供下一轮使用。
//
// ## 边界
//
// - 默认关闭（桌面版「实验性功能」开关）。
// - 历史只存在本机（配置目录下的 scan-profiles.json），不进 Worker KV。
// - 不同档案**不共享**历史：档案 ID 参与统计桶键。

import (
	"os"
	"path/filepath"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/history"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

// adaptiveContext 是一次优选任务的自适应采样上下文。
type adaptiveContext struct {
	// enabled 为 false 时，后续调用全部退化成原有采样逻辑。
	enabled bool
	// profileID 是本次使用的网络档案 ID（空表示未启用）。
	profileID string
	// profileLabel 是档案的可读名称（界面提示用）。
	profileLabel string
	// store 是本机档案库（历史观测）。
	store *scan.ProfileStore
	// path 是档案库文件路径。
	path string
}

// exploreRateOf 返回当前设置的探索比例（未启用时返回 0）。
func (s *Server) exploreRateOf() float64 {
	settings := normalizeExperimental(s.Settings().Experimental)
	if !settings.AdaptiveSampling {
		return 0
	}
	return settings.ExploreRatio
}

// historyStats 把扫描统计转成历史用的分阶段统计。
//
// 没有统计（例如历史文件来自旧版本）时返回 nil —— 不能用 0 冒充「统计为 0」。
func historyStats(sum *scan.Summary) *history.ScanStats {
	if sum == nil || len(sum.Stats) == 0 {
		return nil
	}
	return &history.ScanStats{
		Candidates: sum.Stats["candidates"],
		TCPOK:      sum.Stats["tcpOk"],
		TLSOK:      sum.Stats["tlsOk"],
		WSOK:       sum.Stats["wsOk"],
		SpeedOK:    sum.Stats["speedOk"],
		ElapsedMs:  int64(sum.Stats["elapsedMs"]),
	}
}

// profileStorePath 返回档案库文件路径。
//
// 放在凭据目录旁边，和历史会话一样属于「本机数据」。
func (s *Server) profileStorePath() string {
	return filepath.Join(s.store.DirPath(), "scan-profiles.json")
}

// cliProfileStorePath 是 CLI 侧的档案库路径。
//
// CLI 与桌面版是两套程序，但**档案 ID 算法完全一致**，
// 所以两边的样本应该能互相看到（同一网络环境下学习可以叠加）。
// 桌面版以自己的文件为主，把 CLI 文件里的观测合并进来。
func (s *Server) cliProfileStorePath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".cfpilot", "network-profiles.json")
}

// loadProfileStore 读取档案库，并合并 CLI 侧的样本。
//
// 合并规则：同一「档案 + 前缀 + 阶段」取**较新**的一条（UpdatedAt 大的胜出）。
// 读不到或损坏时返回空档案（调用方会退化成原有采样）。
func (s *Server) loadProfileStore() *scan.ProfileStore {
	primary := s.profileStorePath()
	store, err := scan.LoadProfileStore(primary)
	if err != nil {
		s.logLevel("网络档案读取失败："+err.Error(), "warn")
		store = scan.NewProfileStore()
	}
	cliPath := s.cliProfileStorePath()
	if cliPath == "" || cliPath == primary {
		return store
	}
	cliStore, err := scan.LoadProfileStore(cliPath)
	if err != nil || cliStore == nil {
		return store
	}
	merged := 0
	for _, o := range cliStore.AllObservations() {
		key := scan.StageObservationKey(o.ProfileID, o.Prefix, o.Stage)
		existing, ok := store.ObservationByKey(key)
		if !ok || o.UpdatedAt.After(existing.UpdatedAt) {
			store.MergeObservation(o)
			merged++
		}
	}
	for _, p := range cliStore.Profiles {
		if _, ok := store.Profiles[p.ID]; !ok {
			store.Profiles[p.ID] = p
		}
	}
	if merged > 0 {
		s.logLevel("已合并 CLI 网络档案的 "+itoa(merged)+" 条观测", "info")
	}
	return store
}

// prepareAdaptive 准备自适应采样上下文。
//
// 开关关闭、档案库损坏等情况一律**退化成原有采样**：
// 实验能力出问题绝不能影响正常优选。
func (s *Server) prepareAdaptive() adaptiveContext {
	settings := normalizeExperimental(s.Settings().Experimental)
	if !settings.AdaptiveSampling {
		return adaptiveContext{}
	}
	path := s.profileStorePath()
	store := s.loadProfileStore()
	profile := store.PutProfile(scan.NetworkProfile{
		ISP:    settings.ISP,
		Region: settings.Region,
		Access: settings.Access,
		Family: "ipv4",
		Source: "manual",
	})
	return adaptiveContext{
		enabled:      true,
		profileID:    profile.ID,
		profileLabel: profileLabel(profile),
		store:        store,
		path:         path,
	}
}

// sampleCandidates 按当前上下文生成候选。
//
// 未启用自适应时与历史行为完全一致（同一套 SampleCandidates 默认语义）。
func (s *Server) sampleCandidates(ctx adaptiveContext, count int, neutral bool) []string {
	if !ctx.enabled {
		return scan.SampleCandidates(scan.SampleOptions{Count: count, Neutral: neutral})
	}
	settings := normalizeExperimental(s.Settings().Experimental)
	return scan.SampleCandidates(scan.SampleOptions{
		Count:        count,
		Neutral:      neutral,
		Adaptive:     &scan.AdaptiveSamplingOptions{ExplorationRatio: settings.ExploreRatio},
		ProfileID:    ctx.profileID,
		Observations: ctx.store.ForProfile(ctx.profileID),
	})
}

// observer 返回写入档案的观察回调（未启用时返回 nil）。
func (s *Server) observer(ctx adaptiveContext) func(ip, stage string, ok bool, latencyMs int64) {
	if !ctx.enabled {
		return nil
	}
	now := time.Now().UTC()
	return func(ip, stage string, ok bool, latencyMs int64) {
		ctx.store.RecordProbeResult(ctx.profileID, ip, stage, ok, "", float64(latencyMs), 0, now)
	}
}

// saveAdaptive 保存档案（未启用时什么都不做）。
func (s *Server) saveAdaptive(ctx adaptiveContext) {
	if !ctx.enabled || ctx.store == nil {
		return
	}
	// 记录「这次用过」：界面据此提示档案是否已过时（换了网络却没改档案）。
	ctx.store.TouchProfile(ctx.profileID, time.Now().UTC())
	if err := ctx.store.Save(ctx.path); err != nil {
		s.logLevel("保存网络档案失败："+err.Error(), "warn")
	}
}

// renameAside 把损坏的档案文件改名留档。
//
// 直接删掉会丢掉用户的历史样本；改名后用户还能自己找回。
func renameAside(path string) error {
	backup := path + ".corrupt-" + time.Now().UTC().Format("20060102T150405Z")
	return os.Rename(path, backup)
}
