package scan

import (
	"os"
	"testing"
)

func getenvOrSkip(t *testing.T, key string) string {
	v := os.Getenv(key)
	if v == "" {
		t.Skipf("未设置 %s，跳过真机测试", key)
	}
	return v
}
