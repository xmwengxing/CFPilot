package mesh

import "time"

// W3：链路健康分级。
//
// 面板原来看两个数（RTT / 丢包）自己判断，而「刚连上还没样本」「对端停了组网但
// 会话还在」「样本只有 2 个」这几种情况的正确结论并不一样。这里把探针证据折成
// 四档，让界面/CLI/告警用同一套口径：
//
//	green   近 5s 内有 Pong，且丢包 < 15%
//	yellow  近 15s 内有 Pong，或丢包 15%~50%
//	red     超过 15s 没有 Pong，或丢包 >= 50%
//	unknown 还没有任何探针样本（刚连上 / 从未探测）—— 不能当 red
//
// 判据只用**探针**（UdpProbe / Pong）：它按来源配对、迟到回包不入账（K24 §5），
// 是唯一能区分「链路死了」与「没有业务流量」的证据。业务帧的 sinceOKRx 只用于
// Peer.Online 的粗判，不进健康分级 —— 否则空闲链路会被误判成故障。
const (
	HealthGreen   = "green"
	HealthYellow  = "yellow"
	HealthRed     = "red"
	HealthUnknown = "unknown"

	// healthRedPongAge：超过它没有任何 Pong ⇒ red（与 Peer.Online 的 15s 同口径）。
	healthRedPongAge = 15 * time.Second
	// healthYellowPongAge：超过它但不到 red ⇒ yellow。
	healthYellowPongAge = 5 * time.Second
	// healthRedLoss / healthYellowLoss：样本足够（>= LossMinSamples）时的丢包阈值。
	healthRedLoss    = 0.5
	healthYellowLoss = 0.15
)

// probeHealth 把探针证据折成健康档位。
//
// samples 是已发出的探针轮数（Measurement 口径）；loss 在样本不足时恒为 0，
// 所以这里必须用 samples 判断「有没有证据」，不能拿 loss 反推。
func probeHealth(lastPong time.Duration, loss float64, samples uint32) string {
	if samples == 0 {
		return HealthUnknown
	}
	if samples >= LossMinSamples && loss >= healthRedLoss {
		return HealthRed
	}
	if lastPong > healthRedPongAge {
		return HealthRed
	}
	if samples >= LossMinSamples && loss >= healthYellowLoss {
		return HealthYellow
	}
	if lastPong > healthYellowPongAge {
		return HealthYellow
	}
	return HealthGreen
}

// aggregateHealth 取所有对端里最差的一档（red > yellow > green；unknown 不压过有证据的）。
// 没有任何有证据的对端时返回 unknown。
func aggregateHealth(peers []Peer) string {
	worst := ""
	for _, p := range peers {
		switch p.Health {
		case HealthRed:
			return HealthRed
		case HealthYellow:
			worst = HealthYellow
		case HealthGreen:
			if worst == "" {
				worst = HealthGreen
			}
		}
	}
	if worst == "" {
		return HealthUnknown
	}
	return worst
}
