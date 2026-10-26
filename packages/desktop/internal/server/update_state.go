package server

// 更新下载任务状态。

import "sync"

// updateState 记录当前更新下载状态（同一时刻只允许一个下载）。
type updateState struct {
	mu      sync.Mutex
	running bool
}
