//go:build windows

package shell

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"unsafe"

	"github.com/jchv/go-webview2/webviewloader"
)

// WebView2Loader.dll 的加载方式，是「被安全软件当成木马」的唯一原因。
//
// ## 问题
//
// 依赖库把 WebView2Loader.dll 内嵌进 exe，运行时优先 LoadLibrary 磁盘版本，
// 找不到就退回 go-winloader 的**反射加载**：把 PE 映像映射到进程私有内存，
// 再手工修重定位、改节属性为可执行。这是注入器/木马的经典特征 ——
// 实测被云启发判成 `Trojan:Win32/Sonbokli.A!cl` 并直接隔离。
//
// ## 做法
//
// 内嵌的那份是**微软签名的官方 DLL**，本身完全正当。所以只要让它「从磁盘加载」
// 就不会走到反射加载那条路：把内嵌字节落到本机数据目录（用户可写），
// 再把它加入 DLL 搜索目录。依赖库随后 LoadLibrary 成功，内存里就没有可执行私有页。
//
// 为什么不写到 exe 同目录：装到 Program Files 时该目录只读，
// 而「有的能写有的不能写」会变成按安装方式分叉的两套行为。

const loaderDLLName = "WebView2Loader.dll"

var (
	loaderOnce   sync.Once
	loaderDir    string
	loaderPath   string
	loaderFailed error
)

// PrepareWebView2Loader 把内嵌的官方 WebView2Loader.dll 落到 dir 并加入 DLL 搜索路径。
//
// 返回落盘路径（失败时为空）。调用方不需要处理错误：失败时依赖库会退回
// 反射加载，功能不受影响，只是仍然可能触发安全软件告警。
func PrepareWebView2Loader(dir string) (string, error) {
	loaderOnce.Do(func() {
		if dir == "" {
			loaderFailed = os.ErrInvalid
			return
		}
		loaderDir = dir
		if err := os.MkdirAll(dir, 0o700); err != nil {
			loaderFailed = err
			return
		}
		path := filepath.Join(dir, loaderDLLName)
		if err := writeIfChanged(path, webviewloader.WebView2Loader); err != nil {
			loaderFailed = err
			return
		}
		if !addDllDirectory(dir) {
			loaderFailed = os.ErrPermission
			return
		}
		loaderPath = path
	})
	return loaderPath, loaderFailed
}

// writeIfChanged 只在内容不同时写文件。
//
// 每次启动都重写会让安全软件看到「频繁落盘 PE」，反而更可疑；
// 内嵌副本与已落盘副本一致时直接复用。
func writeIfChanged(path string, data []byte) error {
	if len(data) == 0 {
		return os.ErrInvalid
	}
	if old, err := os.ReadFile(path); err == nil && len(old) == len(data) {
		want := sha256.Sum256(data)
		got := sha256.Sum256(old)
		if hex.EncodeToString(want[:]) == hex.EncodeToString(got[:]) {
			return nil
		}
	}
	// 先写临时文件再改名：中途失败不会留下半截 DLL。
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// addDllDirectory 把目录插入 LoadLibrary 的搜索顺序。
//
// 用 AddDllDirectory 而不是 SetDllDirectory：后者会**替换**默认搜索路径，
// 让 exe 同目录之外的一些系统组件解析失败；前者只追加。
// 需要先 SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)，
// 否则 AddDllDirectory 加入的目录不生效。
func addDllDirectory(dir string) bool {
	const loadLibrarySearchDefaultDirs = 0x00001000
	k32 := syscall.NewLazyDLL("kernel32.dll")
	setDefault := k32.NewProc("SetDefaultDllDirectories")
	if err := setDefault.Find(); err != nil {
		return false
	}
	if r, _, _ := setDefault.Call(loadLibrarySearchDefaultDirs); r == 0 {
		return false
	}
	add := k32.NewProc("AddDllDirectory")
	if err := add.Find(); err != nil {
		return false
	}
	p, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return false
	}
	cookie, _, _ := add.Call(uintptr(unsafe.Pointer(p)))
	return cookie != 0
}
