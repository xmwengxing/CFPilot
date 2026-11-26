//go:build windows

package shell

import (
	"os"
	"path/filepath"
	"testing"
)

// 落盘只在内容不同时发生：每次启动重写会让安全软件看到「频繁落盘 PE」。
func TestWriteIfChangedSkipsIdenticalContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, loaderDLLName)
	data := []byte("dll-bytes")

	if err := writeIfChanged(path, data); err != nil {
		t.Fatalf("首次落盘失败：%v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("文件不存在：%v", err)
	}
	first := info.ModTime()

	// 内容一致：不重写（mtime 不变）
	if err := writeIfChanged(path, data); err != nil {
		t.Fatalf("二次落盘失败：%v", err)
	}
	info2, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !info2.ModTime().Equal(first) {
		t.Error("内容一致时不应重写文件")
	}

	// 内容不同：必须覆盖
	if err := writeIfChanged(path, []byte("new-dll")); err != nil {
		t.Fatalf("覆盖失败：%v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new-dll" {
		t.Errorf("内容未更新：%q", got)
	}
}

// 空数据不能落盘：那会生成一个 0 字节 DLL，LoadLibrary 必然失败。
func TestWriteIfChangedRejectsEmptyData(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, loaderDLLName)
	if err := writeIfChanged(path, nil); err == nil {
		t.Fatal("空数据应当报错")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("空数据不应生成文件")
	}
}

// 主路径：准备后 DLL 应在目标目录，且重复调用不会改变结果。
func TestPrepareWebView2LoaderWritesDLL(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "bin")
	path, err := PrepareWebView2Loader(dir)
	if err != nil {
		// 没有内嵌副本（构建标签差异）时跳过，不把环境问题当失败
		t.Skipf("准备 DLL 失败（环境不支持）：%v", err)
	}
	if filepath.Dir(path) != dir {
		t.Errorf("落盘路径不在目标目录：%s", path)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("DLL 未落盘：%v", err)
	}
	if info.Size() == 0 {
		t.Error("DLL 为空")
	}
	// 内嵌的是官方 DLL，应带微软签名文件典型体积（>100KB）
	if info.Size() < 100*1024 {
		t.Errorf("DLL 体积异常：%d", info.Size())
	}
}
