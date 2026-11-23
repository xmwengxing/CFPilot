package autostart

import (
	"fmt"
	"os"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const (
	runKeyPath = `Software\Microsoft\Windows\CurrentVersion\Run`
	runKeyName = "CFPilot"
)

// Enabled 返回当前用户是否已配置 CFPilot 登录自启。
func Enabled() bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	_, _, err = key.GetStringValue(runKeyName)
	return err == nil
}

// Set 开启或关闭当前用户的 CFPilot 登录自启。
func Set(enabled bool) error {
	if !enabled {
		key, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE)
		if err != nil {
			return fmt.Errorf("打开启动项失败: %w", err)
		}
		defer key.Close()
		if err := key.DeleteValue(runKeyName); err != nil && err != registry.ErrNotExist {
			return fmt.Errorf("删除启动项失败: %w", err)
		}
		return nil
	}

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("定位 CFPilot 程序失败: %w", err)
	}
	value := fmt.Sprintf(`"%s" --no-browser`, strings.ReplaceAll(exe, `"`, `""`))
	key, _, err := registry.CreateKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("创建启动项失败: %w", err)
	}
	defer key.Close()
	if err := key.SetStringValue(runKeyName, value); err != nil {
		return fmt.Errorf("写入启动项失败: %w", err)
	}
	return nil
}
