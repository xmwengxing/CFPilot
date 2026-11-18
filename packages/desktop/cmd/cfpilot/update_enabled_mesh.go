//go:build mesh

package main

// +mesh 版禁用内置应用更新：
//   - 产物是 NSIS 安装包（setup.exe），不能像单文件 exe 那样 rename-swap 替换自身；
//   - 普通版与 +mesh 版共用同一 tag/版本号与 SHA256SUMS，pickAsset 只按 OS/arch 选资产，
//     会把普通单文件 exe 或对方的安装包错投给另一变体（串变体风险）。
//
// 所以 +mesh 版不提供「检查应用更新」，升级请重新下载 +mesh 安装包。
func appUpdateEnabled() bool { return false }
