// mesh 插件边界（Phase 3a 预研，与协议无关）。
//
// 定义 mesh 模块与 CFPilot 主程序（桌面版 UI / CLI）之间的**通信契约常量**。
// 这些常量刻意不含任何协议字节级细节，Phase 3b 实现协议时不会改动它们。
//
// 设计取舍（预研结论）：
//   - 桌面版：mesh 作为内嵌 Go 包（build tag mesh），通过本地控制 API 暴露状态，
//     复用现有 SSE 事件总线（与 edge-result 同机制），UI 加「组网」页签消费。
//   - CLI：`cfpilot mesh` 子命令直接调用 Lifecycle，不经过 HTTP。
//   - 两者共享 Status/Peer 快照结构（见 tun.go），保证语义一致。
package mesh

// 事件名（SSE，桌面版 UI 订阅）。
// 与 server 的 eventBus publish 名一致；Phase 3b 在 server 层注册。
const (
	EventMeshStatus = "mesh-status" // 状态变化（上线/下线/选路切换）
	EventMeshResult = "mesh-result" // Start/Stop 动作结果
)

// 本地控制 API 路径（桌面版 server 注册；Phase 3b 实现 handler）。
const (
	APIMeshStatus = "/api/mesh/status"
	APIMeshStart  = "/api/mesh/start"
	APIMeshStop   = "/api/mesh/stop"
	APIMeshPeers  = "/api/mesh/peers"
)

// ActionResult 是 Start/Stop 动作的返回契约（与协议无关，Phase 3b 复用）。
type ActionResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
}
