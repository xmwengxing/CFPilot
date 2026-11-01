// Package history 实现「优选结果历史」的本地持久化。
//
// ## 为什么需要
//
// 桌面版每次优选出来的 IP 列表，用户希望能**留底**：
// 跨天对比哪批更快、挑几个 IP 二次确认「现在还活着吗」、把某次的结果
// 多选复制出来回填。这些都要把历史会话存到本机磁盘。
//
// ## 存哪
//
// 与凭据库同目录（~/.cfpilot-gui），文件名为 scan-history.json。
// 这不是敏感数据（只是 IP / 延迟 / 机房码），但和凭据放一起便于「整目录迁移」。
//
// ## 容量
//
// 默认只保留最近 30 次会话（oldest-first 裁剪），避免文件无限膨胀。
// 每次优选（本地真连接优选 / 一键优选）成功都会写入一条。
package history

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/scan"
)

const (
	// fileName 是历史文件名（与 credentials 同目录）。
	fileName = "scan-history.json"
	// DefaultCap 是默认保留的最近会话数。
	DefaultCap = 30
)

// Entry 是一条优选结果（与 scan.Entry 字段一致）。
type Entry struct {
	IP   string `json:"ip"`
	Port int    `json:"port"`
	Colo string `json:"colo"`
	// City 是机房城市中文名（如「新加坡」），只用于展示与复制备注。
	City    string  `json:"city,omitempty"`
	Latency int64   `json:"latency"`
	TLSMs   int64   `json:"tlsMs"`
	Speed   float64 `json:"speed"`
	// TCPMs 是优选时阶段一测得的 TCP 建连耗时（毫秒）。
	TCPMs int64 `json:"tcpMs,omitempty"`
	// PeakSpeed 是优选时测速的窗口峰值（MB/s），只作诊断展示。
	PeakSpeed float64 `json:"peakSpeed,omitempty"`
	// LastTest 是最近一次复测的状态（可为空，表示从未复测过）。
	LastTest      *LastTest      `json:"lastTest,omitempty"`
	Tests         []LastTest     `json:"tests,omitempty"`
	QualityReport *QualityReport `json:"qualityReport,omitempty"`
}

// LastTest 是某条 IP 的最近一次复测结论。
type LastTest struct {
	At    string  `json:"at"`    // ISO 时间
	TCPMs int64   `json:"tcpMs"` // 复测时的 TCP 延迟
	TLSMs int64   `json:"tlsMs"` // 复测时的 TLS 握手耗时
	WSOK  bool    `json:"wsOk"`  // 复测时 WS101 是否通过
	Colo  string  `json:"colo"`  // 复测时识别到的机房码（可能与当初不同）
	Speed float64 `json:"speed"` // 复测时的下行速度（仅复测带测速时有）
	// PeakSpeed 是复测测速的窗口峰值（MB/s）。
	PeakSpeed float64 `json:"peakSpeed,omitempty"`
	OK        bool    `json:"ok"` // 复测三层是否全过
	Error     string  `json:"error,omitempty"`
	WithSpeed bool    `json:"withSpeed,omitempty"`
}

// Session 是一次优选会话。
type Session struct {
	ID               string  `json:"id"`
	At               string  `json:"at"` // ISO 时间
	Host             string  `json:"host"`
	WSPath           string  `json:"wsPath"`
	ProbePath        string  `json:"probePath"`
	SkipSpeed        bool    `json:"skipSpeed"`
	Source           string  `json:"source"` // "local" | "quick"
	Entries          []Entry `json:"entries"`
	NetworkProfileID string  `json:"networkProfileId,omitempty"`
}

// FromScanEntries 把 scan.Entry 列表转成持久化用的 Entry 列表。
func FromScanEntries(in []scan.Entry) []Entry {
	out := make([]Entry, 0, len(in))
	for _, e := range in {
		out = append(out, Entry{
			IP:        e.IP,
			Port:      e.Port,
			Colo:      e.Colo,
			City:      scan.ColoNameOf(e.Colo),
			Latency:   e.Latency,
			TLSMs:     e.TLSMs,
			Speed:     e.Speed,
			TCPMs:     e.TCPMs,
			PeakSpeed: e.PeakSpeed,
		})
	}
	return out
}

// NewSessionID 返回一条历史会话的唯一标识。
// 调用方可在保存前生成，以便把会话 ID 同步给实时结果事件。
func NewSessionID() string { return newID() }

// Store 是历史库。持有目录与容量上限。
type Store struct {
	dir string
	cap int
}

// New 创建历史库。dir 为空时用 store 的默认目录。
func New(dir string, capN int) *Store {
	if dir == "" {
		dir = defaultDir()
	}
	if capN <= 0 {
		capN = DefaultCap
	}
	return &Store{dir: dir, cap: capN}
}

func defaultDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, ".cfpilot-gui")
	}
	return ".cfpilot-gui"
}

func (s *Store) path() string { return filepath.Join(s.dir, fileName) }

const SchemaVersion = 1
const maxHistoryBytes = 8 << 20
const maxRetestSamples = 30

var historyMu sync.Mutex

type document struct {
	Version  int       `json:"version"`
	Sessions []Session `json:"sessions"`
}

// Load 兼容旧数组；任何新写入都使用版本化 envelope。
func (s *Store) Load() ([]Session, error) {
	historyMu.Lock()
	defer historyMu.Unlock()
	return s.load()
}

func (s *Store) load() ([]Session, error) {
	file, err := os.Open(s.path())
	if os.IsNotExist(err) {
		return []Session{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxHistoryBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxHistoryBytes {
		return nil, fmt.Errorf("历史文件超过容量限制")
	}
	var list []Session
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return []Session{}, nil
	}
	if raw[0] == '[' {
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, fmt.Errorf("历史文件格式无效")
		}
	} else {
		var doc document
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("历史文件格式无效")
		}
		if doc.Version != SchemaVersion || doc.Sessions == nil {
			return nil, fmt.Errorf("历史文件版本或结构不兼容")
		}
		list = doc.Sessions
	}
	// 倒序：最新在前
	sort.SliceStable(list, func(i, j int) bool {
		return list[i].At > list[j].At
	})
	return list, nil
}

// Save 写入一条新会话：插到最前、按容量裁剪、原子落盘。
func (s *Store) Save(sess Session) error {
	historyMu.Lock()
	defer historyMu.Unlock()
	if sess.ID == "" {
		sess.ID = newID()
	}
	if sess.At == "" {
		sess.At = nowISO()
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	list, err := s.load()
	if err != nil {
		return err
	}
	list = append([]Session{sess}, list...)
	if len(list) > s.cap {
		list = list[:s.cap]
	}
	for i := range list[0].Entries {
		e := &list[0].Entries[i]
		e.QualityReport, _ = BuildQualityReport(list, list[0].ID, e.IP, e.Port, time.Now().UTC())
	}
	return s.write(list)
}

// Delete 删除指定 id 的会话。
func (s *Store) Delete(id string) error {
	historyMu.Lock()
	defer historyMu.Unlock()
	list, err := s.load()
	if err != nil {
		return err
	}
	kept := list[:0]
	for _, s2 := range list {
		if s2.ID != id {
			kept = append(kept, s2)
		}
	}
	if len(kept) == len(list) {
		return nil // 没有可删的，直接返回
	}
	return s.write(kept)
}

// UpdateEntryLastTest 把某会话里某个 IP:Port 的最近一次复测结论写回去。
//
// 多选项复测时，前端把每个 IP 的复测结果传回来，这里按 ip+port 定位条目更新。
// 找不到对应条目时忽略（不应发生，因为目标本就来自该会话）。
func (s *Store) UpdateEntryLastTest(id string, results []scan.IPTestResult) error {
	return s.UpdateEntryTests(id, results, false)
}

func (s *Store) UpdateEntryTests(id string, results []scan.IPTestResult, withSpeed bool) error {
	historyMu.Lock()
	defer historyMu.Unlock()
	list, err := s.load()
	if err != nil {
		return err
	}
	var target *Session
	for i := range list {
		if list[i].ID == id {
			target = &list[i]
			break
		}
	}
	if target == nil {
		return nil
	}
	// 建索引：ip:port → entry
	idx := map[string]*Entry{}
	for i := range target.Entries {
		key := target.Entries[i].IP + ":" + itoa(target.Entries[i].Port)
		idx[key] = &target.Entries[i]
	}
	at := nowISO()
	for _, r := range results {
		e, ok := idx[r.IP+":"+itoa(r.Port)]
		if !ok {
			continue
		}
		if len(e.Tests) == 0 && e.LastTest != nil {
			e.Tests = append(e.Tests, *e.LastTest)
		}
		e.LastTest = &LastTest{
			At:        at,
			TCPMs:     r.TCPMs,
			TLSMs:     r.TLSMs,
			WSOK:      r.WSOK,
			Colo:      r.Colo,
			Speed:     r.Speed,
			PeakSpeed: r.PeakSpeed,
			OK:        r.OK,
			Error:     r.Error,
			WithSpeed: withSpeed,
		}
		e.Tests = append(e.Tests, *e.LastTest)
		if len(e.Tests) > maxRetestSamples {
			e.Tests = e.Tests[len(e.Tests)-maxRetestSamples:]
		}
		e.QualityReport, _ = BuildQualityReport(list, id, e.IP, e.Port, time.Now().UTC())
	}
	return s.write(list)
}

func (s *Store) write(list []Session) error {
	if list == nil {
		list = []Session{}
	}
	raw, err := json.MarshalIndent(document{Version: SchemaVersion, Sessions: list}, "", "  ")
	if err != nil {
		return err
	}
	if len(raw) > maxHistoryBytes {
		return fmt.Errorf("历史文件超过容量限制")
	}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(s.dir, ".scan-history-*")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(raw)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, s.path())
}

// ---------- 内部工具 ----------

func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	buf := [12]byte{}
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func newID() string {
	b := make([]byte, 2)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand 失败几乎不可能；退化成纳秒低 16 位保证不空
		return time.Now().UTC().Format("20060102T150405Z") + "-" + itoa(int(time.Now().UnixNano()&0xffff))
	}
	return time.Now().UTC().Format("20060102T150405Z") + "-" + hex.EncodeToString(b)
}
