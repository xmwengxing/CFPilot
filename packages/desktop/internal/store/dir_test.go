package store

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/config"
)

// TestDefaultDirFollowsDataDirEnv 凭据目录必须认 CFPILOT_DATA_DIR。
//
// ## 为什么这条很重要
//
// 曾经两边各写一份目录解析：
//   - config.Dir() 认 CFPILOT_DATA_DIR；
//   - store.DefaultDir() 只看用户主目录。
//
// 于是「设置与日志在挂载卷里、凭据却落在别处」——
// 容器重建后凭据没了；安卓上更糟：应用进程通常没有 HOME，
// 凭据被写到**相对路径**（相对进程工作目录，通常不可写）
// → 「保存 Token」静默失败。
func TestDefaultDirFollowsDataDirEnv(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(config.EnvDataDir, dir)

	got := DefaultDir()
	if got != dir {
		t.Fatalf("凭据目录应跟随 %s，实际 %s", config.EnvDataDir, got)
	}

	// 凭据文件必须真的落在那个目录里
	st := New("")
	if err := st.writeFile(&file{Version: 2}); err != nil {
		t.Fatalf("写入失败：%v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "secrets.json")); err != nil {
		t.Fatalf("凭据文件没落在 %s：%v", dir, err)
	}
}

// TestDefaultDirNotRelativeWithoutHome 没有 HOME 时不能返回相对路径。
//
// 相对路径是相对**进程工作目录**解析的 ——
// 在安卓上工作目录是 /，写不进去；在容器里是 /，同样写不进去。
// 返回相对路径等于「把错误藏起来」，不如明确报错。
func TestDefaultDirNotRelativeWithoutHome(t *testing.T) {
	t.Setenv(config.EnvDataDir, "")
	t.Setenv("HOME", "")
	t.Setenv("USERPROFILE", "")
	t.Setenv("HOMEDRIVE", "")
	t.Setenv("HOMEPATH", "")

	got := DefaultDir()
	if got == "" {
		t.Fatal("拿不到目录时应返回兜底值")
	}
	if !filepath.IsAbs(got) {
		t.Fatalf("凭据目录不能是相对路径（相对进程工作目录，通常不可写）：%s", got)
	}
}
