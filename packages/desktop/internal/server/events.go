package server

// 本文件实现 SSE 事件推送。
//
// ## 为什么用 SSE 而不是 WebSocket
//
// Electron 版的 `onLog` / `onScanResult` / `onUpdateProgress` 走
// `webContents.send`（主进程 → 渲染进程的单向推送）。
// Go 版是浏览器 ↔ HTTP 服务，需要同类能力，SSE（Server-Sent Events）是
// 最贴合的选择：
//
//   - **单向**：服务端 → 客户端，正好是这里的全部需求
//   - **原生**：`EventSource` 浏览器内置，前端只需十几行
//   - **自动重连**：断线后浏览器自己重试，不用自己写心跳
//   - 比 WebSocket 简单得多（无握手、无帧协议），且能走普通 HTTP 中间件
//
// ## 事件名与 Electron 版一一对应
//
//	log              { message, level, at }
//	deploy-status    DeployStatus
//	scan-result      { entries, copyable, stats }
//	update-progress  { received, total, source, attempt }
//
// 前端适配层（adapter）把 EventSource 的这四个事件转成
// `window.cfpilot.onLog(cb)` 等回调，界面代码一行不用改。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// ------------------------------------------------------------------
// 事件总线
// ------------------------------------------------------------------

// eventBus 是一对多的推送中心。
//
// 每个打开的 SSE 连接注册一个 subscriber；广播时逐个投递。
// 慢客户端不会阻塞别人：每个 subscriber 有自己的缓冲 channel，
// 满了就丢弃该条消息（日志丢一条不影响使用，卡死整个服务才是事故）。
type eventBus struct {
	mu   sync.RWMutex
	subs map[chan sseMessage]struct{}
}

type sseMessage struct {
	event string
	data  []byte
}

func newEventBus() *eventBus {
	return &eventBus{subs: make(map[chan sseMessage]struct{})}
}

// subscribe 注册一个订阅者。
func (b *eventBus) subscribe() chan sseMessage {
	// 缓冲 64 条：日志突发时不会立刻丢
	ch := make(chan sseMessage, 64)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

func (b *eventBus) unsubscribe(ch chan sseMessage) {
	b.mu.Lock()
	if _, ok := b.subs[ch]; ok {
		delete(b.subs, ch)
		close(ch)
	}
	b.mu.Unlock()
}

// publish 广播一条事件。
func (b *eventBus) publish(event string, payload any) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	msg := sseMessage{event: event, data: raw}

	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.subs {
		select {
		case ch <- msg:
		default:
			// 该订阅者积压太多，丢弃这一条。
			// 不能阻塞广播 —— 否则一个卡住的浏览器标签会拖死整个服务端。
		}
	}
}

// SubscriberCount 返回当前订阅者数量（测试用）。
func (b *eventBus) SubscriberCount() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subs)
}

// ------------------------------------------------------------------
// HTTP 端点
// ------------------------------------------------------------------

// registerEventRoutes 挂载 SSE 端点。
func (s *Server) registerEventRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/events", s.guard(s.handleEvents))
}

// handleEvents 建立 SSE 连接。
//
// 客户端用法：
//
//	const es = new EventSource('/api/events')
//	es.addEventListener('log', (e) => onLog(JSON.parse(e.data)))
//	es.addEventListener('deploy-status', (e) => onDeployStatus(JSON.parse(e.data)))
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "当前连接不支持流式响应"})
		return
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache, no-store, no-transform")
	h.Set("Connection", "keep-alive")
	// 关掉 nginx 等反代的缓冲（虽然本地直连，但保持正确语义）
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch := s.events.subscribe()
	defer s.events.unsubscribe(ch)

	// 先发一条 hello，让前端知道连接真的建立了
	fmt.Fprintf(w, "event: hello\ndata: {\"at\":%d}\n\n", time.Now().UnixMilli())
	flusher.Flush()

	// 心跳：每 25 秒一条注释行。
	// 浏览器/代理对长时间静默的连接可能主动断开；
	// SSE 注释（以 `:` 开头）不会被前端当事件，纯粹保活。
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			// 客户端断开（关闭页面 / EventSource.close()）
			return

		case msg, open := <-ch:
			if !open {
				return
			}
			// SSE 格式：event: <名>\ndata: <JSON>\n\n
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", msg.event, msg.data); err != nil {
				return
			}
			flusher.Flush()

		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// ------------------------------------------------------------------
// 事件载荷
// ------------------------------------------------------------------

// LogEntry 是日志事件（与 Electron 版的 `log` 事件同构）。
type LogEntry struct {
	Message string `json:"message"`
	Level   string `json:"level"` // info / ok / warn / err
	At      int64  `json:"at"`    // 毫秒时间戳
}

// logf 推送一条 info 日志。
func (s *Server) logf(msg string) { s.logLevel(msg, "info") }

// logLevel 推送指定级别的日志。
func (s *Server) logLevel(msg, level string) {
	s.events.publish("log", LogEntry{
		Message: msg,
		Level:   level,
		At:      time.Now().UnixMilli(),
	})
}
