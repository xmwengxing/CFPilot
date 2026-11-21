//go:build linux && !cfp_gui

package shell

// New 在「未启用图形壳」的 Linux 构建里明确返回 ErrUnsupported。
//
// ## 为什么要分两种 Linux 构建
//
// 图形壳依赖 purego 在运行时 dlopen WebKitGTK。purego 通过
// //go:cgo_import_dynamic 实现 dlopen，链接结果会带上 glibc 的
// DT_NEEDED（libc.so.6 / libdl.so.2 / libpthread.so.0）。
//
// 容器镜像是 Alpine（musl），这种产物**在容器里直接 exec 失败**。
// 所以：
//
//   - 面向用户的 Linux 产物：`-tags cfp_gui`，有窗口能力（glibc）；
//   - 容器 / 无桌面环境用的产物：不带标签，保持静态单文件，
//     行为与早前版本一致 —— 打开系统浏览器。
//
// 两条构建都通过 scripts/build-desktop.mjs 产出并各自校验。
func New(opts Options) (Panel, error) {
	opts.logf("[shell] 本构建未启用图形壳（容器 / 静态构建），使用系统浏览器")
	return nil, ErrUnsupported
}

// ActivateExisting 在无图形壳的构建里恒为 false。
func ActivateExisting(string) bool { return false }
