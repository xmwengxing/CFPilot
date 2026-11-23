//go:build !windows

package autostart

import (
	"fmt"
	"os"
	"path/filepath"
)

const desktopEntryName = "cfpilot.desktop"

func desktopEntryPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "autostart", desktopEntryName), nil
}

// Enabled 返回当前用户是否已配置 CFPilot 登录自启。
func Enabled() bool {
	path, err := desktopEntryPath()
	if err != nil {
		return false
	}
	_, err = os.Stat(path)
	return err == nil
}

// Set 开启或关闭当前用户的 CFPilot 登录自启。
func Set(enabled bool) error {
	path, err := desktopEntryPath()
	if err != nil {
		return fmt.Errorf("定位启动项目录失败: %w", err)
	}
	if !enabled {
		err := os.Remove(path)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("删除启动项失败: %w", err)
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("定位 CFPilot 程序失败: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("创建启动项目录失败: %w", err)
	}
	content := fmt.Sprintf("[Desktop Entry]\nType=Application\nName=CFPilot\nExec=%q --no-browser\nTerminal=false\n", exe)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return fmt.Errorf("写入启动项失败: %w", err)
	}
	return nil
}
