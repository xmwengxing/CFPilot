// Package logfile 提供带滚动上限的日志文件写入器。
//
// # 为什么不用 logrotate
//
// 桌面版是单文件分发，用户不会装 logrotate；
// 而且滚动必须**在写入时**做（判断当前大小 + 改名），
// 定时任务做不到「写爆了立刻换」。
//
// # 滚动策略
//
// 超过上限时：
//  1. 现有 .1 改名为 .2，.2 改名为 .3 …（最多保留 MaxBackups 个）
//  2. 超出备份上限的更老文件删除
//  3. 主文件改名为 .1，新建主文件
//
// 这样任何时刻总占用 ≈ 上限 × (1 + MaxBackups)。
//
// # 线程安全
//
// 写入可能被多个 goroutine 调用（HTTP handler / 托盘 / 后台检查），
// 所以写入与滚动都在同一把锁里。
package logfile

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	// DefaultMaxBytes 是单文件上限（2 MB）。
	//
	// 日志写得最凶的是扫描进度（每秒几十行）；
	// 2 MB 大约够存几千行，足够排查问题，又不至于占满磁盘。
	DefaultMaxBytes int64 = 2 << 20

	// DefaultMaxBackups 是保留的历史文件个数。
	DefaultMaxBackups = 2
)

// Writer 是一个带滚动上限的日志写入器。
//
// 用法：
//
//	w, err := logfile.New(path, logfile.DefaultMaxBytes, logfile.DefaultMaxBackups)
//	if err == nil {
//	    log.SetOutput(w)
//	}
type Writer struct {
	mu         sync.Mutex
	path       string
	maxBytes   int64
	maxBackups int
	file       *os.File
	size       int64
}

// New 创建写入器（会立即打开/创建文件）。
func New(path string, maxBytes int64, maxBackups int) (*Writer, error) {
	if path == "" {
		return nil, fmt.Errorf("日志路径为空")
	}
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	if maxBackups < 0 {
		maxBackups = 0
	}
	w := &Writer{path: path, maxBytes: maxBytes, maxBackups: maxBackups}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}

// open 打开文件并记录当前大小（调用方需持锁）。
func (w *Writer) open() error {
	if err := os.MkdirAll(filepath.Dir(w.path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return err
	}
	w.file = f
	w.size = st.Size()
	return nil
}

// Write 实现 io.Writer。
func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.file == nil {
		// 文件被外部删了 → 重新打开
		if err := w.open(); err != nil {
			return 0, err
		}
	}
	n, err := w.file.Write(p)
	w.size += int64(n)

	// 写完再判断滚动：避免每写一行都 stat 一次
	if w.size >= w.maxBytes {
		w.rotateLocked()
	}
	return n, err
}

// rotateLocked 轮转（调用方需持锁）。
func (w *Writer) rotateLocked() {
	if w.file != nil {
		_ = w.file.Close()
		w.file = nil
	}

	// 1) 老的 .N 依次后移
	for i := w.maxBackups; i >= 1; i-- {
		from := w.backupPath(i)
		to := w.backupPath(i + 1)
		if _, err := os.Stat(from); err != nil {
			continue
		}
		_ = os.Remove(to)
		_ = os.Rename(from, to)
	}

	// 2) 超出备份上限的更老文件删掉
	if w.maxBackups >= 0 {
		_ = os.Remove(w.backupPath(w.maxBackups + 1))
	}

	// 3) 主文件改名 + 新建
	_ = os.Rename(w.path, w.backupPath(1))
	_ = w.open()
}

// backupPath 返回第 i 个备份文件的路径。
func (w *Writer) backupPath(i int) string {
	return fmt.Sprintf("%s.%d", w.path, i)
}

// Path 返回日志文件路径。
func (w *Writer) Path() string { return w.path }

// Size 返回当前日志文件大小（字节）。
func (w *Writer) Size() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.size
}

// Close 关闭文件。
func (w *Writer) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

// RotatedFiles 返回现存的备份文件名（不含路径）。
func RotatedFiles(path string, maxBackups int) []string {
	out := []string{}
	for i := 1; i <= maxBackups+1; i++ {
		p := fmt.Sprintf("%s.%d", path, i)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			out = append(out, filepath.Base(p))
		}
	}
	return out
}

// Tail 读取日志的最后 n 行。
//
// n ≤ 0 时返回空。文件不存在时返回空切片与 nil 错误（还没写过日志是正常情况）。
func Tail(path string, n int) (lines []string, total int, err error) {
	if n <= 0 {
		return []string{}, 0, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, 0, nil
		}
		return nil, 0, err
	}
	text := string(data)
	if text == "" {
		return []string{}, 0, nil
	}
	all := splitLines(text)
	total = len(all)
	if total > n {
		lines = all[total-n:]
	} else {
		lines = all
	}
	return lines, total, nil
}

// splitLines 按行切分（保留末尾空行会被去掉）。
func splitLines(text string) []string {
	text = strings.TrimRight(text, "\n")
	if text == "" {
		return []string{}
	}
	return strings.Split(text, "\n")
}

// HumanSize 把字节数转成人类可读的大小。
func HumanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGT"[exp])
}
