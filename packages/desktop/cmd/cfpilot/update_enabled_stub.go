//go:build !mesh

package main

// +mesh 之外（普通版）启用内置应用更新。
func appUpdateEnabled() bool { return true }
