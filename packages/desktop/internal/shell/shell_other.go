//go:build !windows && !linux && !darwin

package shell

// New 在尚未支持的平台上明确返回 ErrUnsupported。
//
// 不返回 panic、也不假装成功：调用方据此回退到系统浏览器，
// 用户至少还能用面板（FreeBSD 等暂未适配的平台走的就是这条路径）。
func New(opts Options) (Panel, error) {
	opts.logf("[shell] 当前平台没有内嵌窗口实现，回退系统浏览器")
	return nil, ErrUnsupported
}

// ActivateExisting 在没有窗口实现的平台上恒为 false。
func ActivateExisting(string) bool { return false }
