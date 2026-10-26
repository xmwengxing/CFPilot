package server

// 测试辅助：构造隔离的凭据库与 patch。

import (
	"testing"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/store"
)

// newEmptyStore 造一个临时目录下的空凭据库。
func newEmptyStore(t *testing.T) *store.Store {
	t.Helper()
	return store.New(t.TempDir())
}

// patchToken 返回「只设置 Token」的补丁。
func patchToken(token string) store.Patch {
	return store.Patch{CfToken: &token}
}

// patchTokenAndAccount 返回「设置 Token 与账号 ID」的补丁。
func patchTokenAndAccount(token, accountID string) store.Patch {
	return store.Patch{
		CfToken:   &token,
		AccountID: &accountID,
	}
}
