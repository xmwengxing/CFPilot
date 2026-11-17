//go:build windows && mesh

package mesh

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// wintun 引导下载（ADR-0002：不捆绑，官方下载 + 双重 SHA256 校验）。
// 对齐 MobiHop crates/mobihop-dataplane/src/wintun.rs:81-181。
//
// 安装包/提权脚本调用 FetchWintun(dir)：下载官方 zip → 校验 zip SHA256 →
// 解压 bin/amd64/wintun.dll → 校验 DLL SHA256 → 写入目标目录。
// 任一步校验失败立即中止（fail-closed）。

const wintunZipSHA = "07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51"

// FetchWintun 下载并校验 wintun.dll 到 dir，返回最终路径。
func FetchWintun(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("wintun: 建目录失败: %w", err)
	}
	// 已存在有效 DLL → 直接返回
	target := filepath.Join(dir, "wintun.dll")
	if validWintunDLL(target) {
		return target, nil
	}

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Get(wintunURL)
	if err != nil {
		return "", fmt.Errorf("wintun: 下载失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("wintun: 下载 HTTP %d", resp.StatusCode)
	}
	zipBytes, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20)) // 上限 32MB
	if err != nil {
		return "", fmt.Errorf("wintun: 读取失败: %w", err)
	}
	if !sha256Match(zipBytes, wintunZipSHA) {
		return "", fmt.Errorf("wintun: zip SHA256 不符（期望 %s），已中止", wintunZipSHA)
	}

	dll, err := extractWintunDLL(zipBytes)
	if err != nil {
		return "", err
	}
	if !sha256Match(dll, wintunDLLSHA) {
		return "", fmt.Errorf("wintun: DLL SHA256 不符（期望 %s），已中止", wintunDLLSHA)
	}
	if err := os.WriteFile(target, dll, 0644); err != nil {
		return "", fmt.Errorf("wintun: 写入失败: %w", err)
	}
	return target, nil
}

// extractWintunDLL 从官方 zip 里找 DLL（支持扁平 wintun/bin/amd64 与一层嵌套）。
func extractWintunDLL(zipBytes []byte) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		return nil, fmt.Errorf("wintun: 解压失败: %w", err)
	}
	for _, f := range zr.File {
		base := filepath.Base(f.Name)
		if base != "wintun.dll" {
			continue
		}
		// 必须是 bin/amd64/ 下（避免误取 arm64 等）
		norm := filepath.ToSlash(f.Name)
		if !(bytes.Contains([]byte(norm), []byte("bin/amd64/")) || norm == "wintun.dll") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		defer rc.Close()
		return io.ReadAll(rc)
	}
	return nil, fmt.Errorf("wintun: zip 中找不到 bin/amd64/wintun.dll")
}

func validWintunDLL(path string) bool {
	raw, err := os.ReadFile(path)
	return err == nil && sha256Match(raw, wintunDLLSHA)
}

func sha256Match(b []byte, wantHex string) bool {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]) == wantHex
}
