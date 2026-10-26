package store

// 跨版本兼容性测试。
//
// ## 为什么需要它
//
// Go 版与 Electron 版**共用同一个 secrets.json**。如果两边的解析或写回规则
// 有任何差异，用户换版本时就会丢 Token、丢账户、甚至把文件写坏。
//
// 单测只能证明「Go 版自洽」，证明不了「与 Node 版一致」。
// 所以这里用 node 直接跑 Electron 版的**真实实现**
// （packages/gui/src/main/config-store.ts，经 esbuild 转译），
// 把两边对同一份文件的读取结果逐字段比对。
//
// 没装 node / esbuild 时自动跳过。
//
// ## 关键实现细节：homedir 必须用 esbuild 插件替换
//
// config-store.ts 用 `os.homedir()` 定位配置目录。实测在 Windows 上
// **进程启动后再改 `process.env.USERPROFILE` 是无效的** ——
// `os.homedir()` 返回的是启动时的值。
// 而 esbuild 的 `define` 只接受标识符或字面量，不能 define 成 `homedir()` 这样的调用。
// 所以用 `onResolve` 插件把 `node:os` 换成一个只返回测试目录的桩模块。

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// guiFixture 是两账户 + 一格空字段的典型形态。
const guiFixture = `{
  "version": 2,
  "activeId": "acc_a1b2c3d4",
  "profiles": [
    {
      "id": "acc_a1b2c3d4",
      "name": "主账号",
      "cfToken": "cfat_TESTTOKEN_AAAA",
      "accountId": "70ec011b12cd621609a8412a4d0c1668",
      "accountName": "user@example.com",
      "kvNamespaceId": "22507775fc174257a7b840ea3e81dbf3",
      "panelPassword": "pw123",
      "createdAt": "2026-10-20T10:00:00.000Z",
      "updatedAt": "2026-10-25T08:30:00.000Z"
    },
    {
      "id": "acc_e5f6a7b8",
      "name": "备用账号",
      "cfToken": "cfat_TESTTOKEN_BBBB",
      "accountId": "aaaa1111bbbb2222cccc3333dddd4444",
      "accountName": "",
      "kvNamespaceId": "99998888777766665555444433332222",
      "panelPassword": "",
      "createdAt": "2026-10-22T12:00:00.000Z",
      "updatedAt": "2026-10-22T12:00:00.000Z"
    }
  ]
}`

// readViaNode 用 Electron 版的真实实现读取 dir 下的 secrets.json。
//
// 返回 activeId 与 profiles 的视图（不含 Token 明文，只看 hasToken）。
func readViaNode(t *testing.T, dir string) (activeID string, views []ProfileView) {
	t.Helper()

	root := repoRoot(t)
	cfgStore := filepath.Join(root, "packages", "gui", "src", "main", "config-store.ts")
	esbuildMain := filepath.Join(root, "node_modules", "esbuild", "lib", "main.js")
	for _, p := range []string{cfgStore, esbuildMain} {
		if _, err := os.Stat(p); err != nil {
			t.Skipf("缺少依赖文件：%s", p)
		}
	}

	// node 侧脚本：
	//   1. 用 esbuild 把 config-store.ts 转成 CJS
	//   2. 编译期把 `homedir()` 调用替换成注入的全局变量 __CFPILOT_TEST_HOME__
	//      （esbuild 的 define 只支持标识符/字面量，不支持函数调用，
	//       所以不能直接 define 成 `homedir()`）
	//   3. require 转译产物，读出 profile 列表
	script := `
const path = require('path');
const fs = require('fs');
const os = require('os');

async function main() {
  const testDir = process.argv[2];
  const esbuild = require(process.argv[3]);
  const entry = process.argv[4];

  const outfile = path.join(os.tmpdir(), 'cfpilot-cfg-' + process.pid + '.cjs');

  // 用一个「假的 node:os」插件把 homedir() 指到测试目录。
  // 这是最可靠的做法：不用改 env（Windows 上无效），也不用 define 函数调用。
  // 注意：esbuild 的插件只支持异步 API，不能用 buildSync。
  const stubOsPlugin = {
    name: 'stub-os',
    setup(build) {
      build.onResolve({ filter: /^node:os$/ }, () => ({ path: 'stub-os', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export function homedir() { return ' + JSON.stringify(testDir) + '; }',
        loader: 'js',
      }));
    },
  };

  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent',
    plugins: [stubOsPlugin],
  });

  const mod = require(outfile);
  const profiles = mod.listProfiles();
  const views = profiles.map((p) => ({
    id: p.id,
    name: p.name,
    accountId: p.accountId,
    accountName: p.accountName,
    kvNamespaceId: p.kvNamespaceId,
    hasToken: Boolean(p.cfToken && p.cfToken.trim()),
    hasPanelPw: Boolean(p.panelPassword),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
  process.stdout.write(JSON.stringify({ activeId: mod.activeProfileId(), views }));
  fs.unlinkSync(outfile);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
`

	scriptPath := filepath.Join(t.TempDir(), "node-read.cjs")
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("node", scriptPath, dir, esbuildMain, cfgStore)
	cmd.Dir = root
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node 端读取失败：%v\n输出：%s", err, out)
	}

	var res struct {
		ActiveID string        `json:"activeId"`
		Views    []ProfileView `json:"views"`
	}
	if err := json.Unmarshal(out, &res); err != nil {
		t.Fatalf("解析 node 输出失败：%v\n原始输出：%s", err, out)
	}
	return res.ActiveID, res.Views
}

// 同一份文件，Go 版与 Node 版必须读出一模一样的结果。
func TestCompatibilityWithNodeImplementation(t *testing.T) {
	if !hasNode(t) {
		t.Skip("node 不可用")
	}

	dir := t.TempDir()
	// Node 版会创建 .cfpilot-gui 子目录（configDir 是 homedir + 该目录）
	cfgDir := filepath.Join(dir, ".cfpilot-gui")
	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfgDir, "secrets.json"), []byte(guiFixture), 0o600); err != nil {
		t.Fatal(err)
	}

	// ---- Go 版读取 ----
	gs := New(cfgDir)
	goProfiles, err := gs.List()
	if err != nil {
		t.Fatal(err)
	}
	goActive, err := gs.ActiveID()
	if err != nil {
		t.Fatal(err)
	}
	goViews, err := gs.ListViews()
	if err != nil {
		t.Fatal(err)
	}

	if len(goProfiles) != 2 {
		t.Fatalf("Go 版应读出 2 条，实际 %d", len(goProfiles))
	}

	// ---- Node 版读取 ----
	nodeActive, nodeViews := readViaNode(t, dir)

	// ---- 比对 ----
	if goActive != nodeActive {
		t.Errorf("activeId 不一致：go=%q node=%q", goActive, nodeActive)
	}
	if len(goViews) != len(nodeViews) {
		t.Fatalf("profile 数量不一致：go=%d node=%d", len(goViews), len(nodeViews))
	}
	for i := range goViews {
		g, n := goViews[i], nodeViews[i]
		where := "[" + g.ID + "]"
		if g.ID != n.ID {
			t.Errorf("%s id: go=%q node=%q", where, g.ID, n.ID)
		}
		if g.Name != n.Name {
			t.Errorf("%s name: go=%q node=%q", where, g.Name, n.Name)
		}
		if g.AccountID != n.AccountID {
			t.Errorf("%s accountId: go=%q node=%q", where, g.AccountID, n.AccountID)
		}
		if g.AccountName != n.AccountName {
			t.Errorf("%s accountName: go=%q node=%q", where, g.AccountName, n.AccountName)
		}
		if g.KVNamespaceID != n.KVNamespaceID {
			t.Errorf("%s kvNamespaceId: go=%q node=%q", where, g.KVNamespaceID, n.KVNamespaceID)
		}
		if g.HasToken != n.HasToken {
			t.Errorf("%s hasToken: go=%v node=%v", where, g.HasToken, n.HasToken)
		}
		if g.HasPanelPw != n.HasPanelPw {
			t.Errorf("%s hasPanelPw: go=%v node=%v", where, g.HasPanelPw, n.HasPanelPw)
		}
	}
}

// 反向兼容：Go 版写出的文件，Node 版必须能完整读回。
func TestGoWritesNodeReadable(t *testing.T) {
	if !hasNode(t) {
		t.Skip("node 不可用")
	}

	dir := t.TempDir()
	cfgDir := filepath.Join(dir, ".cfpilot-gui")
	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		t.Fatal(err)
	}

	// Go 版写入
	gs := New(cfgDir)
	created, err := gs.Create("Go 写入的账户", &Profile{
		CfToken:       "cfat_FROM_GO",
		AccountID:     "goaccount123",
		AccountName:   "go@example.com",
		KVNamespaceID: "gokv",
		PanelPassword: "gopw",
	})
	if err != nil {
		t.Fatal(err)
	}

	// Node 版读回
	nodeActive, nodeViews := readViaNode(t, dir)

	if nodeActive != created.ID {
		t.Errorf("node 读到的 activeId=%q，Go 写入的是 %q", nodeActive, created.ID)
	}
	if len(nodeViews) != 1 {
		t.Fatalf("node 应读到 1 条，实际 %d", len(nodeViews))
	}
	n := nodeViews[0]
	if n.Name != "Go 写入的账户" {
		t.Errorf("name: node=%q", n.Name)
	}
	if n.AccountID != "goaccount123" {
		t.Errorf("accountId: node=%q", n.AccountID)
	}
	if n.AccountName != "go@example.com" {
		t.Errorf("accountName: node=%q", n.AccountName)
	}
	if n.KVNamespaceID != "gokv" {
		t.Errorf("kvNamespaceId: node=%q", n.KVNamespaceID)
	}
	if !n.HasToken {
		t.Error("node 应看到 hasToken=true")
	}
	if !n.HasPanelPw {
		t.Error("node 应看到 hasPanelPw=true")
	}
}

// hasNode 检查 node 是否可用。
func hasNode(t *testing.T) bool {
	t.Helper()
	if runtime.GOOS == "windows" {
		if _, err := exec.LookPath("node.exe"); err == nil {
			return true
		}
	}
	_, err := exec.LookPath("node")
	return err == nil
}

// repoRoot 从测试文件位置向上找含 package.json 的目录。
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "package.json")); err == nil {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	t.Skip("找不到仓库根目录（没有 package.json）")
	return ""
}
