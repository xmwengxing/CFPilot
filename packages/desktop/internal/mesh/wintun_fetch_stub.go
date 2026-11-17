//go:build !windows || !mesh

package mesh

import "fmt"

// FetchWintun 仅 +mesh 的 Windows 变体可用。
func FetchWintun(dir string) (string, error) {
	return "", fmt.Errorf("wintun: 当前构建不支持自动下载（仅 +mesh Windows 版）")
}
