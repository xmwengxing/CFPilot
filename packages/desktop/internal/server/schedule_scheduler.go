package server

// 定时优选任务的调度与执行（桌面版）。
//
// ## 范式
//
// 对齐 internal/server/source_scheduler.go 的形状：
// 启动延迟 → 首次检查 → time.Ticker + select(ctx.Done()) 退出。
// 额外有 `running` 互斥：一次扫描要跑几分钟，
// 调度器与用户手动点的优选不能同时跑（它们抢同一把 s.scan 锁）。
//
// ## 为什么用 60 秒轮询而不是「算准下一次、设个定时器」
//
// 轮询的实现简单得多，也不会因为系统休眠 / 时区变化 / 用户改配置而算错。
// 60 秒的粒度对「每天几点跑」的任务完全够用 ——
// 真正的触发时刻由任务的运行窗口（[运行时刻, 运行时刻+30min)）兜住。
//
// ## 错过时刻不补跑
//
// 电脑关机错过了运行时刻，开机后如果补跑，
// 5 个任务会连着跑 5 轮（每轮十几分钟）—— 既刷流量又占满带宽。
// 所以窗口过了就跳过该轮（任务状态记为「skipped」）。

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/deploy"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
	"github.com/xmwengxing/cfpilot/packages/desktop/internal/schedule"
)

const (
	// schedStartDelay 是调度器启动后的首次检查延迟。
	//
	// 刚开机就连着跑扫描没有意义，也让界面首次渲染先完成。
	schedStartDelay = 20 * time.Second
	// schedTick 是调度器的检查间隔。
	schedTick = 60 * time.Second
	// schedMaxRun 是单个任务的最长执行时间。
	//
	// 一轮完整优选（含测速）约 5~10 分钟；留到 15 分钟够用，
	// 超时按失败处理，不让它无限挂着。
	schedMaxRun = 15 * time.Minute
)

// scheduleScheduler 是定时优选任务的调度器。
type scheduleScheduler struct {
	mu sync.Mutex
	// running 表示本进程内已有任务在跑（防止两个任务同时触发）。
	running bool
	// cancel 用于停止调度 goroutine。
	cancel context.CancelFunc
	// lastRun / lastError 是最近一次调度循环的结果，供界面展示。
	lastRun   int64
	lastError string
}

func (c *scheduleScheduler) begin() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.running {
		return fmt.Errorf("已有定时优选任务在执行")
	}
	c.running = true
	return nil
}

func (c *scheduleScheduler) end(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.running = false
	c.lastRun = time.Now().UnixMilli()
	if err != nil {
		c.lastError = err.Error()
	} else {
		c.lastError = ""
	}
}

// status 返回调度器状态（供界面展示）。
func (c *scheduleScheduler) status() (bool, int64, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.running, c.lastRun, c.lastError
}

// startScheduleScheduler 启动调度器。
//
// ⚠️ 必须幂等：换端口会 Stop → Start，start 内部要防重复启动
// （照抄 source_scheduler.go 的 startSourceScheduler）。
func (s *Server) startScheduleScheduler() {
	sched := s.sched
	if sched == nil {
		return
	}
	sched.mu.Lock()
	if sched.cancel != nil {
		sched.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	sched.cancel = cancel
	sched.mu.Unlock()

	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(schedStartDelay):
		}
		s.runDueTasks(ctx)
		ticker := time.NewTicker(schedTick)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.runDueTasks(ctx)
			}
		}
	}()
	log.Printf("[cfpilot] 定时优选调度器已启动（每 %s 检查一次）", schedTick)
}

// stopScheduleScheduler 停止调度器。
func (s *Server) stopScheduleScheduler() {
	if s.sched == nil {
		return
	}
	s.sched.mu.Lock()
	cancel := s.sched.cancel
	s.sched.cancel = nil
	s.sched.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// runDueTasks 检查并执行所有到期的任务。
func (s *Server) runDueTasks(ctx context.Context) {
	tasks := s.scheduleStore().Tasks()
	now := time.Now()
	for _, task := range tasks {
		if !task.IsDue(now) || task.HasRun(now) {
			continue
		}
		s.runScheduledTask(ctx, task)
	}
}

// runScheduledTask 执行单个任务。
//
// 失败不阻断其它任务：每个任务的状态各自记录。
func (s *Server) runScheduledTask(ctx context.Context, task schedule.Task) {
	if err := s.sched.begin(); err != nil {
		// 已有任务在跑 —— 本轮跳过，下一个 tick 再试（仍在运行窗口内）。
		s.logLevel("定时优选：本轮有其它任务在执行，跳过「"+task.Name+"」", "warn")
		return
	}
	defer func() { s.sched.end(nil) }()

	runCtx, cancel := context.WithTimeout(ctx, schedMaxRun)
	defer cancel()

	summary, entries, host, err := s.executeScheduledTask(runCtx, task)
	if err != nil {
		s.finishScheduledTask(task, schedule.StatusFailed, err.Error(), 0, "")
		return
	}
	status, message := schedule.StatusOK, ""
	// ⚠️ 必须识别「国家筛选被放宽」。
	//
	// 国家筛选发生在阶段二之后（机房码只有 101 响应里才有），
	// 筛不到时两端都会**放宽为全量**而不是报错 ——
	// 不识别的话，用户以为这一轮筛的是亚洲组，实际拿到的是全量结果。
	if summary.Stats["countryFilterIgnored"] == 1 {
		status = schedule.StatusRelaxed
		message = "国家筛选未命中，本轮结果已放宽为全量"
	}
	if len(entries) == 0 {
		if message == "" {
			message = "本轮没有可用节点"
		}
	}
	s.finishScheduledTask(task, status, message, len(entries), host)
}

// executeScheduledTask 跑一轮优选并把结果写进本地池。
//
// 返回扫描摘要、入池条目与**实际使用的数据面域名**。
//
// ⚠️ 数据面域名与 WS 路径都是**运行期从该账号的部署清单现取**的 ——
// 用户不需要在界面上填，也不必点「自动识别」：
// 任务用的是「这个账号部署的那个实例」，填的值反而可能对不上。
func (s *Server) executeScheduledTask(ctx context.Context, task schedule.Task) (*scan.Summary, []schedule.PoolEntry, string, error) {
	// ---- 1. 取该任务归属账号的凭据 ----
	//
	// ⚠️ 绝不能回落活跃账号：多账号场景下会串号 ——
	// 用 A 账号的凭据去回填 B 账号的部署。
	profile, err := s.store.Get(task.ProfileID)
	if err != nil || profile == nil {
		return nil, nil, "", fmt.Errorf("归属账号已不存在")
	}
	if strings.TrimSpace(profile.CfToken) == "" {
		return nil, nil, "", fmt.Errorf("归属账号没有 API Token")
	}
	if strings.TrimSpace(profile.AccountID) == "" || strings.TrimSpace(profile.KVNamespaceID) == "" {
		return nil, nil, "", fmt.Errorf("归属账号没有检测账号或选择 KV")
	}

	// ---- 2. 读部署清单与 KV 配置：数据面域名 / WS 路径 / XHTTP 路径 ----
	client := s.newCFClient(profile.CfToken)
	readCtx, cancelRead := context.WithTimeout(ctx, 20*time.Second)
	defer cancelRead()
	raw, ok := client.GetKVValue(readCtx, profile.AccountID, profile.KVNamespaceID, deploy.ManifestKey)
	if !ok || strings.TrimSpace(raw) == "" {
		return nil, nil, "", fmt.Errorf("没有找到部署清单，请先完成一次部署")
	}
	var m deploy.Manifest
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, nil, "", fmt.Errorf("部署清单格式损坏")
	}
	host := strings.TrimSpace(m.DataCustomDomain)
	if host == "" {
		host = normalizePagesHost(m.DataSubdomain)
	}
	if host == "" {
		return nil, nil, "", fmt.Errorf("清单里没有可用的数据面域名")
	}
	wsPath := strings.TrimSpace(m.Credentials.WSPath)
	if wsPath == "" {
		wsPath = scan.ProbeDefaultPath
	}
	xhttpPath := "/xhttp"
	// WS / XHTTP 路径以 KV 的 CONFIG 为准（部署时写进去的那份）——
	// 清单里的 Credentials.WSPath 只是部署当时的快照，重新部署后可能已改。
	if rawCfg, ok := client.GetKVValue(readCtx, profile.AccountID, profile.KVNamespaceID, deploy.ConfigKey); ok && rawCfg != "" {
		var cfg struct {
			WsPath    string `json:"wsPath"`
			XhttpPath string `json:"xhttpPath"`
		}
		if err := json.Unmarshal([]byte(rawCfg), &cfg); err == nil {
			if v := strings.TrimSpace(cfg.WsPath); v != "" {
				wsPath = v
			}
			if v := strings.TrimSpace(cfg.XhttpPath); v != "" {
				xhttpPath = v
			}
		}
	}
	if !strings.HasPrefix(wsPath, "/") {
		wsPath = "/" + wsPath
	}
	if !strings.HasPrefix(xhttpPath, "/") {
		xhttpPath = "/" + xhttpPath
	}

	// ---- 3. 采样候选 ----
	adaptive := s.prepareAdaptive()
	family, ipv6Env, extraIPv6 := s.resolveFamily(task.Scan.Family, host)
	sample := task.Scan.Sample
	if sample <= 0 {
		sample = schedule.BuiltinSample
	}
	// 带国家筛选时用中性采样（放弃网段可用率权重）——
	// 与手动优选 / CLI 的口径一致。
	candidates := s.sampleCandidates(adaptive, sample, len(task.Scan.Countries) > 0, family, extraIPv6)
	if len(candidates) == 0 {
		return nil, nil, "", fmt.Errorf("未能生成候选 IP")
	}
	if ipv6Env != nil && ipv6Env.Status != scan.IPv6EnvOK {
		s.logLevel("定时优选："+ipv6Env.Message, "warn")
	}

	// ---- 4. 扫描 ----
	throttle := scan.NewProgressThrottle()
	summary, err := scan.Run(ctx, scan.Options{
		Host:             host,
		Port:             443,
		WSPath:           wsPath,
		ProbePath:        scan.ProbeDefaultPath,
		ProbeTransport:   task.Scan.ProbeTransport,
		XHTTPPath:        xhttpPath,
		Candidates:       candidates,
		Countries:        task.Scan.Countries,
		SkipSpeed:        task.Scan.SpeedMode == "off",
		TwoStageSpeed:    task.Scan.SpeedMode == "two",
		SpeedDurationMs:  task.Scan.SpeedDurationMs,
		SpeedConnections: task.Scan.SpeedConnections,
		Top:              task.Scan.Top,
		MinSpeedMBps:     task.MinSpeedMBps,
		// 严格校验与真实隧道校验：凭据来自部署清单，只用于本地校验，
		// 不写日志、不回传前端。
		VerifyPayload:  true,
		UUID:           strings.TrimSpace(m.Credentials.UUID),
		TrojanPassword: strings.TrimSpace(m.Credentials.TrojanPassword),
		ProbeObserver:  s.observer(adaptive),
		Progress: func(p scan.Progress) {
			if !throttle.ShouldReport(p) {
				return
			}
			msg := p.Message
			if p.Total > 0 {
				msg = fmt.Sprintf("%s（%d/%d）", p.Message, p.Done, p.Total)
			}
			s.logf(msg)
		},
	})
	if err != nil {
		return nil, nil, "", err
	}

	// ---- 5. 写优选历史（与手动优选同一套留底，便于回看与复测）----
	s.saveScanHistory("scheduled", host, wsPath, scan.ProbeDefaultPath,
		task.Scan.SpeedMode == "off", summary.Entries, "", historyStats(summary), false, 0)

	// ---- 6. 写本地 IP 池（IP 去重覆盖）----
	entries := make([]schedule.PoolEntry, 0, len(summary.Entries))
	for _, e := range summary.Entries {
		entries = append(entries, schedule.PoolEntry{
			IP:        e.IP,
			Port:      e.Port,
			ProfileID: task.ProfileID,
			TaskID:    task.ID,
			TaskName:  task.Name,
			Speed:     e.Speed,
			Latency:   e.Latency,
			Colo:      e.Colo,
			Family:    e.Family,
			// 备注用既有的 preferredRemark 生成 —— 格式只有一处定义，
			// 本包不重复实现（格式漂移会让面板认不出备注）。
			Remark: preferredRemark(e),
			At:     schedule.NowMS(),
		})
	}
	st := s.scheduleStore()
	st.UpdatePool(func(cur []schedule.PoolEntry) []schedule.PoolEntry {
		next, _ := schedule.AddEntries(cur, entries)
		schedule.SortPool(next)
		return next
	})
	return summary, entries, host, nil
}

// publishTaskStatus 广播任务状态变化（SSE 事件 `task-status`）。
//
// 界面靠它把「运行中 / 完成 / 失败」实时反映到任务清单上 ——
// 定时任务是无人值守的，界面开着时用户需要看到它确实在跑。
func (s *Server) publishTaskStatus(task schedule.Task, status, message string, count int) {
	if s.events == nil {
		return
	}
	s.events.publish("task-status", map[string]any{
		"taskId":  task.ID,
		"name":    task.Name,
		"status":  status,
		"message": message,
		"count":   count,
		"at":      schedule.NowMS(),
	})
}

// finishScheduledTask 回写任务状态。
//
// host 是本轮实际用的数据面域名 —— 记进任务里，用户能确认
// 「任务跑的是这个账号部署的那个实例」，重新部署换域名后也看得出来。
func (s *Server) finishScheduledTask(task schedule.Task, status, message string, count int, host string) {
	now := schedule.NowMS()
	st := s.scheduleStore()
	_ = st.UpdateTasks(func(tasks []schedule.Task) []schedule.Task {
		for i := range tasks {
			if tasks[i].ID != task.ID {
				continue
			}
			tasks[i].LastRunAt = now
			tasks[i].LastStatus = status
			tasks[i].LastMessage = message
			tasks[i].LastCount = count
			if host != "" {
				tasks[i].LastHost = host
			}
			tasks[i].UpdatedAt = now
		}
		return tasks
	})
	if message != "" {
		s.logLevel(fmt.Sprintf("定时优选「%s」：%s（%d 条）", task.Name, message, count), "info")
	} else {
		s.logLevel(fmt.Sprintf("定时优选「%s」完成：%d 条入池", task.Name, count), "ok")
	}
	s.publishTaskStatus(task, status, message, count)
}
