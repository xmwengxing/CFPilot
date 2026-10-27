package kernel

// CompareSemver 的单元测试。
//
// 覆盖三类场景：
//   1. 正常的大小比较（**数字比较，不是字典序** —— 0.10 > 0.9）
//   2. 解析失败的一方视为更旧
//   3. 预发布版本的优先级

import "testing"

func TestCompareSemver(t *testing.T) {
	cases := []struct {
		name string
		a, b string
		want int // 正数 a>b，负数 a<b，0 相等
	}{
		{"同版本", "0.7.6", "0.7.6", 0},
		{"补丁号更大", "0.7.6", "0.7.5", 1},
		{"补丁号更小", "0.7.5", "0.7.6", -1},
		{"次版本号更大", "0.8.0", "0.7.99", 1},
		{"主版本号更大", "1.0.0", "0.9.9", 1},
		{"主版本号更小", "0.9.9", "1.0.0", -1},
		// ⚠️ 必须是数值比较：0.10.0 > 0.9.0（字典序会判反）
		{"十进制不是字典序", "0.10.0", "0.9.0", 1},
		{"带 v 前缀", "v0.7.6", "0.7.6", 0},
		{"带 v 前缀且更新", "v0.8.0", "0.7.6", 1},
		{"缺省段按 0 处理", "0.7", "0.7.0", 0},
		{"缺省段按 0 处理（更新）", "0.8", "0.7.9", 1},
		{"构建元数据被忽略", "0.7.6+20261028", "0.7.6", 0},
		// ---- 解析失败的一方视为更旧 ----
		{"空串比有版本更旧", "", "0.7.6", -1},
		{"有版本比空串更新", "0.7.6", "", 1},
		{"两边都空", "", "", 0},
		{"非法串更旧", "abc", "0.7.6", -1},
		{"非法串比非法串", "abc", "def", 0},
		{"带非法后缀", "0.7.6abc", "0.7.6", -1},
		// ---- 预发布版本 ----
		{"预发布比正式版旧", "0.7.6-rc1", "0.7.6", -1},
		{"正式版比预发布版新", "0.7.6", "0.7.6-rc1", 1},
		{"预发布之间比较", "0.7.6-rc2", "0.7.6-rc1", 1},
		{"预发布标识更多更新", "0.7.6-rc.1", "0.7.6-rc", 1},
		{"预发布相同", "0.7.6-rc1", "0.7.6-rc1", 0},
		{"数字标识优先级低", "0.7.6-1", "0.7.6-alpha", -1},
	}

	for _, tc := range cases {
		got := CompareSemver(tc.a, tc.b)
		ok := (tc.want > 0 && got > 0) || (tc.want < 0 && got < 0) || (tc.want == 0 && got == 0)
		if !ok {
			t.Errorf("%s：CompareSemver(%q, %q) = %d，期望符号 %d", tc.name, tc.a, tc.b, got, tc.want)
		}
	}
}

// 反向比较必须对称。
func TestCompareSemverSymmetry(t *testing.T) {
	versions := []string{"", "0.7.6", "0.7.5", "v0.8.0", "0.10.0", "abc", "0.7.6-rc1", "1.0.0"}
	for _, a := range versions {
		for _, b := range versions {
			ab := CompareSemver(a, b)
			ba := CompareSemver(b, a)
			if (ab > 0 && ba >= 0) || (ab < 0 && ba <= 0) || (ab == 0 && ba != 0) {
				t.Errorf("不对称：CompareSemver(%q,%q)=%d，CompareSemver(%q,%q)=%d",
					a, b, ab, b, a, ba)
			}
		}
	}
}

// 版本相同必须返回 0（不能因为格式差异判成不同）。
func TestCompareSemverEqualAcrossFormats(t *testing.T) {
	if CompareSemver("0.7.6", "v0.7.6") != 0 {
		t.Error("v 前缀不该影响比较结果")
	}
	if CompareSemver("0.7.6", "0.7.6 ") != 0 {
		t.Error("首尾空格不该影响比较结果")
	}
}
