//go:build windows

package mesh

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func TestMeshFirewallRulePowerShell(t *testing.T) {
	alias := "cfpilot's虚拟网卡"
	encodedAlias := base64.StdEncoding.EncodeToString([]byte(alias))
	script := meshFirewallRulePowerShell(windowsTunAliasExpression(alias))
	for _, want := range []string{
		"[Convert]::FromBase64String('" + encodedAlias + "')",
		"-DisplayName '" + meshFirewallRuleName + "'",
		"-Direction Inbound",
		"-Action Allow",
		"-Profile Any",
		"-InterfaceAlias $n",
		"$aliases.Count -ne 1",
		"Remove-NetFirewallRule",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("script missing %q: %s", want, script)
		}
	}
	for _, unexpected := range []string{alias, "-LocalPort", "-Program"} {
		if strings.Contains(script, unexpected) {
			t.Fatalf("脚本包含不应出现的内容 %q", unexpected)
		}
	}
}

func TestWindowsNetworkCommandTimeout(t *testing.T) {
	_, err := runWindowsNetworkCommand(context.Background(), 100*time.Millisecond, windowsPowerShellPath,
		"-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 3")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("命令超时返回 %v", err)
	}
}

func TestWintunIOAfterCancellationAndClose(t *testing.T) {
	tun := &wintunTun{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := tun.Recv(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("取消后读取返回 %v", err)
	}
	if err := tun.Send(ctx, []byte{0}); !errors.Is(err, context.Canceled) {
		t.Fatalf("取消后写入返回 %v", err)
	}
	if err := tun.Close(); err != nil {
		t.Fatalf("关闭虚拟网卡失败: %v", err)
	}
	if _, err := tun.Recv(context.Background()); !errors.Is(err, io.EOF) {
		t.Fatalf("关闭后读取返回 %v", err)
	}
	if err := tun.Send(context.Background(), []byte{0}); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("关闭后写入返回 %v", err)
	}
}
