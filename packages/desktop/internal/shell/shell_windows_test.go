//go:build windows

package shell

import "testing"

// TestMaximizedBounds 守护「最大化不遮挡任务栏」的坐标计算。
//
// 真机上一旦这里算错，用户看到的就是窗口盖住任务栏（或最大化后偏移到屏幕外）。
// 重点覆盖多显示器负坐标与任务栏在顶部两种边界。
func TestMaximizedBounds(t *testing.T) {
	cases := []struct {
		name       string
		monitor    winRect
		work       winRect
		wantPos    winPoint
		wantSize   winPoint
	}{
		{
			name:     "主屏 1920x1080，任务栏在底部 40px",
			monitor:  winRect{0, 0, 1920, 1080},
			work:     winRect{0, 0, 1920, 1040},
			wantPos:  winPoint{0, 0},
			wantSize: winPoint{1920, 1040},
		},
		{
			name:     "副屏在左侧（负坐标），任务栏在底部",
			monitor:  winRect{-1920, 0, 0, 1080},
			work:     winRect{-1920, 0, 0, 1040},
			wantPos:  winPoint{0, 0},
			wantSize: winPoint{1920, 1040},
		},
		{
			name:     "任务栏在顶部 40px",
			monitor:  winRect{0, 0, 1920, 1080},
			work:     winRect{0, 40, 1920, 1080},
			wantPos:  winPoint{0, 40},
			wantSize: winPoint{1920, 1040},
		},
		{
			name:     "任务栏在左侧（竖屏），副屏负坐标",
			monitor:  winRect{-1080, -200, 0, 1000},
			work:     winRect{-1040, -200, 0, 1000},
			wantPos:  winPoint{40, 0},
			wantSize: winPoint{1040, 1200},
		},
		{
			name:     "工作区等于整屏（任务栏自动隐藏）",
			monitor:  winRect{0, 0, 1920, 1080},
			work:     winRect{0, 0, 1920, 1080},
			wantPos:  winPoint{0, 0},
			wantSize: winPoint{1920, 1080},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pos, size := maximizedBounds(tc.monitor, tc.work)
			if pos != tc.wantPos || size != tc.wantSize {
				t.Fatalf("maximizedBounds = pos %+v size %+v，期望 pos %+v size %+v",
					pos, size, tc.wantPos, tc.wantSize)
			}
		})
	}
}
