package schedule

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// 本地持久化。
//
// ## 落盘位置
//
// ~/.cfpilot-gui/scheduled-tasks.json      任务清单
// ~/.cfpilot-gui/scheduled-ip-pool.json    定时优选跑出来的 IP 池
//
// 与 scan-history.json / scan-profiles.json 同级（桌面版自己的目录），
// 而**不是** ~/.cfpilot（那是 CLI 与桌面版共用的目录）——
// 定时任务是桌面版独有的特性，不该污染跨版本共用的文件。
//
// ## 格式与写法
//
// 版本化 envelope + 原子写（临时文件 + rename），与 internal/history 同款：
// 读到的永远是完整 JSON，不会是写了一半的半截文件。

const (
	// TasksFilename 是任务清单文件名。
	TasksFilename = "scheduled-tasks.json"
	// PoolFilename 是 IP 池文件名。
	PoolFilename = "scheduled-ip-pool.json"
	// Schema 是当前文件格式版本。
	Schema = 1
)

// taskFile 是任务清单的磁盘结构。
type taskFile struct {
	Schema    int    `json:"schema"`
	UpdatedAt int64  `json:"updatedAt"`
	Tasks     []Task `json:"tasks"`
}

// poolFile 是 IP 池的磁盘结构。
type poolFile struct {
	Schema    int         `json:"schema"`
	UpdatedAt int64       `json:"updatedAt"`
	Entries   []PoolEntry `json:"entries"`
}

// Store 是任务与 IP 池的本地存储。
//
// 内存缓存 + 变更即落盘：调度器每分钟读一次，读的是内存副本，
// 不会每次 tick 都去碰磁盘。
type Store struct {
	mu    sync.Mutex
	dir   string
	tasks []Task
	pool  []PoolEntry
	// dirty 标记内存副本是否已从磁盘载入。
	tasksLoaded bool
	poolLoaded  bool
}

// New 创建存储。dir 为空时用默认目录（~/.cfpilot-gui）。
func New(dir string) *Store {
	if dir == "" {
		dir = DefaultDir()
	}
	return &Store{dir: dir}
}

// DefaultDir 返回桌面版的本地数据目录（~/.cfpilot-gui）。
func DefaultDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".cfpilot-gui"
	}
	return filepath.Join(home, ".cfpilot-gui")
}

// Dir 返回存储目录。
func (s *Store) Dir() string { return s.dir }

// TasksPath 返回任务清单的完整路径。
func (s *Store) TasksPath() string { return filepath.Join(s.dir, TasksFilename) }

// PoolPath 返回 IP 池的完整路径。
func (s *Store) PoolPath() string { return filepath.Join(s.dir, PoolFilename) }

// Tasks 读取全部任务（返回副本，调用方改动不影响内部状态）。
func (s *Store) Tasks() []Task {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadTasksLocked()
	out := make([]Task, len(s.tasks))
	copy(out, s.tasks)
	return out
}

// SaveTasks 覆盖写入任务清单。
func (s *Store) SaveTasks(tasks []Task) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tasks = make([]Task, len(tasks))
	copy(s.tasks, tasks)
	s.tasksLoaded = true
	return s.writeJSON(s.TasksPath(), taskFile{
		Schema:    Schema,
		UpdatedAt: nowMS(),
		Tasks:     s.tasks,
	})
}

// UpdateTasks 在锁内读-改-写，避免并发写互相覆盖。
//
// fn 返回新任务列表；返回 nil 表示放弃本次修改。
func (s *Store) UpdateTasks(fn func(tasks []Task) []Task) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadTasksLocked()
	next := fn(s.tasks)
	if next == nil {
		return nil
	}
	s.tasks = make([]Task, len(next))
	copy(s.tasks, next)
	s.tasksLoaded = true
	return s.writeJSON(s.TasksPath(), taskFile{
		Schema:    Schema,
		UpdatedAt: nowMS(),
		Tasks:     s.tasks,
	})
}

// Pool 读取 IP 池（返回副本）。
func (s *Store) Pool() []PoolEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadPoolLocked()
	out := make([]PoolEntry, len(s.pool))
	copy(out, s.pool)
	return out
}

// SavePool 覆盖写入 IP 池。
func (s *Store) SavePool(entries []PoolEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pool = make([]PoolEntry, len(entries))
	copy(s.pool, entries)
	s.poolLoaded = true
	return s.writeJSON(s.PoolPath(), poolFile{
		Schema:    Schema,
		UpdatedAt: nowMS(),
		Entries:   s.pool,
	})
}

// UpdatePool 在锁内读-改-写 IP 池，避免并发写互相覆盖。
//
// fn 返回新池；返回 nil 表示放弃本次修改。
// 返回值是落盘后的池内容（副本）。
func (s *Store) UpdatePool(fn func(entries []PoolEntry) []PoolEntry) []PoolEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadPoolLocked()
	next := fn(s.pool)
	if next == nil {
		out := make([]PoolEntry, len(s.pool))
		copy(out, s.pool)
		return out
	}
	s.pool = make([]PoolEntry, len(next))
	copy(s.pool, next)
	s.poolLoaded = true
	_ = s.writeJSON(s.PoolPath(), poolFile{
		Schema:    Schema,
		UpdatedAt: nowMS(),
		Entries:   s.pool,
	})
	out := make([]PoolEntry, len(s.pool))
	copy(out, s.pool)
	return out
}

// loadTasksLocked 载入任务清单（调用方持锁）。
func (s *Store) loadTasksLocked() {
	if s.tasksLoaded {
		return
	}
	s.tasksLoaded = true
	s.tasks = nil
	raw, err := os.ReadFile(s.TasksPath())
	if err != nil {
		return
	}
	var f taskFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return
	}
	if f.Schema != Schema {
		// 未知版本：不猜、不迁移，直接当空清单（用户会看到任务消失，
		// 但不会把错误的数据写回去覆盖掉原文件）。
		return
	}
	s.tasks = f.Tasks
}

// loadPoolLocked 载入 IP 池（调用方持锁）。
func (s *Store) loadPoolLocked() {
	if s.poolLoaded {
		return
	}
	s.poolLoaded = true
	s.pool = nil
	raw, err := os.ReadFile(s.PoolPath())
	if err != nil {
		return
	}
	var f poolFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return
	}
	if f.Schema != Schema {
		return
	}
	s.pool = f.Entries
}

// writeJSON 原子写：临时文件 + rename。
func (s *Store) writeJSON(path string, payload any) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Errorf("创建目录失败：%w", err)
	}
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("写入临时文件失败：%w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("替换文件失败：%w", err)
	}
	return nil
}
