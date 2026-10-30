package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAssetNameFromURL(t *testing.T) {
	cases := map[string]string{
		"https://github.com/xmwengxing/CFPilot/releases/download/v0.10.1/cfpilot-0.10.1-windows-amd64.exe": "cfpilot-0.10.1-windows-amd64.exe",
		// 镜像前缀不影响取最后一段
		"https://ghfast.top/https://github.com/xmwengxing/CFPilot/releases/download/v0.10.1/cfpilot-0.10.1-linux-amd64": "cfpilot-0.10.1-linux-amd64",
	}
	for in, want := range cases {
		if got := assetNameFromURL(in); got != want {
			t.Fatalf("assetNameFromURL(%q) = %q，期望 %q", in, got, want)
		}
	}
}

func TestReleaseTagFromURL(t *testing.T) {
	url := "https://github.com/xmwengxing/CFPilot/releases/download/v0.10.1/cfpilot-0.10.1-windows-amd64.exe"
	if got := releaseTagFromURL(url); got != "v0.10.1" {
		t.Fatalf("tag = %q，期望 v0.10.1", got)
	}

	// 解析不出来必须返回空串 —— 调用方据此拒绝下载，不能静默跳过校验
	for _, bad := range []string{
		"https://example.com/cfpilot.exe",
		"https://github.com/x/releases/tag/v1.0.0",
		"https://github.com/x/releases/download/../evil/x.exe",
	} {
		if got := releaseTagFromURL(bad); got != "" {
			t.Fatalf("releaseTagFromURL(%q) = %q，期望空串", bad, got)
		}
	}
}

func TestParseChecksums(t *testing.T) {
	const text = "" +
		"aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899  cfpilot-0.10.1-windows-amd64.exe\n" +
		"11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff *cfpilot-0.10.1-linux-amd64\n" +
		"# 注释行\n" +
		"垃圾行\n"

	sums := parseChecksums(text)
	if len(sums) != 2 {
		t.Fatalf("应解析出 2 条，实际 %d：%v", len(sums), sums)
	}
	if sums["cfpilot-0.10.1-windows-amd64.exe"] != "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899" {
		t.Fatalf("第一条摘要解析错误：%v", sums)
	}
	// `*` 是 sha256sum 的二进制模式标记，必须剥掉
	if _, ok := sums["cfpilot-0.10.1-linux-amd64"]; !ok {
		t.Fatalf("`*` 前缀未剥离：%v", sums)
	}
}

func TestVerifyFileSHA256(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "cfpilot-test.exe")
	if err := os.WriteFile(file, []byte("hello-cfpilot"), 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("hello-cfpilot"))
	good := hex.EncodeToString(sum[:])

	if err := verifyFileSHA256(file, good); err != nil {
		t.Fatalf("摘要一致时应通过：%v", err)
	}
	if err := verifyFileSHA256(file, strings.Repeat("0", 64)); err == nil {
		t.Fatal("摘要不一致时必须报错")
	}
	if err := verifyFileSHA256(filepath.Join(dir, "missing.exe"), good); err == nil {
		t.Fatal("文件不存在时必须报错")
	}
}

func TestFetchDesktopChecksums(t *testing.T) {
	old := ReleasesWebBase
	defer func() { ReleasesWebBase = old }()

	body := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899  cfpilot-0.10.1-windows-amd64.exe\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/download/v0.10.1/"+DesktopChecksumsAssetName {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	ReleasesWebBase = srv.URL

	sums, err := fetchDesktopChecksums(context.Background(), "v0.10.1")
	if err != nil {
		t.Fatalf("正常清单不应报错：%v", err)
	}
	if len(sums) != 1 {
		t.Fatalf("应解析出 1 条，实际 %v", sums)
	}

	// 清单缺失 → 必须报错（fail-closed），不能回退成「不校验也装」
	if _, err := fetchDesktopChecksums(context.Background(), "v0.9.0"); err == nil {
		t.Fatal("清单不存在时必须报错")
	}
	// tag 解析不出来 → 直接拒绝
	if _, err := fetchDesktopChecksums(context.Background(), ""); err == nil {
		t.Fatal("空 tag 必须报错")
	}
}
