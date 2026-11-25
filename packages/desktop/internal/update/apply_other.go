//go:build !darwin

package update

import "errors"

// macOS 才有 .app 整包替换；其它平台的更新是单文件 rename-swap（见 apply.go）。
//
// 这里保留同名桩函数是为了让 apply.go 的平台分支只写一处判断，
// 而不是在每个调用点都散落 GOOS 判断。

func applyAppBundle(string) (string, error) {
	return "", errors.New("整包替换仅在 macOS 上可用")
}

func spawnAppBundleSwap([]string) error {
	return errors.New("整包替换仅在 macOS 上可用")
}
