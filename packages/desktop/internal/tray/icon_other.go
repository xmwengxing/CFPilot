//go:build !windows

package tray

// useICOIcon 在非 Windows 平台为 false —— Linux / macOS 用 PNG。
const useICOIcon = false
