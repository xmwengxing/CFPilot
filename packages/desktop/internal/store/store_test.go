package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestStore 用临时目录隔离，绝不碰真实用户目录。
func newTestStore(t *testing.T) *Store {
	t.Helper()
	return New(t.TempDir())
}

// 空库：没有文件时不报错，返回空列表。
func TestEmptyStore(t *testing.T) {
	s := newTestStore(t)

	ps, err := s.List()
	if err != nil {
		t.Fatalf("不该报错：%v", err)
	}
	if len(ps) != 0 {
		t.Errorf("应为空，实际 %d 条", len(ps))
	}
	if s.HasToken() {
		t.Error("空库不该报告有 Token")
	}
}

// 新建 → 列表 → 激活，基本闭环。
func TestCreateAndActivate(t *testing.T) {
	s := newTestStore(t)

	p, err := s.Create("我的账户", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(p.ID, "acc_") {
		t.Errorf("id 应以 acc_ 开头，实际 %q", p.ID)
	}
	if p.Name != "我的账户" {
		t.Errorf("名字不对：%q", p.Name)
	}

	activeID, err := s.ActiveID()
	if err != nil {
		t.Fatal(err)
	}
	if activeID != p.ID {
		t.Errorf("新建后应自动激活，期望 %s 实际 %s", p.ID, activeID)
	}

	list, _ := s.List()
	if len(list) != 1 {
		t.Errorf("应有 1 条，实际 %d", len(list))
	}
}

// 新建时若不传名字，要按账号名 / 账号 ID 推导。
func TestCreateDerivesName(t *testing.T) {
	s := newTestStore(t)

	// 有账号名 → 用账号名
	p1, _ := s.Create("", &Profile{AccountName: "user@example.com"})
	if p1.Name != "user@example.com" {
		t.Errorf("应推导为账号名，实际 %q", p1.Name)
	}

	// 只有账号 ID → 用前 8 位
	p2, _ := s.Create("", &Profile{AccountID: "70ec011b12cd621609a8412a4d0c1668"})
	if p2.Name != "账户 70ec011b" {
		t.Errorf("应推导为「账户 70ec011b」，实际 %q", p2.Name)
	}

	// 都没有 → 新账户
	p3, _ := s.Create("", nil)
	if p3.Name != "新账户" {
		t.Errorf("应回落「新账户」，实际 %q", p3.Name)
	}
}

// ProfileView 绝不能泄露 Token 明文。
func TestViewNeverExposesToken(t *testing.T) {
	s := newTestStore(t)

	secret := "cfat_SUPER_SECRET_TOKEN_VALUE"
	if _, err := s.Create("acct", &Profile{CfToken: secret, PanelPassword: "pw"}); err != nil {
		t.Fatal(err)
	}

	views, err := s.ListViews()
	if err != nil {
		t.Fatal(err)
	}
	if len(views) != 1 {
		t.Fatalf("应有 1 条")
	}
	v := views[0]
	if !v.HasToken {
		t.Error("应报告 hasToken=true")
	}
	if !v.HasPanelPw {
		t.Error("应报告 hasPanelPw=true")
	}

	// 序列化成 JSON 后也不该出现明文
	raw, _ := json.Marshal(v)
	if strings.Contains(string(raw), secret) {
		t.Error("视图 JSON 里泄露了 Token 明文")
	}
}

// 更新字段；未指定的字段不能被清空。
func TestUpdatePartial(t *testing.T) {
	s := newTestStore(t)

	p, _ := s.Create("a", &Profile{CfToken: "tok", AccountID: "acct1", PanelPassword: "pw1"})

	name := "改名"
	acctName := "user@x.com"
	updated, err := s.Update(p.ID, Patch{Name: &name, AccountName: &acctName})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "改名" {
		t.Errorf("名字应改成「改名」，实际 %q", updated.Name)
	}
	// 没传的字段必须保留
	if updated.CfToken != "tok" {
		t.Errorf("Token 不该被清空，实际 %q", updated.CfToken)
	}
	if updated.PanelPassword != "pw1" {
		t.Errorf("面板密码不该被清空")
	}
}

// 只传 AccountName 时，名字要跟着自动更新（与 Electron 版一致）。
func TestUpdateAutoDerivesName(t *testing.T) {
	s := newTestStore(t)

	p, _ := s.Create("旧名字", nil)
	acctName := "new@example.com"
	updated, err := s.Update(p.ID, Patch{AccountName: &acctName})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "new@example.com" {
		t.Errorf("名字应自动跟随账号名，实际 %q", updated.Name)
	}
}

// 更新不存在的 id 要报错。
func TestUpdateMissing(t *testing.T) {
	s := newTestStore(t)
	name := "x"
	if _, err := s.Update("acc_nope", Patch{Name: &name}); err == nil {
		t.Error("应当报错")
	}
}

// 删除激活项时，activeId 要顺延到下一个。
func TestDeleteShiftsActive(t *testing.T) {
	s := newTestStore(t)

	p1, _ := s.Create("A", nil)
	p2, _ := s.Create("B", nil)
	p3, _ := s.Create("C", nil)
	// 现在激活的是 p3

	deleted, activeID, err := s.Delete(p3.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !deleted {
		t.Error("应报告已删除")
	}
	// 删的是最后一项，顺延到前一个（p2）
	if activeID != p2.ID {
		t.Errorf("应顺延到 p2 (%s)，实际 %s", p2.ID, activeID)
	}

	// 删中间项：激活项不变
	deleted, activeID, _ = s.Delete(p1.ID)
	if !deleted || activeID != p2.ID {
		t.Errorf("删非激活项不该改激活，实际 %s", activeID)
	}
}

// 允许删到 0 份（用户可能想完全清空）。
func TestDeleteAllAllowed(t *testing.T) {
	s := newTestStore(t)

	p, _ := s.Create("only", nil)
	_, activeID, err := s.Delete(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if activeID != "" {
		t.Errorf("删空后 activeId 应为空，实际 %q", activeID)
	}
	list, _ := s.List()
	if len(list) != 0 {
		t.Errorf("应删空，实际 %d 条", len(list))
	}
}

// 删除不存在的 id：不报错，返回 deleted=false。
func TestDeleteMissing(t *testing.T) {
	s := newTestStore(t)
	deleted, _, err := s.Delete("acc_nope")
	if err != nil {
		t.Fatal(err)
	}
	if deleted {
		t.Error("不该报告删除成功")
	}
}

// 切换激活。
func TestSetActive(t *testing.T) {
	s := newTestStore(t)

	p1, _ := s.Create("A", nil)
	p2, _ := s.Create("B", nil)
	_ = p2

	ok, activeID, err := s.SetActive(p1.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || activeID != p1.ID {
		t.Errorf("切换失败：ok=%v active=%s", ok, activeID)
	}

	// 切到不存在的 id：不生效
	ok, activeID, _ = s.SetActive("acc_nope")
	if ok {
		t.Error("不存在的 id 不该切换成功")
	}
	if activeID != p1.ID {
		t.Errorf("激活项不该变，实际 %s", activeID)
	}
}

// v1 扁平结构要能自动迁移成 v2。
func TestMigrateV1(t *testing.T) {
	dir := t.TempDir()
	legacy := `{
  "cfToken": "cfat_legacy_token",
  "accountId": "70ec011b12cd621609a8412a4d0c1668",
  "kvNamespaceId": "22507775fc174257a7b840ea3e81dbf3",
  "panelPassword": "mypw"
}`
	if err := os.WriteFile(filepath.Join(dir, "secrets.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}

	s := New(dir)
	ps, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(ps) != 1 {
		t.Fatalf("迁移后应有 1 条，实际 %d", len(ps))
	}
	p := ps[0]
	if p.CfToken != "cfat_legacy_token" {
		t.Errorf("Token 丢失：%q", p.CfToken)
	}
	if p.AccountID != "70ec011b12cd621609a8412a4d0c1668" {
		t.Errorf("AccountID 丢失：%q", p.AccountID)
	}
	if p.KVNamespaceID != "22507775fc174257a7b840ea3e81dbf3" {
		t.Errorf("KV 丢失：%q", p.KVNamespaceID)
	}
	if p.PanelPassword != "mypw" {
		t.Errorf("面板密码丢失")
	}
	// 名字应推导成「账户 70ec011b」
	if p.Name != "账户 70ec011b" {
		t.Errorf("名字推导不对：%q", p.Name)
	}

	// 迁移后应立即落盘为 v2
	raw, err := os.ReadFile(filepath.Join(dir, "secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	var check struct {
		Version  int       `json:"version"`
		Profiles []Profile `json:"profiles"`
	}
	if err := json.Unmarshal(raw, &check); err != nil {
		t.Fatal(err)
	}
	if check.Version != 2 {
		t.Errorf("迁移后 version 应为 2，实际 %d", check.Version)
	}
	if len(check.Profiles) != 1 {
		t.Errorf("迁移后应写回 profiles，实际 %d", len(check.Profiles))
	}
}

// 损坏的文件不能阻塞程序启动。
func TestCorruptFileTolerated(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "secrets.json"), []byte("{ 这不是 json"), 0o600); err != nil {
		t.Fatal(err)
	}

	s := New(dir)
	ps, err := s.List()
	if err != nil {
		t.Fatalf("损坏文件不该报错：%v", err)
	}
	if len(ps) != 0 {
		t.Errorf("应回落为空库，实际 %d 条", len(ps))
	}
}

// activeId 指向不存在的 profile 时，回落到第一个。
func TestActiveIDFallback(t *testing.T) {
	dir := t.TempDir()
	bad := `{
  "version": 2,
  "activeId": "acc_gone",
  "profiles": [{"id": "acc_real", "name": "A", "cfToken": "t"}]
}`
	if err := os.WriteFile(filepath.Join(dir, "secrets.json"), []byte(bad), 0o600); err != nil {
		t.Fatal(err)
	}

	s := New(dir)
	activeID, _ := s.ActiveID()
	if activeID != "acc_real" {
		t.Errorf("应回落到 acc_real，实际 %q", activeID)
	}
}

// SaveActive：没有账户时自动新建（对应 Electron 版的 saveSecrets 语义）。
func TestSaveActiveAutoCreates(t *testing.T) {
	s := newTestStore(t)

	tok := "cfat_new"
	acct := "acct1234567"
	p, err := s.SaveActive(Patch{CfToken: &tok, AccountID: &acct})
	if err != nil {
		t.Fatal(err)
	}
	if p == nil {
		t.Fatal("应自动新建一份 profile")
	}
	if p.CfToken != tok || p.AccountID != acct {
		t.Errorf("字段没写进去：%+v", p)
	}
	if !s.HasToken() {
		t.Error("应报告有 Token")
	}
}

// Clear 把文件移到 .bak，不是直接删（误点能找回）。
func TestClearMovesToBackup(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.Create("a", &Profile{CfToken: "t"}); err != nil {
		t.Fatal(err)
	}

	if err := s.Clear(); err != nil {
		t.Fatal(err)
	}

	// 原文件应消失
	if _, err := os.Stat(filepath.Join(s.Dir, "secrets.json")); !os.IsNotExist(err) {
		t.Error("原文件应被移走")
	}
	// 备份应存在且含原内容
	raw, err := os.ReadFile(filepath.Join(s.Dir, "secrets.json.bak"))
	if err != nil {
		t.Fatalf("备份不存在：%v", err)
	}
	if !strings.Contains(string(raw), `"cfToken": "t"`) {
		t.Error("备份内容不对")
	}
}

// 落盘文件权限必须是 0600（凭据文件不能让同机其他用户读）。
func TestFilePermission(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.Create("a", &Profile{CfToken: "t"}); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(filepath.Join(s.Dir, "secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	// Windows 上权限位不生效，只在类 Unix 上断言
	if os.PathSeparator == '/' {
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Errorf("文件权限应为 0600，实际 %o", mode)
		}
	}
}
