package update

// 应用更新的自动替换。
//
// ## 为什么「自动替换自己」可行（此前是有意不做的）
//
// Go 版是单二进制，运行中的 exe 在 Windows 上**不能删除、不能覆盖写，
// 但可以重命名** —— 这就是 rename-swap 的基础：
//
//	1. 把当前 exe 改名为 <exe>.old（腾出路径）
//	2. 把下载好的新版本搬到位（同卷 rename，跨卷 copy）
//	3. 立即启动一个 helper 进程（= 新版 exe），它等旧进程退出后删掉 .old
//	4. 主进程退出，helper 以正常模式重启主程序
//
// ## 安全性（fail-closed）
//
// 下载完成的产物在**下载时**已按官方 SHA256SUMS 校验（update.go 的
// Download → verifyFileSHA256），下载完成时会把本地哈希写进
// <file>.sha256 sidecar；「重启并更新」时会**重新计算比对** ——
// sidecar 缺失或哈希不符一律拒绝替换。下载后到点击前这段时间里
// 文件被改动（无论何故）都无法被带入运行。
//
// 镜像只搬运文件，不参与摘要校验（见 mirrors.go 的既有纪律）。

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// ApplyUpdate 把下载好的新版本替换到当前程序位置。
//
// 返回值 oldPath 是旧版 exe 的改名位置（helper 进程负责在旧进程退出后
// 删除它）；失败时内部回滚，当前程序不受影响。
func ApplyUpdate(newFile string) (oldPath string, err error) {
	if strings.TrimSpace(newFile) == "" {
		return "", fmt.Errorf("缺少新版本文件路径")
	}
	info, err := os.Stat(newFile)
	if err != nil {
		return "", fmt.Errorf("新版本文件不存在：%v", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s 是目录，不是可执行文件", newFile)
	}

	// 再验一次哈希（下载时校验过，这里防「下载后到点击前」被改动）
	if err := VerifyLocalAgainstSidecar(newFile); err != nil {
		return "", err
	}

	// macOS：应用是 .app 包，换的是整个包（不是里面的可执行文件）。
	// 单文件 rename-swap 在那里会让 Info.plist / 资源 / 代码签名全部过期。
	if runtime.GOOS == "darwin" {
		return applyAppBundle(newFile)
	}

	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("定位当前程序失败：%v", err)
	}
	exe, _ = filepath.Abs(exe)
	newFile, _ = filepath.Abs(newFile)
	if strings.EqualFold(newFile, exe) {
		return "", fmt.Errorf("新版本文件与当前程序是同一个文件")
	}

	oldPath = exe + ".old"
	// 清掉上一次更新可能残留的 .old（上一次更新失败/超时未清理）
	if err := os.Remove(oldPath); err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("清理旧备份失败：%v", err)
	}

	// 1. 腾出路径：Windows 允许重命名运行中的 exe
	if err := os.Rename(exe, oldPath); err != nil {
		return "", fmt.Errorf("重命名当前程序失败：%v", err)
	}

	// 2. 把新版本搬到位：优先 rename（同卷零拷贝），跨卷退回 copy
	if err := os.Rename(newFile, exe); err != nil {
		if copyErr := copyExecutable(newFile, exe); copyErr != nil {
			// 回滚：把旧版搬回原位，当前程序继续可用
			if rbErr := os.Rename(oldPath, exe); rbErr != nil {
				return "", fmt.Errorf("替换失败且回滚也失败（旧版备份在 %s，请手动恢复）：%v；%v", oldPath, copyErr, rbErr)
			}
			return "", fmt.Errorf("替换失败（已回滚）：%v", copyErr)
		}
	}

	// 3. 删除缓存目录里可能残留的校验 sidecar（文件已搬走）
	_ = os.Remove(newFile + ".sha256")
	return oldPath, nil
}

// WriteSidecarSHA256 计算文件的 SHA-256 并写入 <file>.sha256 sidecar。
// 「重启并更新」时会重新计算比对 —— 防「下载后到点击前」被改动。
func WriteSidecarSHA256(file string) error {
	sum, err := fileSHA256(file)
	if err != nil {
		return err
	}
	return os.WriteFile(file+".sha256", []byte(hex.EncodeToString(sum)), 0o644)
}

// VerifyLocalAgainstSidecar 校验文件与 sidecar 里记录的哈希一致。
// sidecar 缺失 = 产物不是本程序下载的（旧版缓存 / 外部文件）→ 拒绝替换。
func VerifyLocalAgainstSidecar(file string) error {
	raw, err := os.ReadFile(file + ".sha256")
	if err != nil {
		return fmt.Errorf("缺少下载校验记录（%s.sha256）—— 请重新下载后再更新：%v", file, err)
	}
	expected := strings.TrimSpace(string(raw))
	if len(expected) < 64 {
		return fmt.Errorf("下载校验记录损坏，请重新下载后再更新")
	}
	sum, err := fileSHA256(file)
	if err != nil {
		return err
	}
	if hex.EncodeToString(sum) != strings.ToLower(expected[:64]) {
		return fmt.Errorf("新版本文件哈希与下载校验记录不符 —— 文件在下载后被改动过，已拒绝替换；请重新下载")
	}
	return nil
}

func fileSHA256(file string) ([]byte, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return nil, err
	}
	return h.Sum(nil), nil
}

// copyExecutable 跨卷搬运新版本（保留可执行位）。
func copyExecutable(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return err
	}
	return out.Close()
}

// SpawnUpdateHelper 启动 helper 进程：它等旧进程退出后删除 .old 备份，
// 再以正常模式重启主程序。
//
// helper 就是**新版 exe 自己**（swap 后原路径已是新版），re-exec 自身并带上
// 主进程原来的启动参数 —— 用户显式给过的 --port / --console 等不会丢。
func SpawnUpdateHelper(oldPath string, originalArgs []string) error {
	// macOS 不重启自身当 helper（swap 前后原路径已经是另一个包），
	// 改为拉起一个等待-替换-重启的小脚本。
	if runtime.GOOS == "darwin" {
		return spawnAppBundleSwap(originalArgs)
	}

	self, err := os.Executable()
	if err != nil {
		return err
	}
	args := append([]string{"--update-helper", oldPath}, originalArgs...)
	cmd := exec.Command(self, args...)
	// helper 独立于主进程生命周期（Windows 上需要分离进程组，
	// 否则主进程退出可能连带杀掉子进程 —— 默认行为已满足，无需额外设置）
	return cmd.Start()
}

// RestartExecutable 以正常模式重启主程序（helper 用）。
func RestartExecutable() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	return exec.Command(self).Start()
}

// 平台差异收口：Windows 上重命名运行中的 exe 是允许的；
// 其它平台（POSIX）rename 覆盖运行中的 exe 也允许 —— 统一走同一条单文件路径。
// 例外是 macOS（.app 整包替换），分支写在 ApplyUpdate 开头。
