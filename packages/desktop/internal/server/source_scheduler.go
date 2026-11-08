package server

// Phase 3 · 外部数据源定时同步（桌面版）。
//
// 范式对齐 internal/tray/update_check.go 的 StartAutoCheck：
// 启动延迟 → 首次检查 → time.Ticker + select(ctx.Done()) 退出。
// 但额外加了 `running` 互斥：一次同步可能跑几十秒，定时器与用户点
// 「立即同步」不能叠加（update checker 的 Check 是同步阻塞，这里不是）。
//
// 跨进程互斥由本地池的目录锁保证（scan.WithConfigDirLock）；
// `running` 只负责本进程内不重入。

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

const (
	sourceSchedStartDelay = 20 * time.Second
	sourceSchedTick       = 60 * time.Second
	sourceSchedMaxRun     = 5 * time.Minute
)

type sourceScheduler struct {
	mu        sync.Mutex
	running   bool
	cancel    context.CancelFunc
	lastRun   int64
	lastError string
}

func (c *sourceScheduler) begin() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.running {
		return fmt.Errorf("已有数据源同步正在进行，请稍后再试")
	}
	c.running = true
	return nil
}

func (c *sourceScheduler) end(err error) {
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

func (c *sourceScheduler) status() (bool, int64, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.running, c.lastRun, c.lastError
}

// dataHostForLightCheck 尝试用当前账号的数据面域名当 SNI；取不到就用通用值。
//
// 轻量校验只判「TLS 能不能握手」，不要求 SNI 一定是自己的域名；
// 桌面版账号档案里没有稳定的 dataHost 字段，完整优选那条链路才解析它。
func (s *Server) dataHostForLightCheck() string {
	return scan.DefaultLightSNI
}

// runSourceSync 是同步的唯一执行入口（定时器与「立即同步」共用）。
func (s *Server) runSourceSync(ctx context.Context, ids map[string]bool) (scan.SyncReport, error) {
	sched := s.sourceSched
	if sched == nil {
		return scan.SyncReport{}, fmt.Errorf("同步调度器未初始化")
	}
	if err := sched.begin(); err != nil {
		return scan.SyncReport{}, err
	}
	defer func() { sched.end(nil) }()

	runCtx, cancel := context.WithTimeout(ctx, sourceSchedMaxRun)
	defer cancel()
	report := scan.SyncSources(scan.SyncOptions{
		SourceIDs: ids,
		Ctx:       runCtx,
		LightCheck: func(inputs []scan.CandidateInput) []scan.CandidateInput {
			return scan.LightCheckCandidates(runCtx, inputs, scan.LightCheckOptions{
				SNI: s.dataHostForLightCheck(),
			})
		},
	})
	return report, nil
}

// SyncSourcesNow 供「立即同步」API 调用；不传 ids 表示同步全部到期/启用源。
func (s *Server) SyncSourcesNow(ctx context.Context, ids map[string]bool) (scan.SyncReport, error) {
	return s.runSourceSync(ctx, ids)
}

func (s *Server) SourceSchedulerStatus() (bool, int64, string) {
	if s.sourceSched == nil {
		return false, 0, ""
	}
	return s.sourceSched.status()
}

// dueSourceIDs 找出已到同步间隔的启用源。
func dueSourceIDs(now int64) map[string]bool {
	out := map[string]bool{}
	for _, src := range scan.LoadSources().Sources {
		if !src.Enabled {
			continue
		}
		hours := src.IntervalHours
		if hours <= 0 {
			hours = 24
		}
		interval := int64(hours) * 60 * 60 * 1000
		if src.LastSyncAt == 0 || now-src.LastSyncAt >= interval {
			out[src.ID] = true
		}
	}
	return out
}

func (s *Server) startSourceScheduler() {
	sched := s.sourceSched
	if sched == nil {
		return
	}
	sched.mu.Lock()
	if sched.cancel != nil {
		// 换端口会 Stop → Start，Stop 已 cancel 并置 nil；这里是双保险
		sched.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	sched.cancel = cancel
	sched.mu.Unlock()

	go func() {
		// 启动延迟：刚开机就拉一堆外部源没有意义，也让首次渲染先完成
		select {
		case <-ctx.Done():
			return
		case <-time.After(sourceSchedStartDelay):
		}
		s.runDueSources(ctx)
		ticker := time.NewTicker(sourceSchedTick)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.runDueSources(ctx)
			}
		}
	}()
	log.Printf("[cfpilot] 外部数据源定时同步已启动（每 %s 检查到期源）", sourceSchedTick)
}

func (s *Server) runDueSources(ctx context.Context) {
	ids := dueSourceIDs(time.Now().UnixMilli())
	if len(ids) == 0 {
		return
	}
	if _, err := s.runSourceSync(ctx, ids); err != nil {
		// 「正在跑」不算错误：说明上一轮还没结束，跳过这次即可
		log.Printf("[cfpilot] 跳过本轮数据源同步：%v", err)
	}
}

func (s *Server) stopSourceScheduler() {
	if s.sourceSched == nil {
		return
	}
	s.sourceSched.mu.Lock()
	cancel := s.sourceSched.cancel
	s.sourceSched.cancel = nil
	s.sourceSched.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}
