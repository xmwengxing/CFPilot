package server

import "time"

// Uptime 返回服务已运行时长。
func (s *Server) Uptime() time.Duration {
	return time.Since(s.startedAt)
}

// Running 报告服务当前是否在监听。
func (s *Server) Running() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.listener != nil
}
