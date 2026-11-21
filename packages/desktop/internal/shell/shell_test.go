package shell

import (
	"strings"
	"testing"
)

func TestDecodeCommand(t *testing.T) {
	c, err := decodeCommand(`{"cmd":"open-external","url":"https://example.com"}`)
	if err != nil {
		t.Fatalf("合法命令不该报错：%v", err)
	}
	if c.Cmd != CmdOpenExternal || c.URL != "https://example.com" {
		t.Fatalf("解析结果不对：%+v", c)
	}

	if _, err := decodeCommand("not json"); err == nil {
		t.Fatal("非法 JSON 应当报错")
	}
}

func TestSanitizePage(t *testing.T) {
	ok := map[string]string{
		"cred":   "cred",
		"deploy": "deploy",
		"scan":   "scan",
		"":       "",
	}
	for in, want := range ok {
		if got := sanitizePage(in); got != want {
			t.Errorf("sanitizePage(%q) = %q，期望 %q", in, got, want)
		}
	}

	// 这些值会被拼进 Eval 的脚本里，必须一个都放不过去。
	bad := []string{
		`scan");alert(1);//`,
		"scan'",
		"scan\n",
		"SCAN",
		"page-name-with-too-many-chars",
		strings.Repeat("a", 25),
	}
	for _, in := range bad {
		if got := sanitizePage(in); got != "" {
			t.Errorf("sanitizePage(%q) = %q，应当被拒绝", in, got)
		}
	}
}

func TestExternalAllowed(t *testing.T) {
	for _, u := range []string{
		"https://dash.cloudflare.com/profile/api-tokens",
		"https://github.com/xmwengxing/CFPilot",
	} {
		if !externalAllowed(u) {
			t.Errorf("%q 应当放行", u)
		}
	}
	for _, u := range []string{
		"http://example.com",
		"file:///etc/passwd",
		"javascript:alert(1)",
		"",
		"https://",
	} {
		if externalAllowed(u) {
			t.Errorf("%q 不应当放行", u)
		}
	}
}

func TestInitScriptDeclaresHost(t *testing.T) {
	js := InitScript("windows", ChromeCustom)
	for _, want := range []string{"__cfpilotShell", "cfpilotShellCommand", "windows", "custom"} {
		if !strings.Contains(js, want) {
			t.Errorf("注入脚本里缺少 %q：\n%s", want, js)
		}
	}

	// 平台与标题栏归属都要如实写入，界面据此决定是否画自绘标题栏。
	native := InitScript("linux", ChromeNative)
	if !strings.Contains(native, `"native"`) {
		t.Errorf("Linux 应使用原生标题栏：\n%s", native)
	}
}

func TestPageScriptUsesNavButton(t *testing.T) {
	js := pageScript("deploy")
	if !strings.Contains(js, `data-page="deploy"`) {
		t.Fatalf("页签脚本没有落到导航按钮上：%s", js)
	}
}
