package tray

import (
	"fmt"
	"os/exec"
	"runtime"
)

// copyToClipboard 按平台调用系统剪贴板命令。
func copyToClipboard(text string) error {
	switch runtime.GOOS {
	case "windows":
		return pipeToCmd([]string{"cmd", "/c", "clip"}, text)
	case "darwin":
		return pipeToCmd([]string{"pbcopy"}, text)
	default:
		// Linux：依次尝试 Wayland / X11 工具
		var lastErr error
		for _, tool := range [][]string{
			{"wl-copy"},
			{"xclip", "-selection", "clipboard"},
			{"xsel", "--clipboard", "--input"},
		} {
			if _, err := exec.LookPath(tool[0]); err != nil {
				continue
			}
			if err := pipeToCmd(tool, text); err == nil {
				return nil
			} else {
				lastErr = err
			}
		}
		if lastErr != nil {
			return lastErr
		}
		return fmt.Errorf("未找到可用的剪贴板工具（wl-copy / xclip / xsel）")
	}
}

// pipeToCmd 把文本写入命令的标准输入。
func pipeToCmd(argv []string, text string) error {
	cmd := exec.Command(argv[0], argv[1:]...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	if _, err := stdin.Write([]byte(text)); err != nil {
		_ = stdin.Close()
		return err
	}
	if err := stdin.Close(); err != nil {
		return err
	}
	return cmd.Wait()
}
