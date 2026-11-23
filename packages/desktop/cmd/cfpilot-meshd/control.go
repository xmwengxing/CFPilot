//go:build mesh

package main

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/mesh"
)

const (
	transitionStarting = "starting"
	transitionStopping = "stopping"
)

type meshRun struct {
	lifecycle mesh.Lifecycle
	last      mesh.Status
}

// meshControl 只在读写状态时持锁。启停中的查询使用最近一次快照，避免等待设备和网络操作。
type meshControl struct {
	mu           sync.Mutex
	current      *meshRun
	transition   string
	failure      string
	newLifecycle func(mesh.Config) mesh.Lifecycle
}

func (control *meshControl) begin(transition string) (*meshRun, bool) {
	control.mu.Lock()
	defer control.mu.Unlock()
	if control.transition != "" {
		return nil, false
	}
	control.transition = transition
	return control.current, true
}

func (control *meshControl) complete(run *meshRun, failure string) {
	control.mu.Lock()
	defer control.mu.Unlock()
	control.current = run
	control.failure = failure
	control.transition = ""
}

func (control *meshControl) status() mesh.Status {
	control.mu.Lock()
	current := control.current
	if current == nil || control.transition != "" {
		defer control.mu.Unlock()
		return control.snapshotLocked()
	}
	control.mu.Unlock()

	status := current.lifecycle.Status()
	control.mu.Lock()
	defer control.mu.Unlock()
	if control.current == current && control.transition == "" {
		current.last = status
	}
	return control.snapshotLocked()
}

func (control *meshControl) snapshotLocked() mesh.Status {
	status := mesh.Status{Note: "未启动"}
	if control.current != nil {
		status = control.current.last
	}
	status.Transition = control.transition
	switch control.transition {
	case transitionStarting:
		status.Note = "正在启动组网"
	case transitionStopping:
		status.Note = "正在停止组网"
	default:
		if control.failure != "" {
			status.Note = control.failure
		}
	}
	return status
}

// start 由已取得启停状态的调用者执行。组网在请求结束后继续运行。
func (control *meshControl) start(cfg mesh.Config, previous *meshRun) (mesh.Status, error) {
	if err := cfg.Validate(); err != nil {
		control.complete(previous, "组网配置无效")
		return mesh.Status{}, err
	}
	if cfg.ClientVersion == "" {
		cfg.ClientVersion = version
	}
	if previous != nil {
		if err := previous.lifecycle.Stop(); err != nil {
			control.complete(&meshRun{lifecycle: previous.lifecycle, last: previous.lifecycle.Status()}, "停止当前网络失败")
			return mesh.Status{}, fmt.Errorf("停止当前网络失败: %w", err)
		}
		control.mu.Lock()
		control.current = nil
		control.mu.Unlock()
	}
	started := control.newLifecycle(cfg)
	if err := started.Start(context.Background()); err != nil {
		control.complete(nil, "组网启动失败")
		return mesh.Status{}, err
	}
	status := started.Status()
	control.complete(&meshRun{lifecycle: started, last: status}, "")
	return status, nil
}

func (control *meshControl) stop(previous *meshRun) error {
	if previous != nil {
		if err := previous.lifecycle.Stop(); err != nil {
			control.complete(&meshRun{lifecycle: previous.lifecycle, last: previous.lifecycle.Status()}, "组网停止失败")
			return err
		}
	}
	control.complete(nil, "")
	return nil
}

// restore 在接收请求前登记自动恢复，设备初始化与本地 API 并行。
func (control *meshControl) restore(profiles *mesh.ProfileStore) {
	if profiles == nil || !profiles.AutoStartEnabled() {
		return
	}
	cfg := profiles.SelectedConfig()
	if cfg == nil {
		return
	}
	previous, ok := control.begin(transitionStarting)
	if !ok {
		return
	}
	go func() {
		if started, err := control.start(*cfg, previous); err != nil {
			log.Printf("[meshd] 自动恢复网络失败: %v", err)
		} else {
			log.Printf("[meshd] 已自动恢复上次选择的网络: vip=%s", started.VirtualIP)
		}
	}()
}
