package mesh

import (
	"testing"
)

func TestProfileStoreSaveSelectDelete(t *testing.T) {
	dir := t.TempDir()
	store, err := NewProfileStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{NetworkName: "n", PSK: "s", VirtualIP: "10.97.0.1", Listen: "0.0.0.0:51820"}
	if err := store.Save("家里-公司", cfg); err != nil {
		t.Fatal(err)
	}
	if !store.AutoStartEnabled() {
		t.Fatal("保存后应允许服务重启自动恢复")
	}
	got := store.SelectedConfig()
	if got == nil || got.NetworkName != "n" || got.VirtualIP != "10.97.0.1" {
		t.Fatalf("选中配置不正确: %+v", got)
	}
	if err := store.Select("不存在"); err == nil {
		t.Fatal("选择不存在的档案应失败")
	}
	if err := store.Delete("家里-公司"); err != nil {
		t.Fatal(err)
	}
	if store.AutoStartEnabled() || store.SelectedConfig() != nil {
		t.Fatal("删除当前档案后不应继续自动恢复")
	}
}
