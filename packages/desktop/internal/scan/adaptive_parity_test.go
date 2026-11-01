package scan

// 跨语言一致性校验（桌面版一侧）。
//
// 夹具 testdata/adaptive-parity.json 同时被 CLI 使用
// （packages/cli/test/adaptive-parity.test.ts）：
// 两端必须对同一份输入算出**同一组权重**，
// 否则同一个网络档案在两端会得出不同的网段权重，历史就失去意义。
//
// ⚠️ 改任何一端的算法前，先改夹具里的期望值，并让两端同时通过。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

type parityObservation struct {
	Prefix    string    `json:"prefix"`
	Stage     string    `json:"stage"`
	Attempts  float64   `json:"attempts"`
	Successes float64   `json:"successes"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type parityFixture struct {
	ProfileID       string              `json:"profileId"`
	Now             time.Time           `json:"now"`
	HalfLifeHours   float64             `json:"halfLifeHours"`
	Observations    []parityObservation `json:"observations"`
	Prefixes        []string            `json:"prefixes"`
	Contract        parityContract      `json:"contract"`
	ExpectedWeights map[string]float64  `json:"expectedWeights"`
}

// parityContract 是两端共用的采样策略口径。
type parityContract struct {
	SampleCount     int     `json:"sampleCount"`
	ExplorationRate float64 `json:"explorationRate"`
	MaxPrefixShare  float64 `json:"maxPrefixShare"`
	ExploreBudget   int     `json:"exploreBudget"`
	CapPerPrefix    int     `json:"capPerPrefix"`
}

// parityFixturePath 定位仓库根目录下的夹具。
func parityFixturePath(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位测试文件")
	}
	// packages/desktop/internal/scan → 仓库根
	root := filepath.Join(filepath.Dir(file), "..", "..", "..", "..")
	return filepath.Join(root, "testdata", "adaptive-parity.json")
}

func TestAdaptiveParityWithCLI(t *testing.T) {
	raw, err := os.ReadFile(parityFixturePath(t))
	if err != nil {
		t.Fatal(err)
	}
	var fixture parityFixture
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	options := AdaptiveSamplingOptions{
		HalfLife: time.Duration(fixture.HalfLifeHours * float64(time.Hour)),
		Now:      fixture.Now,
	}
	observations := make([]PrefixObservation, 0, len(fixture.Observations))
	for _, item := range fixture.Observations {
		observations = append(observations, PrefixObservation{
			ProfileID: fixture.ProfileID,
			Prefix:    item.Prefix,
			Stage:     item.Stage,
			Attempts:  item.Attempts,
			Successes: item.Successes,
			Failures:  map[string]float64{},
			UpdatedAt: item.UpdatedAt,
		})
	}
	for _, prefix := range fixture.Prefixes {
		got := LearnedPrefixWeight(prefix, observations, fixture.ProfileID, options)
		want, ok := fixture.ExpectedWeights[prefix]
		if !ok {
			t.Fatalf("夹具缺少 %s 的期望值", prefix)
		}
		if diff := got - want; diff > 1e-6 || diff < -1e-6 {
			t.Errorf("前缀 %s 的权重 %v 与夹具期望 %v 不一致", prefix, got, want)
		}
	}
}

// 两端的采样策略口径必须一致（探索配额 / 集中度上限）。
func TestAdaptiveParityPolicyWithCLI(t *testing.T) {
	raw, err := os.ReadFile(parityFixturePath(t))
	if err != nil {
		t.Fatal(err)
	}
	var fixture parityFixture
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if got := ExploreBudget(fixture.Contract.SampleCount, fixture.Contract.ExplorationRate); got != fixture.Contract.ExploreBudget {
		t.Errorf("探索配额 %d 与夹具期望 %d 不一致", got, fixture.Contract.ExploreBudget)
	}
	if got := PrefixCap(fixture.Contract.SampleCount, fixture.Contract.MaxPrefixShare); got != fixture.Contract.CapPerPrefix {
		t.Errorf("集中度上限 %d 与夹具期望 %d 不一致", got, fixture.Contract.CapPerPrefix)
	}
}
