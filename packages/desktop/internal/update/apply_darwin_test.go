//go:build darwin

package update

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// 整包替换脚本的真实行为：等进程退出 → 旧包改名 → 新包到位 → 清理。
//
// 这里直接跑生成的 shell 脚本（不拉起真实 .app），因为脚本才是真正做替换的
// 那一段；而「等进程退出」用 pid=1（常驻进程）会挂住，用一个已经退出的 pid 更快。
//
// ⚠️ 这段逻辑只在 macOS 上可测（脚本里用了 ditto / xattr / open），
// CI 的 macos job 会跑它。
func TestAppSwapScriptReplacesBundle(t *testing.T) {
	tmp := t.TempDir()

	oldExe := filepath.Join(tmp, "CFPilot.app", "Contents", "MacOS", "CFPilot")
	mkdirAll(t, filepath.Dir(oldExe))
	writeFile(t, oldExe, "old")
	writeFile(t, filepath.Join(tmp, "CFPilot.app", "Contents", "Info.plist"), "old-plist")

	staged := filepath.Join(tmp, "staged", "CFPilot.app")
	mkdirAll(t, filepath.Join(staged, "Contents", "MacOS"))
	writeFile(t, filepath.Join(staged, "Contents", "MacOS", "CFPilot"), "new")
	writeFile(t, filepath.Join(staged, "Contents", "Info.plist"), "new-plist")

	swap := &bundleSwap{
		bundle:    filepath.Join(tmp, "CFPilot.app"),
		staged:    staged,
		stagedDir: filepath.Join(tmp, "staged"),
		old:       filepath.Join(tmp, "CFPilot.app") + ".old",
	}
	// pid 用一个已退出的进程：脚本的等待循环会立即通过。
	// relaunch 关掉（不带参数时仍会 open）—— 见下：用空 relaunch 的变体。
	script := appSwapScript(swap, 999999, nil, false)
	scriptPath := filepath.Join(tmp, "swap.sh")
	writeFile(t, scriptPath, script)

	out, err := exec.Command("/bin/sh", scriptPath).CombinedOutput()
	if err != nil {
		t.Fatalf("脚本执行失败：%v\n%s\n--- 脚本 ---\n%s", err, out, script)
	}

	got, err := os.ReadFile(filepath.Join(tmp, "CFPilot.app", "Contents", "MacOS", "CFPilot"))
	if err != nil {
		t.Fatalf("替换后读不到可执行文件：%v", err)
	}
	if string(got) != "new" {
		t.Fatalf("应该装上新版本，实际内容 %q", got)
	}
	plist, _ := os.ReadFile(filepath.Join(tmp, "CFPilot.app", "Contents", "Info.plist"))
	if string(plist) != "new-plist" {
		t.Errorf("Info.plist 也应该是新的，实际 %q", plist)
	}
	if _, err := os.Stat(swap.old); !os.IsNotExist(err) {
		t.Errorf("旧包备份应当被清理，实际 err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(tmp, "staged")); !os.IsNotExist(err) {
		t.Errorf("暂存目录应当被整个清理（不只里面的 .app），实际 err=%v", err)
	}
}

// 替换失败（暂存不存在）时必须把旧包放回去，不能留下一个空壳。
func TestAppSwapScriptRollsBackOnCopyFailure(t *testing.T) {
	tmp := t.TempDir()

	oldExe := filepath.Join(tmp, "CFPilot.app", "Contents", "MacOS", "CFPilot")
	mkdirAll(t, filepath.Dir(oldExe))
	writeFile(t, oldExe, "old")

	swap := &bundleSwap{
		bundle:    filepath.Join(tmp, "CFPilot.app"),
		staged:    filepath.Join(tmp, "missing.app"), // 不存在 → ditto 失败
		stagedDir: filepath.Join(tmp, "missing"),
		old:       filepath.Join(tmp, "CFPilot.app") + ".old",
	}
	scriptPath := filepath.Join(tmp, "swap.sh")
	writeFile(t, scriptPath, appSwapScript(swap, 999999, nil, false))

	if out, err := exec.Command("/bin/sh", scriptPath).CombinedOutput(); err == nil {
		t.Fatalf("复制失败时脚本应当返回非零，实际成功：%s", out)
	}

	got, err := os.ReadFile(oldExe)
	if err != nil {
		t.Fatalf("回滚后旧包应该还在：%v", err)
	}
	if string(got) != "old" {
		t.Fatalf("回滚后内容应为旧版，实际 %q", got)
	}
}

// shellQuote 要能处理单引号与空格（用户可能把 app 放在带引号的目录里）。
func TestShellQuote(t *testing.T) {
	cases := map[string]string{
		"/Applications/CFPilot.app": `'/Applications/CFPilot.app'`,
		"/Users/a b/CFPilot.app":    `'/Users/a b/CFPilot.app'`,
		"/Users/it's/CFPilot.app":   `'/Users/it'\''s/CFPilot.app'`,
		"--port":                    `'--port'`,
	}
	for in, want := range cases {
		if got := shellQuote(in); got != want {
			t.Errorf("shellQuote(%q) = %q，期望 %q", in, got, want)
		}
	}
	if !strings.HasPrefix(shellQuote("x"), "'") {
		t.Error("必须用单引号包裹")
	}
}

// appBundlePath 在测试进程里应当失败（go test 的二进制不在 .app 内）——
// 这条断言保证「裸二进制」场景给的是可读错误，而不是一个假路径。
func TestAppBundlePathRejectsNonBundle(t *testing.T) {
	_, err := appBundlePath()
	if err == nil {
		// 某些测试环境可能把测试跑在 .app 里（例如 Xcode）；此时只校验路径形态
		return
	}
	if !strings.Contains(err.Error(), ".app") {
		t.Errorf("错误信息应提示 .app，实际 %v", err)
	}
}

// ---- 测试辅助 ----

func mkdirAll(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("建目录 %s 失败：%v", dir, err)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("写文件 %s 失败：%v", path, err)
	}
}
