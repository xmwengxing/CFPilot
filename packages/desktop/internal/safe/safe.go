// Package safe 提供 goroutine 级别的 panic 保护。
//
// # 为什么需要
//
// Go 里**任何一个 goroutine 发生未捕获的 panic，整个进程就会立刻退出** ——
// 没有「某个请求失败但服务还活着」这回事。
//
// 真机踩过：桌面版跑到扫描的「阶段三：真实下行测速」时进程直接没了，
// 界面上只表现为「服务被强制退出」，而：
//
//   - panic 信息写到 **stderr**（托盘模式下 stderr 不可见 → 什么都看不到）
//   - 正在进行的扫描、日志、托盘全部一起消失
//   - 用户完全不知道发生了什么
//
// # 做法
//
//  1. 长期运行的后台 goroutine 入口用 `safe.Go` 包一层
//     （panic → 记日志 → 该 goroutine 退出，进程继续跑）
//  2. HTTP handler 由 `server` 的中间件兜底
//     （panic → 记日志 → 返回 500，连接不断）
//
// 配合 `cmd/cfpilot` 把 stderr 也转进日志文件，
// 就算有 panic 逃过了这两层兜底，也能在日志里看到。
package safe

import (
	"log"
	"runtime/debug"
)

// Go 在后台跑一个函数，panic 不会带走整个进程。
//
// 适合放在 goroutine 入口：
//
//	safe.Go("扫描", func() { ... })
//
// panic 会被记进日志（含堆栈），然后该 goroutine 正常结束。
func Go(what string, fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[cfpilot] 后台任务「%s」发生 panic（已恢复，进程继续运行）：%v\n%s",
					what, r, debug.Stack())
			}
		}()
		fn()
	}()
}

// Recover 在当前 goroutine 里兜住 panic，返回是否发生过 panic。
//
// 适合放在 HTTP handler 里：
//
//	defer func() {
//	    if r := safe.Recover("处理部署请求"); r != nil {
//	        writeJSON(w, 500, map[string]any{"error": "内部错误"})
//	    }
//	}()
//
// 返回 recover 到的值（没 panic 时为 nil）。
func Recover(what string) (recovered any) {
	recovered = recover()
	if recovered != nil {
		log.Printf("[cfpilot] %s 发生 panic（已恢复）：%v\n%s", what, recovered, debug.Stack())
	}
	return
}
