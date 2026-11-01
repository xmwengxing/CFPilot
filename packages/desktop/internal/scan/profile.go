package scan

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const ProfileSchemaVersion = 1
const maxProfileFileSize = 16 << 20
const DefaultProfileHalfLife = 7 * 24 * time.Hour

// NetworkProfile 将不同运营商、地区与接入方式的测量隔离；不保存公网 IP 或凭据。
type NetworkProfile struct {
	ID         string  `json:"id"`
	ISP        string  `json:"isp"`
	Region     string  `json:"region"`
	Access     string  `json:"access"`
	Family     string  `json:"family"`
	Source     string  `json:"source"`
	Confidence float64 `json:"confidence"`
	// LastUsedAt 是这个档案最近一次被优选使用的时间。
	//
	// 用途：换网络环境后如果忘了改档案，历史结论会误导采样；
	// 界面据此提示「该档案已很久没用，可能已换网络」。
	LastUsedAt time.Time `json:"lastUsedAt,omitempty"`
}

// NormalizeRegion 归一化地区名。
//
// ## 为什么必须归一化
//
// 档案 ID 由「运营商 + 地区 + 接入方式 + 地址族」哈希得到。
// 如果地区是自由文本，`福建` / ` 福建` / `福建省` / `闽` 会算出**四个不同档案**，
// 历史样本被切碎，学习效果几乎为零。
//
// ## 规则（必须与 CLI 的实现逐字节一致）
//
// 1. 去掉首尾空白（含全角空格）与内部空白；
// 2. 去掉结尾的行政区后缀（特别行政区 / 自治区 / 省 / 市）；
// 3. 单字简称映射成标准名（闽 → 福建）。
//
// ⚠️ 任何改动都要同步 packages/cli/src/scan/network-profile.ts 的 normalizeRegion，
// 否则两端的档案 ID 会分叉。
func NormalizeRegion(raw string) string {
	text := strings.TrimSpace(raw)
	// 全角空格也要去掉
	text = strings.ReplaceAll(text, "\u3000", "")
	text = strings.ReplaceAll(text, " ", "")
	text = strings.ReplaceAll(text, "\t", "")
	if text == "" {
		return ""
	}
	for _, suffix := range []string{"特别行政区", "自治区", "省", "市"} {
		if len(text) > len(suffix) && strings.HasSuffix(text, suffix) {
			text = strings.TrimSuffix(text, suffix)
			break
		}
	}
	if alias, ok := regionAliases[text]; ok {
		text = alias
	}
	return text
}

// regionAliases 是单字简称 → 标准地区名。
var regionAliases = map[string]string{
	"闽": "福建", "粤": "广东", "京": "北京", "沪": "上海", "津": "天津", "渝": "重庆",
	"浙": "浙江", "苏": "江苏", "鲁": "山东", "豫": "河南", "冀": "河北", "湘": "湖南",
	"鄂": "湖北", "皖": "安徽", "赣": "江西", "桂": "广西", "云": "云南", "贵": "贵州",
	"川": "四川", "晋": "山西", "陕": "陕西", "甘": "甘肃", "青": "青海", "宁": "宁夏",
	"新": "新疆", "藏": "西藏", "蒙": "内蒙古", "港": "香港", "澳": "澳门", "台": "台湾",
}

// NewNetworkProfile 对稳定的网络维度生成 ID，避免识别来源变化导致档案分裂。
func NewNetworkProfile(p NetworkProfile) NetworkProfile {
	p.ISP = strings.TrimSpace(p.ISP)
	p.Region = NormalizeRegion(p.Region)
	p.Access = strings.ToLower(strings.TrimSpace(p.Access))
	p.Family = strings.ToLower(strings.TrimSpace(p.Family))
	if p.Family == "" {
		p.Family = "ipv4"
	}
	if math.IsNaN(p.Confidence) || math.IsInf(p.Confidence, 0) {
		p.Confidence = 0
	}
	p.Confidence = math.Max(0, math.Min(1, p.Confidence))
	key, _ := json.Marshal([]string{strings.ToLower(p.ISP), strings.ToLower(p.Region), p.Access, p.Family})
	sum := sha256.Sum256(key)
	p.ID = hex.EncodeToString(sum[:16])
	return p
}

// PrefixObservation 对照 CLI 的阶段计数模型；未执行阶段没有分母，也不记失败。
type PrefixObservation struct {
	ProfileID string             `json:"profileId"`
	Prefix    string             `json:"prefix"`
	Stage     string             `json:"stage"`
	Attempts  float64            `json:"attempts"`
	Successes float64            `json:"successes"`
	Failures  map[string]float64 `json:"failures"`
	LatencyMs float64            `json:"latencyMs,omitempty"`
	SpeedMBps float64            `json:"speedMBps,omitempty"`
	UpdatedAt time.Time          `json:"updatedAt"`
	// 旧聚合结构只用于调用方过渡，序列化不再输出这些字段。
	SampleCount   int       `json:"-"`
	TCPAttempts   int       `json:"-"`
	TLSAttempts   int       `json:"-"`
	WSAttempts    int       `json:"-"`
	TCPSuccess    int       `json:"-"`
	TLSSuccess    int       `json:"-"`
	WSSuccess     int       `json:"-"`
	MedianLatency float64   `json:"-"`
	MedianSpeed   float64   `json:"-"`
	LastTestAt    time.Time `json:"-"`
}

func validStage(stage string) bool {
	return stage == "tcp" || stage == "tls" || stage == "ws" || stage == "speed"
}
func validFailure(kind string) bool {
	switch kind {
	case "timeout", "refused", "unreachable", "reset", "tls", "alpn", "dns", "http", "content", "cancelled", "unknown":
		return true
	}
	return false
}
func finiteNonnegative(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 }
func validObservation(o PrefixObservation) bool {
	_, n, err := net.ParseCIDR(o.Prefix)
	if err != nil || n.IP.To4() == nil || IPv4Prefix24(n.IP.String()) != o.Prefix || !validStage(o.Stage) || o.ProfileID == "" || o.UpdatedAt.IsZero() || o.UpdatedAt.After(time.Now()) || !finiteNonnegative(o.Attempts) || !finiteNonnegative(o.Successes) || o.Successes > o.Attempts || !finiteNonnegative(o.LatencyMs) || !finiteNonnegative(o.SpeedMBps) {
		return false
	}
	failures := 0.0
	for kind, count := range o.Failures {
		if !validFailure(kind) || kind == "cancelled" && count != 0 || !finiteNonnegative(count) {
			return false
		}
		failures += count
	}
	return failures <= o.Attempts-o.Successes+1e-9
}

// IPv4Prefix24 只接受 IPv4 字面量；IPv6 与域名不混入 IPv4 统计桶。
func IPv4Prefix24(ip string) string {
	v := net.ParseIP(strings.TrimSpace(ip)).To4()
	if v == nil {
		return ""
	}
	return fmt.Sprintf("%d.%d.%d.0/24", v[0], v[1], v[2])
}

type ProfileStore struct {
	mu           sync.Mutex
	Version      int                          `json:"version"`
	Profiles     map[string]NetworkProfile    `json:"profiles"`
	Observations map[string]PrefixObservation `json:"observations"`
}

func NewProfileStore() *ProfileStore {
	return &ProfileStore{Version: ProfileSchemaVersion, Profiles: make(map[string]NetworkProfile), Observations: make(map[string]PrefixObservation)}
}
func observationKey(profileID, prefix string) string { return profileID + "|" + prefix }
func stageObservationKey(profileID, prefix, stage string) string {
	return observationKey(profileID, prefix) + "|" + stage
}

// StageObservationKey 返回「档案 + 前缀 + 阶段」的统计键。
func StageObservationKey(profileID, prefix, stage string) string {
	return stageObservationKey(profileID, prefix, stage)
}

// ObservationByKey 按统计键取一条观测。
func (s *ProfileStore) ObservationByKey(key string) (PrefixObservation, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.Observations[key]
	return o, ok
}

// MergeObservation 写入一条观测（已存在时按 UpdatedAt 取较新的一条）。
func (s *ProfileStore) MergeObservation(o PrefixObservation) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Observations == nil {
		s.Observations = make(map[string]PrefixObservation)
	}
	key := stageObservationKey(o.ProfileID, o.Prefix, o.Stage)
	if old, ok := s.Observations[key]; ok && !o.UpdatedAt.After(old.UpdatedAt) {
		return
	}
	s.Observations[key] = o
}

// TouchProfile 记录档案最近一次被使用的时间。
func (s *ProfileStore) TouchProfile(profileID string, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.Profiles[profileID]
	if !ok {
		return
	}
	if at.IsZero() {
		at = time.Now().UTC()
	}
	if at.After(p.LastUsedAt) {
		p.LastUsedAt = at
		s.Profiles[profileID] = p
	}
}

func (s *ProfileStore) PutProfile(p NetworkProfile) NetworkProfile {
	p = NewNetworkProfile(p)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Profiles == nil {
		s.Profiles = make(map[string]NetworkProfile)
	}
	s.Profiles[p.ID] = p
	return p
}

// RecordProbe 每个阶段最终结果只记录一次；取消不属于失败样本。
func (s *ProfileStore) RecordProbe(profileID, ip, stage string, ok bool, at time.Time) bool {
	failure := ""
	if !ok {
		failure = "unknown"
	}
	return s.RecordProbeResult(profileID, ip, stage, ok, failure, 0, 0, at)
}
func (s *ProfileStore) RecordProbeResult(profileID, ip, stage string, ok bool, failure string, latencyMs, speedMBps float64, at time.Time) bool {
	prefix := IPv4Prefix24(ip)
	if prefix == "" || profileID == "" || !validStage(stage) || failure == "cancelled" || failure != "" && !validFailure(failure) || !finiteNonnegative(latencyMs) || !finiteNonnegative(speedMBps) {
		return false
	}
	if at.IsZero() {
		at = time.Now().UTC()
	}
	if at.After(time.Now()) {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Observations == nil {
		s.Observations = make(map[string]PrefixObservation)
	}
	key := stageObservationKey(profileID, prefix, stage)
	o := s.Observations[key]
	if !o.UpdatedAt.IsZero() && at.Before(o.UpdatedAt) {
		return false
	}
	if o.Failures == nil {
		o.Failures = make(map[string]float64)
	}
	if !o.UpdatedAt.IsZero() {
		decay := math.Exp2(-at.Sub(o.UpdatedAt).Seconds() / DefaultProfileHalfLife.Seconds())
		o.Attempts *= decay
		o.Successes *= decay
		for kind, count := range o.Failures {
			o.Failures[kind] = count * decay
		}
	}
	o.ProfileID, o.Prefix, o.Stage, o.UpdatedAt = profileID, prefix, stage, at.UTC()
	o.Attempts++
	if ok {
		o.Successes++
		if latencyMs > 0 {
			if o.LatencyMs == 0 {
				o.LatencyMs = latencyMs
			} else {
				o.LatencyMs = o.LatencyMs*0.7 + latencyMs*0.3
			}
		}
		if speedMBps > 0 {
			if o.SpeedMBps == 0 {
				o.SpeedMBps = speedMBps
			} else {
				o.SpeedMBps = o.SpeedMBps*0.7 + speedMBps*0.3
			}
		}
	} else {
		if failure == "" {
			failure = "unknown"
		}
		o.Failures[failure]++
	}
	s.Observations[key] = o
	return true
}

func (s *ProfileStore) ForProfile(profileID string) []PrefixObservation {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]PrefixObservation, 0)
	for _, o := range s.Observations {
		if o.ProfileID == profileID {
			failures := make(map[string]float64, len(o.Failures))
			for k, v := range o.Failures {
				failures[k] = v
			}
			o.Failures = failures
			out = append(out, o)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return stageObservationKey(out[i].ProfileID, out[i].Prefix, out[i].Stage) < stageObservationKey(out[j].ProfileID, out[j].Prefix, out[j].Stage)
	})
	return out
}

// AllObservations 返回全部档案的观测（档案管理界面要用）。
func (s *ProfileStore) AllObservations() []PrefixObservation {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]PrefixObservation, 0, len(s.Observations))
	for _, o := range s.Observations {
		failures := make(map[string]float64, len(o.Failures))
		for k, v := range o.Failures {
			failures[k] = v
		}
		o.Failures = failures
		out = append(out, o)
	}
	sort.Slice(out, func(i, j int) bool {
		return stageObservationKey(out[i].ProfileID, out[i].Prefix, out[i].Stage) < stageObservationKey(out[j].ProfileID, out[j].Prefix, out[j].Stage)
	})
	return out
}

// RenameProfile 把档案改成新维度，并把它的观测迁移到新 ID。
//
// 维度变了 → ID 必然变；观测不迁移就会丢样本。
func (s *ProfileStore) RenameProfile(oldID string, next NetworkProfile) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Profiles == nil {
		s.Profiles = make(map[string]NetworkProfile)
	}
	if s.Observations == nil {
		s.Observations = make(map[string]PrefixObservation)
	}
	delete(s.Profiles, oldID)
	s.Profiles[next.ID] = next
	for key, o := range s.Observations {
		if o.ProfileID != oldID {
			continue
		}
		delete(s.Observations, key)
		o.ProfileID = next.ID
		s.Observations[stageObservationKey(next.ID, o.Prefix, o.Stage)] = o
	}
}

// DeleteProfile 删除档案及其全部观测。
func (s *ProfileStore) DeleteProfile(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.Profiles, id)
	for key, o := range s.Observations {
		if o.ProfileID == id {
			delete(s.Observations, key)
		}
	}
}

func (s *ProfileStore) validate() error {
	if s.Version != ProfileSchemaVersion {
		return fmt.Errorf("档案版本不兼容：%d", s.Version)
	}
	for key, p := range s.Profiles {
		if key != p.ID || NewNetworkProfile(p).ID != key || !finiteNonnegative(p.Confidence) || p.Confidence > 1 {
			return fmt.Errorf("网络档案无效：%s", key)
		}
	}
	for key, o := range s.Observations {
		if key != stageObservationKey(o.ProfileID, o.Prefix, o.Stage) || !validObservation(o) {
			return fmt.Errorf("阶段统计无效：%s", key)
		}
	}
	return nil
}

// Save 原子替换本地文件，校验失败时保留原文件。
func (s *ProfileStore) Save(path string) error {
	s.mu.Lock()
	err := s.validate()
	var data []byte
	if err == nil {
		data, err = json.MarshalIndent(s, "", "  ")
	}
	s.mu.Unlock()
	if err != nil {
		return err
	}
	if len(data) > maxProfileFileSize {
		return fmt.Errorf("档案文件超过容量限制")
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".scan-profile-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, path)
}

// LoadProfileStore 接受版本化阶段档案，并显式迁移无版本的聚合档案。
func LoadProfileStore(path string) (*ProfileStore, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return NewProfileStore(), nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxProfileFileSize+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxProfileFileSize {
		return nil, fmt.Errorf("档案文件超过容量限制")
	}
	var raw struct {
		Version      *int                       `json:"version"`
		Profiles     map[string]NetworkProfile  `json:"profiles"`
		Observations map[string]json.RawMessage `json:"observations"`
	}
	if err = json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	if raw.Profiles == nil || raw.Observations == nil {
		return nil, fmt.Errorf("档案结构无效")
	}
	s := NewProfileStore()
	s.Profiles = raw.Profiles
	if raw.Version != nil && *raw.Version != ProfileSchemaVersion {
		return nil, fmt.Errorf("档案版本不兼容：%d", *raw.Version)
	}
	for key, value := range raw.Observations {
		if raw.Version != nil {
			var o PrefixObservation
			if err = json.Unmarshal(value, &o); err != nil {
				return nil, err
			}
			s.Observations[key] = o
			continue
		}
		var old struct {
			ProfileID     string    `json:"profileId"`
			Prefix        string    `json:"prefix"`
			SampleCount   int       `json:"sampleCount"`
			TCPAttempts   int       `json:"tcpAttempts"`
			TLSAttempts   int       `json:"tlsAttempts"`
			WSAttempts    int       `json:"wsAttempts"`
			TCPSuccess    int       `json:"tcpSuccess"`
			TLSSuccess    int       `json:"tlsSuccess"`
			WSSuccess     int       `json:"wsSuccess"`
			MedianLatency float64   `json:"medianLatency"`
			MedianSpeed   float64   `json:"medianSpeed"`
			LastTestAt    time.Time `json:"lastTestAt"`
		}
		if err = json.Unmarshal(value, &old); err != nil {
			return nil, err
		}
		if key != observationKey(old.ProfileID, old.Prefix) || old.SampleCount < 0 || old.TCPAttempts < 0 || old.TLSAttempts < 0 || old.WSAttempts < 0 {
			return nil, fmt.Errorf("旧统计无效：%s", key)
		}
		for _, v := range []struct {
			stage               string
			attempts, successes int
		}{{"tcp", old.TCPAttempts, old.TCPSuccess}, {"tls", old.TLSAttempts, old.TLSSuccess}, {"ws", old.WSAttempts, old.WSSuccess}} {
			if v.successes < 0 || v.successes > v.attempts {
				return nil, fmt.Errorf("旧阶段统计无效：%s", key)
			}
			if v.attempts == 0 {
				continue
			}
			o := PrefixObservation{ProfileID: old.ProfileID, Prefix: old.Prefix, Stage: v.stage, Attempts: float64(v.attempts), Successes: float64(v.successes), Failures: map[string]float64{}, UpdatedAt: old.LastTestAt}
			if v.attempts > v.successes {
				o.Failures["unknown"] = float64(v.attempts - v.successes)
			}
			s.Observations[stageObservationKey(o.ProfileID, o.Prefix, o.Stage)] = o
		}
	}
	if err = s.validate(); err != nil {
		return nil, err
	}
	return s, nil
}
