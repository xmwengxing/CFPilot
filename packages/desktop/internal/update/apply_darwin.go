//go:build darwin

package update

// macOS 的应用更新：换的是**整个 .app**，不是里面的可执行文件。
//
// ## 为什么不能沿用「单二进制替换」
//
// Windows / Linux 的产物就是一个文件，rename-swap 即可。macOS 的应用是
// 一个目录（CFPilot.app/Contents/{MacOS,Resources,Info.plist}），且带代码签名：
//
//   - 只替换 Contents/MacOS/CFPilot → Info.plist 的版本号、图标、资源全是旧的；
//   - 更糟的是**签名立刻失效**（签名覆盖整个 bundle 的文件哈希），
//     Gatekeeper 下次校验会看到「签名与内容不符」。
//
// 所以 macOS 走：下载 dmg → 挂载 → 把新的 .app 拷到暂存区 → 退出后整体换掉。
//
// ## 为什么要等进程退出再换
//
// 正在运行的 .app 目录可以整体改名（macOS 按 inode 认，不影响已跑的进程），
// 但**不能在上面直接覆盖写**（dyld 正持有它）。而本进程正在执行的正是
// 要被换掉的那个 bundle，所以替换动作只能由一个「外部小脚本」在退出后做：
//
//	1. 主进程挂载 dmg、staged 出新的 .app、生成脚本、拉起脚本 → 自己退出
//	2. 脚本轮询到主进程消失 → 旧的 .app 改名为 .app.old → ditto 新的到位
//	3. xattr 清 quarantine（用户手动装过的 dmg 会带）→ open 新 .app
//	4. 删除 .app.old 与暂存目录
//
// 用 shell 而不是再写一个 Go helper：这段逻辑只有十几行、没有网络与解析，
// 出问题时用户能直接把脚本打印出来看（错误信息里就带着脚本路径）。
//
// ## 失败语义（fail-closed）
//
// 挂载失败、dmg 里没有 .app、暂存出来的包签名不对 → 一律报错返回，
// 不修改当前安装；脚本里 ditto 失败会把旧的改名回去。用户最坏情况是
// 「没更新成功」，绝不会留下一个半坏的 .app。

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// bundleSwap 记录一次待执行的整包替换。
//
// ApplyUpdate 准备好暂存目录，SpawnUpdateHelper 用它生成脚本 ——
// 两次调用之间没有别的写入者，故用包级变量传递。
var bundleSwapState struct {
	mu   sync.Mutex
	next *bundleSwap
}

type bundleSwap struct {
	bundle string // 当前运行中的 .app 绝对路径
	staged string // 暂存目录里的新 .app 绝对路径
	// stagedDir 是暂存目录本身。脚本只删 $STAGED 的话会留下一个空目录，
	// 每更新一次漏一个 —— 所以单独传进去一并清掉。
	stagedDir string
	old       string // 旧包改名后的路径（bundle + ".old"）
}

// appBundlePath 从当前可执行文件反推 .app 根目录。
//
// 布局是 <bundle>/Contents/MacOS/<二进制>；不在 bundle 里（直接跑裸二进制，
// 例如开发者调试）时返回错误 —— 那种场景没有 .app 可换，应该由调用方
// 提示手动安装。
func appBundlePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("定位当前程序失败：%w", err)
	}
	exe, err = filepath.Abs(exe)
	if err != nil {
		return "", err
	}
	// .../CFPilot.app/Contents/MacOS/CFPilot
	macOSDir := filepath.Dir(exe)
	contents := filepath.Dir(macOSDir)
	bundle := filepath.Dir(contents)
	if filepath.Base(macOSDir) != "MacOS" || filepath.Base(contents) != "Contents" ||
		!strings.HasSuffix(bundle, ".app") {
		return "", fmt.Errorf("当前程序不在 .app 包内（%s），无法整包更新；请下载 dmg 覆盖安装", exe)
	}
	return bundle, nil
}

// applyAppBundle 把 dmg 里的 .app 暂存好，等进程退出后整体替换。
//
// 返回的 oldPath 只用于给用户看的提示（旧包备份位置）；真正的替换由
// spawnAppBundleSwap 生成的脚本完成。
func applyAppBundle(newFile string) (string, error) {
	if !strings.HasSuffix(strings.ToLower(newFile), ".dmg") {
		return "", fmt.Errorf("macOS 更新包必须是 dmg（实际：%s）", filepath.Base(newFile))
	}

	bundle, err := appBundlePath()
	if err != nil {
		return "", err
	}

	stagedDir, stagedApp, err := extractAppFromDMG(newFile)
	if err != nil {
		return "", err
	}

	swap := &bundleSwap{
		bundle:    bundle,
		staged:    stagedApp,
		stagedDir: stagedDir,
		old:       bundle + ".old",
	}
	bundleSwapState.mu.Lock()
	bundleSwapState.next = swap
	bundleSwapState.mu.Unlock()

	// 暂存目录要保留到脚本跑完：脚本 ditto 完会连同它一起删。
	return swap.old, nil
}

// extractAppFromDMG 挂载 dmg 并把其中的 .app 拷进暂存目录。
//
// 用 ditto 而不是逐文件拷贝：它保留扩展属性与符号链接，
// 代码签名的封装（_CodeSignature）靠这些属性才完整。
func extractAppFromDMG(dmgPath string) (stagedDir, stagedApp string, err error) {
	stagedDir, err = os.MkdirTemp("", "cfpilot-update-")
	if err != nil {
		return "", "", fmt.Errorf("创建暂存目录失败：%w", err)
	}
	cleanup := func() {
		_ = os.RemoveAll(stagedDir)
	}

	mountPoint, err := os.MkdirTemp("", "cfpilot-dmg-")
	if err != nil {
		cleanup()
		return "", "", fmt.Errorf("创建挂载点失败：%w", err)
	}
	// 挂载点目录必须为空，hdiutil 自己也会检查
	_ = os.Remove(mountPoint)
	defer func() { _ = os.RemoveAll(mountPoint) }()

	attach := exec.Command("hdiutil", "attach", "-nobrowse", "-readonly", "-noverify",
		"-mountpoint", mountPoint, dmgPath)
	if out, attachErr := attach.CombinedOutput(); attachErr != nil {
		cleanup()
		return "", "", fmt.Errorf("挂载 dmg 失败：%v（%s）", attachErr, strings.TrimSpace(string(out)))
	}
	defer func() {
		// 卸载失败不致命：镜像还在，用户手动 eject 即可。但暂存目录已经拷好，
		// 后面的替换不受影响。
		_ = exec.Command("hdiutil", "detach", mountPoint, "-force").Run()
		_ = os.RemoveAll(mountPoint)
	}()

	apps, err := filepath.Glob(filepath.Join(mountPoint, "*.app"))
	if err != nil || len(apps) == 0 {
		cleanup()
		return "", "", errors.New("dmg 里没有 .app —— 安装包损坏，请重新下载")
	}
	sort.Strings(apps)
	source := apps[0]

	if !hasBundleExecutable(source) {
		cleanup()
		return "", "", fmt.Errorf("%s 缺少 Contents/MacOS 下的可执行文件", filepath.Base(source))
	}
	// 签名校验：发布产物一定是签过名的（至少 ad-hoc）。这里失败就拒绝安装，
	// 避免把「内容与签名不符」的包换进去 —— 那会换来一个打不开的应用。
	if err := verifyBundleSignature(source); err != nil {
		cleanup()
		return "", "", err
	}

	stagedApp = filepath.Join(stagedDir, filepath.Base(source))
	if out, err := exec.Command("ditto", source, stagedApp).CombinedOutput(); err != nil {
		cleanup()
		return "", "", fmt.Errorf("复制新版本失败：%v（%s）", err, strings.TrimSpace(string(out)))
	}
	// ditto 之后重新校验一次：只信「即将装上去的那份」。
	if err := verifyBundleSignature(stagedApp); err != nil {
		cleanup()
		return "", "", err
	}
	return stagedDir, stagedApp, nil
}

// hasBundleExecutable 检查 .app 里是否真有可执行文件。
func hasBundleExecutable(app string) bool {
	matches, _ := filepath.Glob(filepath.Join(app, "Contents", "MacOS", "*"))
	for _, m := range matches {
		if info, err := os.Stat(m); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return true
		}
	}
	return false
}

func verifyBundleSignature(app string) error {
	out, err := exec.Command("codesign", "--verify", "--strict", app).CombinedOutput()
	if err != nil {
		return fmt.Errorf("新版本 .app 签名校验失败：%v（%s）", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// spawnAppBundleSwap 生成替换脚本并拉起，随后本进程可以退出。
func spawnAppBundleSwap(originalArgs []string) error {
	bundleSwapState.mu.Lock()
	swap := bundleSwapState.next
	bundleSwapState.mu.Unlock()
	if swap == nil {
		return errors.New("没有待执行的整包替换（ApplyUpdate 未成功）")
	}

	scriptDir, err := os.MkdirTemp("", "cfpilot-swap-")
	if err != nil {
		return fmt.Errorf("创建脚本目录失败：%w", err)
	}
	scriptPath := filepath.Join(scriptDir, "swap.sh")
	if err := os.WriteFile(scriptPath, []byte(appSwapScript(swap, os.Getpid(), originalArgs, true)), 0o700); err != nil {
		return fmt.Errorf("写替换脚本失败：%w", err)
	}

	cmd := exec.Command("/bin/sh", scriptPath)
	// 独立会话：主进程退出后脚本还要继续跑（否则会被一起带走）
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动替换脚本失败（旧版未改动，旧包备份在 %s）：%w", swap.old, err)
	}
	// 父进程不等待：脚本自己等我们退出。Release 一下避免僵尸。
	_ = cmd.Process.Release()
	return nil
}

// appSwapScript 生成等待-替换-重启脚本。
//
// relaunch=false 只用于单元测试：真是替换时一定会重新打开新版本，
// 但测试里不能拉起一个不存在的 .app。
//
// 抽成纯函数是为了能在 macOS 上直接跑测试（不依赖真实 .app 安装）。
func appSwapScript(swap *bundleSwap, pid int, args []string, relaunch bool) string {
	q := shellQuote

	var reopen strings.Builder
	if relaunch {
		reopen.WriteString("open -n -a " + q(swap.bundle))
		if len(args) > 0 {
			// 用户显式给过的 --port / --console 等原样透传，与 Windows helper 同口径。
			reopen.WriteString(" --args")
			for _, a := range args {
				reopen.WriteString(" " + q(a))
			}
		}
		reopen.WriteString("\n")
	}

	return `#!/bin/sh
# 由 CFPilot 生成：等旧进程退出 → 整体替换 .app → 重新打开。
# 任何一步失败都尽量把旧包放回去，绝不留下半坏的安装。
set -u

PID=` + strconv.Itoa(pid) + `
BUNDLE=` + q(swap.bundle) + `
STAGED=` + q(swap.staged) + `
STAGED_DIR=` + q(swap.stagedDir) + `
OLD=` + q(swap.old) + `

# 最多等 60 秒（300 × 0.2s）：进程卡死时不能让用户以为「点了没反应」
n=0
while kill -0 "$PID" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 300 ]; then
    echo "等待旧进程退出超时，放弃替换" >&2
    exit 1
  fi
  sleep 0.2
done

rm -rf "$OLD"
if [ -d "$BUNDLE" ]; then
  if ! mv "$BUNDLE" "$OLD"; then
    echo "旧包改名失败（目录不可写？）" >&2
    exit 1
  fi
fi

if ! ditto "$STAGED" "$BUNDLE"; then
  echo "复制新版本失败，正在回滚" >&2
  rm -rf "$BUNDLE"
  [ -d "$OLD" ] && mv "$OLD" "$BUNDLE"
  exit 1
fi

# 用户手动装过的 dmg 会给 .app 打 quarantine 标记，不清掉新版本会被拦。
xattr -dr com.apple.quarantine "$BUNDLE" 2>/dev/null || true

` + reopen.String() + `
rm -rf "$OLD" "$STAGED_DIR"
rm -f "$0"
`
}

// shellQuote 把路径 / 参数包成安全的单引号形式。
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// 保证 time 被引用（脚本等待相关的文档里提到超时口径）
var _ = time.Second
