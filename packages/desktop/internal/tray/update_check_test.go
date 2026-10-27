package tray

import (
	"context"
	"errors"
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/update"
)

func TestMenuLabel(t *testing.T) {
	cases := []struct {
		base      string
		hasUpdate bool
		latest    string
		want      string
	}{
		{"检查应用更新", false, "", "检查应用更新"},
		{"检查应用更新", true, "0.7.6", "检查应用更新（有新版 0.7.6）"},
		{"检查部署更新", false, "0.7.6", "检查部署更新"},
		// 有新版标记但版本号为空时不要露出「（有新版 ）」这种半截话
		{"检查应用更新", true, "", "检查应用更新"},
	}
	for _, c := range cases {
		if got := menuLabel(c.base, c.hasUpdate, c.latest); got != c.want {
			t.Errorf("menuLabel(%q,%v,%q) = %q，期望 %q",
				c.base, c.hasUpdate, c.latest, got, c.want)
		}
	}
}

func TestUpdateCheckerCheck(t *testing.T) {
	var gotState *UpdateState
	c := NewUpdateChecker(
		func(ctx context.Context) (*update.CheckResult, error) {
			return &update.CheckResult{Current: "0.7.5", Latest: "0.7.6", HasUpdate: true}, nil
		},
		func(ctx context.Context) (*DeployCheckResult, error) {
			return &DeployCheckResult{RemoteVersion: "0.7.6", RemoteNewer: true}, nil
		},
	)
	c.SetOnChange(func(st *UpdateState) { gotState = st })

	st := c.Check(context.Background())
	if !st.AppHasUpdate || st.AppLatest != "0.7.6" {
		t.Errorf("应用更新判定错误：%+v", st)
	}
	if !st.DeployHasUpdate || st.DeployLatest != "0.7.6" {
		t.Errorf("部署更新判定错误：%+v", st)
	}
	if st.Err != "" {
		t.Errorf("不该有错误：%q", st.Err)
	}
	if gotState == nil {
		t.Fatal("状态变化回调没被触发")
	}
	if !gotState.AppHasUpdate {
		t.Error("回调拿到的状态不对")
	}
}

func TestUpdateCheckerPartialFailure(t *testing.T) {
	// 应用检查失败，部署检查仍应正常
	c := NewUpdateChecker(
		func(ctx context.Context) (*update.CheckResult, error) {
			return nil, errors.New("网络不通")
		},
		func(ctx context.Context) (*DeployCheckResult, error) {
			return &DeployCheckResult{RemoteVersion: "0.7.6", RemoteNewer: true}, nil
		},
	)

	st := c.Check(context.Background())
	if st.Err == "" {
		t.Error("应用检查失败应记录错误")
	}
	if !st.DeployHasUpdate {
		t.Error("部署检查不应受应用检查失败影响")
	}
}

func TestUpdateCheckerState(t *testing.T) {
	c := NewUpdateChecker(nil, nil)
	if c.State() != nil {
		t.Error("未检查过时 State 应为 nil")
	}
	c.Check(context.Background())
	if c.State() == nil {
		t.Error("检查后 State 不应为 nil")
	}
}
