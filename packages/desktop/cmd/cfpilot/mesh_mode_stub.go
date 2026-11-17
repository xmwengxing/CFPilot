//go:build !mesh

package main

// runMeshMode 在普通版（无 mesh tag）下返回 false，零影响——
// 主程序会继续走正常的托盘/HTTP 服务启动流程。
func runMeshMode(path string) bool { return false }
