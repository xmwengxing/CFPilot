// Package kernel 内嵌 Worker 内核产物（control.js / dataplane.js）。
//
// ## 为什么必须内嵌
//
// Go 版最初的设计是「exe 旁边放 worker-core/dist 目录」，
// 构建脚本也没把产物拷进去。结果：
//
//   - 用户下载的单文件 exe **完全不包含内核**
//   - 点「开始部署」直接报
//     「找不到内核产物（control.js / dataplane.js）」
//   - 部署功能 100% 不可用 —— 而这是本项目最核心的功能
//
// 这属于「产物是空壳」的严重问题：界面看着完整，核心功能一按就废。
//
// ## 现在的做法
//
// 用 `go:embed` 把内核产物直接打进二进制：
//   - 真正的单文件分发（下载一个 exe 就能部署）
//   - 不依赖用户目录结构
//   - 版本天然一致（内核与外壳同版本编译）
//
// 构建脚本（scripts/build-desktop.mjs）会先把
// packages/worker-core/dist/{control,dataplane}.js 拷到
// internal/kernel/assets/ 再编译。
//
// ## 兜底顺序
//
//  1. 环境变量 CFPILOT_KERNEL_DIR（开发期直接指仓库，免去拷贝）
//  2. exe 同目录的 worker-core/dist（允许用户热替换内核）
//  3. **内嵌产物**（默认路径，永远可用）
package kernel

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

//go:embed all:assets
var embedded embed.FS

// Artifacts 是内核产物三元组。
type Artifacts struct {
	// Control 是控制面产物（control.js）
	Control []byte
	// Data 是数据面产物（dataplane.js）
	Data []byte
	// Build 是版本串（形如 a946dfa-1f2e3d4c），读不到为空串
	Build string
	// Source 说明产物来源（嵌入 / 目录），便于排查
	Source string
}

// buildVersionRe 匹配 BUILD_VERSION 常量。
//
// 产物里的形式：var BUILD_VERSION = "a946dfa-1f2e3d4c"
// 也可能是纯数字（旧格式 202610251200）。
var (
	reBuildHash    = regexp.MustCompile(`["']([0-9a-f]{7,10}-(?:[0-9a-f]{4,16}|[0-9]{12}))["']`)
	reBuildNumeric = regexp.MustCompile(`["'](\d{10,14})["']`)
)

// Load 加载内核产物。
//
// 按「环境变量 → 同目录 → 内嵌」顺序查找，找到即返回。
func Load() (*Artifacts, error) {
	// 1. 环境变量指定的目录（开发期用）
	if dir := strings.TrimSpace(os.Getenv("CFPILOT_KERNEL_DIR")); dir != "" {
		if a, err := loadFromDir(dir, "环境变量 CFPILOT_KERNEL_DIR"); err == nil {
			return a, nil
		}
	}

	// 2. exe 同目录（允许用户热替换内核）
	if exe, err := os.Executable(); err == nil {
		base := filepath.Dir(exe)
		for _, rel := range []string{
			filepath.Join(base, "worker-core", "dist"),
			filepath.Join(base, "dist"),
		} {
			if a, err := loadFromDir(rel, "exe 同目录"); err == nil {
				return a, nil
			}
		}
	}

	// 3. 内嵌产物（默认路径）
	return loadEmbedded()
}

// loadFromDir 从目录读取。
func loadFromDir(dir, source string) (*Artifacts, error) {
	control, err := os.ReadFile(filepath.Join(dir, "control.js"))
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "dataplane.js"))
	if err != nil {
		return nil, err
	}
	if len(control) == 0 || len(data) == 0 {
		return nil, fmt.Errorf("%s 里的内核产物为空", dir)
	}
	return &Artifacts{
		Control: control,
		Data:    data,
		Build:   extractBuild(string(control)),
		Source:  fmt.Sprintf("%s：%s", source, dir),
	}, nil
}

// loadEmbedded 从嵌入文件系统读取。
func loadEmbedded() (*Artifacts, error) {
	control, err := embedded.ReadFile("assets/control.js")
	if err != nil {
		return nil, fmt.Errorf("内嵌产物缺失（control.js）：%w", err)
	}
	data, err := embedded.ReadFile("assets/dataplane.js")
	if err != nil {
		return nil, fmt.Errorf("内嵌产物缺失（dataplane.js）：%w", err)
	}
	if len(control) == 0 || len(data) == 0 {
		return nil, fmt.Errorf("内嵌产物为空（构建脚本没拷贝内核产物？）")
	}
	return &Artifacts{
		Control: control,
		Data:    data,
		Build:   extractBuild(string(control)),
		Source:  "内嵌（exe 自带）",
	}, nil
}

// extractBuild 从产物源码里提取版本串。
//
// ⚠️ 读不到就返回空串，**绝不返回 "unknown"** —— 假值会让
// 「检查状态」显示「线上内核 unknown ≠ 本地 xxx」，用户看不懂。
func extractBuild(source string) string {
	if m := reBuildHash.FindStringSubmatch(source); len(m) > 1 {
		return m[1]
	}
	if m := reBuildNumeric.FindStringSubmatch(source); len(m) > 1 {
		return m[1]
	}
	return ""
}

// Available 报告内嵌产物是否真的存在（供诊断用）。
func Available() bool {
	_, err := loadEmbedded()
	return err == nil
}

// EmbeddedSizes 返回内嵌产物的字节数（供诊断显示）。
func EmbeddedSizes() (control, data int, err error) {
	c, err := embedded.ReadFile("assets/control.js")
	if err != nil {
		return 0, 0, err
	}
	d, err := embedded.ReadFile("assets/dataplane.js")
	if err != nil {
		return len(c), 0, err
	}
	return len(c), len(d), nil
}
