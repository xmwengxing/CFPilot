//go:build windows

package tray

// useICOIcon 在 Windows 上必须为 true —— LoadImage 只认 ICO。
//
// 用构建约束而不是 `runtime.GOOS == "windows"` 判断，是为了在编译期就固定：
// 交叉编译 Linux 产物时 `iconICO` 完全不会进二进制（体积更小），
// 也杜绝了「运行时判断写错」的可能。
const useICOIcon = true
