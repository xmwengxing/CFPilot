// Package config 管理桌面版 CFPilot 的本地配置。
//
// 与 Electron 版共用同一个配置目录（~/.cfpilot-gui），
// 这样两个版本可以读到同一份凭据，用户切换版本时不用重新填 Token。
//
// 配置文件仍然沿用 Electron 版的格式，不另起一套：
//   - secrets.json  —— 多账户凭据（version:2 / activeId / profiles）
//   - desktop.json  —— 仅桌面版使用的服务设置（端口、是否自动打开浏览器等）
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// DefaultPort 是服务默认监听端口。
//
// 选 19726 的理由：
//   - 与 scanner-cli 的桥接服务端口 19527 错开，不会撞车；
//   - 落在 IANA 动态端口段（49152 以上才是临时端口，这里是注册段之外的空闲值），
//     实测不与常见开发工具冲突。
const DefaultPort = 19726

// DesktopSettings 是桌面版自己的服务设置（与凭据分开存）。
type DesktopSettings struct {
	// Port 是本地服务监听端口。
	Port int `json:"port"`
	// Host 是监听地址。
	//
	// **默认 127.0.0.1（仅本机）**，因为服务持有 Cloudflare Token 的读写能力。
	// 用户可在「服务管理」界面显式开启「允许局域网访问」，
	// 此时 Host 变为 0.0.0.0 —— 该操作需要二次确认，且必须有面板密码保护。
	Host string `json:"host"`
	// AllowLAN 是用户显式开启的「允许局域网访问」开关。
	//
	// 用独立布尔而不是直接存 Host 字符串，原因：
	//   1. 语义明确（用户勾的是「允许局域网」，不是「监听 0.0.0.0」）
	//   2. 便于界面回填与二次确认
	//   3. Host 由它推导，避免出现「Host 是 0.0.0.0 但开关是关的」这种矛盾状态
	AllowLAN bool `json:"allowLan"`
	// KeepRunningInTray 决定关掉浏览器页面后是否继续在托盘驻留。
	KeepRunningInTray bool `json:"keepRunningInTray"`
}

// LoopbackHost 是仅本机可访问的监听地址。
const LoopbackHost = "127.0.0.1"

// AnyHost 是所有网卡都可访问的监听地址（局域网模式）。
const AnyHost = "0.0.0.0"

// DefaultSettings 返回一份合理的出厂设置。
func DefaultSettings() DesktopSettings {
	return DesktopSettings{
		Port:              DefaultPort,
		Host:              LoopbackHost,
		AllowLAN:          false,
		KeepRunningInTray: true,
	}
}

// EffectiveHost 根据 AllowLAN 推导实际监听地址。
//
// 单一真相：Host 永远由 AllowLAN 决定，不单独存可写值，
// 避免出现「开关关了但还在监听 0.0.0.0」的危险状态。
func (s DesktopSettings) EffectiveHost() string {
	if s.AllowLAN {
		return AnyHost
	}
	return LoopbackHost
}

// Dir 返回配置目录（与 Electron 版一致）。
func Dir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("无法定位用户主目录：%w", err)
	}
	return filepath.Join(home, ".cfpilot-gui"), nil
}

// EnsureDir 创建配置目录（不存在时）。
func EnsureDir() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("无法创建配置目录 %s：%w", dir, err)
	}
	return dir, nil
}

func settingsPath() (string, error) {
	dir, err := EnsureDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "desktop.json"), nil
}

// LoadSettings 读取桌面版设置；文件不存在时返回默认值（不报错）。
func LoadSettings() (DesktopSettings, error) {
	def := DefaultSettings()
	path, err := settingsPath()
	if err != nil {
		return def, err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return def, nil
	}
	if err != nil {
		return def, fmt.Errorf("读取设置失败：%w", err)
	}

	var s DesktopSettings
	if err := json.Unmarshal(raw, &s); err != nil {
		// 设置文件损坏不该让程序起不来，回退出厂值
		return def, nil
	}
	// Host 由 AllowLAN 推导，不信盘上的 Host 字段
	// （旧版本可能留下 Host="0.0.0.0" 但没有 AllowLAN 的文件）
	s.Host = s.EffectiveHost()
	if s.Port < 1 || s.Port > 65535 {
		s.Port = def.Port
	}
	return s, nil
}

// SaveSettings 原子写回设置文件。
func SaveSettings(s DesktopSettings) error {
	if s.Port < 1 || s.Port > 65535 {
		return fmt.Errorf("端口 %d 不合法，应在 1-65535 之间", s.Port)
	}
	// Host 永远由 AllowLAN 推导，不接受外部直接写入
	s.Host = s.EffectiveHost()
	path, err := settingsPath()
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	// 先写临时文件再改名，避免写一半断电留下坏文件
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("写入设置失败：%w", err)
	}
	return os.Rename(tmp, path)
}

// ParsePort 解析并校验端口字符串（供命令行 / API 使用）。
func ParsePort(s string) (int, error) {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("端口必须是数字：%q", s)
	}
	if n < 1 || n > 65535 {
		return 0, fmt.Errorf("端口 %d 超出范围（1-65535）", n)
	}
	return n, nil
}

// SettingsPathForDisplay 返回设置文件路径，供界面展示。
func SettingsPathForDisplay() string {
	p, err := settingsPath()
	if err != nil {
		return ""
	}
	return p
}
