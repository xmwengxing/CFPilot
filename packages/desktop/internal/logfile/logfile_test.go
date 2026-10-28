package logfile

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriterRotatesWhenOverLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cfpilot.log")

	// 上限 1KB，备份 2 个
	w, err := New(path, 1024, 2)
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	defer func() { _ = w.Close() }()

	for i := 0; i < 200; i++ {
		if _, err := fmt.Fprintf(w, "第 %d 行日志内容，用来把文件撑大以便触发滚动\n", i); err != nil {
			t.Fatalf("写入失败：%v", err)
		}
	}

	// 主文件不应该超过上限太多（写完立即滚动）
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("主文件不存在：%v", err)
	}
	if st.Size() > 2048 {
		t.Errorf("主文件 %d 字节，超过上限太多（应已滚动）", st.Size())
	}

	// 备份文件应该存在
	for _, name := range RotatedFiles(path, 2) {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("备份文件 %s 不存在", name)
		}
	}
}

func TestWriterKeepsBackupCountBounded(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cfpilot.log")

	w, err := New(path, 512, 1)
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	defer func() { _ = w.Close() }()

	for i := 0; i < 300; i++ {
		_, _ = fmt.Fprintf(w, "填充日志 %d\n", i)
	}

	// 备份最多 MaxBackups 个（外加多一个被清掉的）
	files := RotatedFiles(path, 1)
	if len(files) > 2 {
		t.Errorf("备份文件过多：%d 个（%v）", len(files), files)
	}
}

func TestWriterAppendsToExisting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cfpilot.log")

	if err := os.WriteFile(path, []byte("已有的一行\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	w, err := New(path, 1<<20, 2)
	if err != nil {
		t.Fatalf("创建失败：%v", err)
	}
	_, _ = fmt.Fprintln(w, "追加的一行")
	_ = w.Close()

	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "已有的一行") {
		t.Error("原有内容丢了")
	}
	if !strings.Contains(string(data), "追加的一行") {
		t.Error("新内容没写进去")
	}
}

func TestTail(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cfpilot.log")

	content := ""
	for i := 1; i <= 100; i++ {
		content += fmt.Sprintf("第 %d 行\n", i)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	lines, total, err := Tail(path, 10)
	if err != nil {
		t.Fatalf("读取失败：%v", err)
	}
	if total != 100 {
		t.Errorf("总行数应为 100，实际 %d", total)
	}
	if len(lines) != 10 {
		t.Errorf("应返回 10 行，实际 %d", len(lines))
	}
	if !strings.Contains(lines[len(lines)-1], "第 100 行") {
		t.Errorf("最后一行应是第 100 行，实际 %q", lines[len(lines)-1])
	}

	// 请求的行数大于总数 → 返回全部
	lines, total, err = Tail(path, 500)
	if err != nil {
		t.Fatalf("读取失败：%v", err)
	}
	if total != 100 || len(lines) != 100 {
		t.Errorf("应返回全部 100 行，实际 %d / %d", total, len(lines))
	}
}

func TestTailMissingFile(t *testing.T) {
	dir := t.TempDir()
	lines, total, err := Tail(filepath.Join(dir, "nope.log"), 10)
	if err != nil {
		t.Fatalf("文件不存在不应报错：%v", err)
	}
	if len(lines) != 0 || total != 0 {
		t.Errorf("应返回空，实际 %d 行 / %d", len(lines), total)
	}
}

func TestHumanSize(t *testing.T) {
	cases := map[int64]string{
		0:       "0 B",
		512:     "512 B",
		1024:    "1.0 KB",
		1536:    "1.5 KB",
		1 << 20: "1.0 MB",
	}
	for n, want := range cases {
		if got := HumanSize(n); got != want {
			t.Errorf("HumanSize(%d) = %q，期望 %q", n, got, want)
		}
	}
}
