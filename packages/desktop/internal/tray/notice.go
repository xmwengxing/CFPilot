package tray

// 启动提示。

import (
	"fmt"
	"log"
	"time"
)

// showStartupNotice 在服务启动成功时弹一条提示。
//
// ## 为什么需要
//
// 用户双击 exe 后如果浏览器没立刻打开（或者启动慢），
// 屏幕上什么都不会发生 —— 用户不知道程序到底是起来了、
// 崩了、还是根本没运行。
//
// 这条提示的作用是**确认「程序活着」**：
//   - Windows：托盘气泡（右下角，几秒后自动消失）
//   - Linux / macOS：系统桌面通知
//
// 内容包含界面地址，用户即使没等到浏览器打开也能手动访问。
func (a *App) showStartupNotice() {
	st := a.srv.Settings()
	url := a.srv.WelcomeURL()

	title := "CFPilot 部署与维护服务"
	body := fmt.Sprintf("已启动，界面地址：\n%s", displayURL(url))
	if st.AllowLAN {
		body += "\n\n已开启局域网访问"
	}

	if err := a.ShowBalloon(title, body, 5*time.Second); err != nil {
		// 气泡失败不是错误（可能被系统通知策略禁用），
		// 记日志即可 —— 托盘菜单里也能看到地址。
		log.Printf("[cfpilot] 启动提示未能显示：%v", err)
		log.Printf("[cfpilot] %s：%s", title, url)
		return
	}
	log.Printf("[cfpilot] %s（已显示启动提示）", title)
}

// displayURL 去掉 URL 里的启动令牌，避免通知里出现一长串乱码。
//
// 令牌仍可点击托盘「打开业务界面」时自动带上，不需要用户看。
func displayURL(url string) string {
	if idx := indexOfByte(url, '?'); idx >= 0 {
		return url[:idx]
	}
	return url
}

func indexOfByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}
