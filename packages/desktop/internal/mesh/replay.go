package mesh

// 2048 位滑动窗口防重放（契约 §3.2，对齐 MobiHop crates/mobihop-crypto/src/replay.rs）。
//
// 每会话每接收方向维护一个窗口：counter > highest ⇒ 接受并推进；
// 窗口内（highest - counter < 2048）查位图去重；窗口外旧包拒绝。
// 必须在 AEAD 校验**之后**调用，避免伪造包污染窗口。

const replayWindowBits = ReplayWindowBits
const replayWords = replayWindowBits / 64

// ReplayWindow 是滑动窗口防重放判定器。
type ReplayWindow struct {
	highest uint64
	bitmap  [replayWords]uint64
}

func NewReplayWindow() *ReplayWindow { return &ReplayWindow{} }

func (w *ReplayWindow) Highest() uint64 { return w.highest }

func (w *ReplayWindow) Reset() {
	w.highest = 0
	for i := range w.bitmap {
		w.bitmap[i] = 0
	}
}

// CheckAndUpdate 判定 counter 是否可接受；可接受则记录返回 true。
func (w *ReplayWindow) CheckAndUpdate(counter uint64) bool {
	if counter > w.highest {
		w.shift(counter - w.highest)
		w.highest = counter
		w.setBit(0)
		return true
	}
	diff := w.highest - counter
	if diff >= uint64(replayWindowBits) {
		return false // 窗口外（过旧）
	}
	idx := int(diff)
	if w.getBit(idx) {
		return false // 重复
	}
	w.setBit(idx)
	return true
}

func (w *ReplayWindow) setBit(i int) {
	w.bitmap[i/64] |= uint64(1) << uint(i%64)
}

func (w *ReplayWindow) getBit(i int) bool {
	return w.bitmap[i/64]&(uint64(1)<<uint(i%64)) != 0
}

// shift 窗口向更高 counter 推进 n：原位 i 移至 i+n，溢出丢弃。
func (w *ReplayWindow) shift(n uint64) {
	if n >= uint64(replayWindowBits) {
		for i := range w.bitmap {
			w.bitmap[i] = 0
		}
		return
	}
	wordShift := int(n / 64)
	bitShift := uint(n % 64)
	if wordShift == 0 {
		if bitShift == 0 {
			return
		}
		for i := len(w.bitmap) - 1; i >= 0; i-- {
			var v uint64
			if i-wordShift >= 0 {
				v = w.bitmap[i-wordShift] << bitShift
			}
			if i-wordShift-1 >= 0 {
				v |= w.bitmap[i-wordShift-1] >> (64 - bitShift)
			}
			w.bitmap[i] = v
		}
		return
	}
	for i := len(w.bitmap) - 1; i >= 0; i-- {
		src := i - wordShift
		if src < 0 {
			w.bitmap[i] = 0
			continue
		}
		v := w.bitmap[src] << bitShift
		if src-1 >= 0 {
			v |= w.bitmap[src-1] >> (64 - bitShift)
		}
		w.bitmap[i] = v
	}
}
