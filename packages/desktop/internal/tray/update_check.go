// Package tray —— 托盘菜单与后台更新检查。
//
// # 为什么托盘要自己检查更新
//
// 界面里的「检查更新」按钮只能��用户在**主动打开界面并点到那个页签**时才生效。
// 而真实场景是：用户三天没开应用，界面上什么提示都没有 ——
// 「有新版」这件事只有用户点进去才看得见，等于没有。
//
// 所以托盘做两件事：
//  1. 启动后延迟一小段时间自动检查一次，之后每小时检查一次；
//  2. 检查到新版本时，把菜单项的标题改成「检查应用更新（有新版 0.7.6）」，
//     并弹一条气泡通知。
//
// # 「检查部署更新」是另一回事
//
// 应用更新 = 换 exe（外壳、界面、优选器都变）。
// 部署更新 = 线上跑的内核代码变（数据面 / 控制面）。
//
// 两者版本是独立的：用户可以「外壳是 0.7.5、线上内核是 0.7.3」，
// 也可以反过来。内核的版本比对走 kernel 包（见 internal/kernel/remote.go）。
package tray

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/update"
)

// UpdateState 是最近一次检查的结果。
type UpdateState struct {
	// AppHasUpdate 表示应用（exe）有新版
	AppHasUpdate bool
	// AppLatest 是可升级到的应用版本
	AppLatest string
	// DeployHasUpdate 表示线上内核有新版（远程内核比线上新）
	DeployHasUpdate bool
	// DeployLatest 是可升级到的内核版本
	DeployLatest string
	// CheckedAt 是检查时间
	CheckedAt time.Time
	// Err 是检查错误（网络问题等）；不阻断其它结果
	Err string
}

// Checker 是更新检查器（由 main 注入，便于测试替换）。
type Checker interface {
	// CheckApp 检查应用（exe）更新。
	CheckApp(ctx context.Context) (*update.CheckResult, error)
	// CheckDeploy 检查线上内核是否有更新。
	CheckDeploy(ctx context.Context) (*DeployCheckResult, error)
}

// DeployCheckResult 是部署（内核）更新检查结果。
type DeployCheckResult struct {
	// RemoteVersion 是远程最新内核版本（空 = 查不到）
	RemoteVersion string
	// RemoteNewer 表示远程比线上新
	RemoteNewer bool
}

// UpdateChecker 后台检查器。
type UpdateChecker struct {
	mu    sync.Mutex
	state *UpdateState
	// appCheck 检查应用更新
	appCheck func(ctx context.Context) (*update.CheckResult, error)
	// deployCheck 检查部署更新
	deployCheck func(ctx context.Context) (*DeployCheckResult, error)
	// onChange 状态变化时的回调（用于刷新菜单文字）
	onChange func(*UpdateState)
}

// NewUpdateChecker 创建检查器。
func NewUpdateChecker(
	appCheck func(ctx context.Context) (*update.CheckResult, error),
	deployCheck func(ctx context.Context) (*DeployCheckResult, error),
) *UpdateChecker {
	return &UpdateChecker{appCheck: appCheck, deployCheck: deployCheck}
}

// SetOnChange 设置状态变化回调。
func (c *UpdateChecker) SetOnChange(fn func(*UpdateState)) { c.onChange = fn }

// State 返回最近一次检查结果（可能为 nil）。
func (c *UpdateChecker) State() *UpdateState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state
}

// Check 执行一次检查（应用 + 部署），更新状态并触发回调。
//
// 单项失败不影响另一项 —— 应用检查失败时部署结果照样更新。
func (c *UpdateChecker) Check(ctx context.Context) *UpdateState {
	st := &UpdateState{CheckedAt: time.Now()}
	var errs []string

	if c.appCheck != nil {
		if res, err := c.appCheck(ctx); err != nil {
			errs = append(errs, "应用："+err.Error())
		} else if res != nil {
			st.AppHasUpdate = res.HasUpdate
			st.AppLatest = res.Latest
			if res.Error != "" {
				errs = append(errs, "应用："+res.Error)
			}
		}
	}

	if c.deployCheck != nil {
		if res, err := c.deployCheck(ctx); err != nil {
			errs = append(errs, "部署："+err.Error())
		} else if res != nil {
			st.DeployHasUpdate = res.RemoteNewer
			st.DeployLatest = res.RemoteVersion
		}
	}

	if len(errs) > 0 {
		st.Err = joinErrs(errs)
	}

	c.mu.Lock()
	c.state = st
	c.mu.Unlock()

	if c.onChange != nil {
		c.onChange(st)
	}
	return st
}

func joinErrs(errs []string) string {
	out := ""
	for i, e := range errs {
		if i > 0 {
			out += "；"
		}
		out += e
	}
	return out
}

// StartAutoCheck 启动后台自动检查。
//
// 节奏：启动后 delay 一次，之后每 interval 一次。
// 应用退出（ctx 取消）时停止。
//
// 为什么启动后要延迟：刚启动就去打 GitHub，会和用户第一次打开界面抢网络，
// 而且用户可能正在做部署（网络忙）。延迟 20 秒比较合适。
func (c *UpdateChecker) StartAutoCheck(ctx context.Context, delay, interval time.Duration, onFirst func(*UpdateState)) {
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}

		st := c.Check(ctx)
		if onFirst != nil {
			onFirst(st)
		}

		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				c.Check(ctx)
			}
		}
	}()
}

// menuLabel 根据状态生成菜单项标题。
//
// 有新版时把版本号写进标题 —— 用户不用点开就知道有新版。
func menuLabel(base string, hasUpdate bool, latest string) string {
	if !hasUpdate || latest == "" {
		return base
	}
	return fmt.Sprintf("%s（有新版 %s）", base, latest)
}
