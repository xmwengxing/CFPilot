package mesh

import (
	"fmt"

	"github.com/vmihailenco/msgpack/v5"
)

// PubKey 是 32 字节公钥（wire 为 32 元素整数 array，对齐 Rust serde [u8;32]）。
//
// 与 NodeID 同理（punch.go）：msgpack/v5 对 [32]byte / []byte 走 bin 编码（0xc4/0xc5），
// 而 Rust serde 的 `[u8;32]` 走 fixarray/array 编码 —— 必须用 int 数组中转强制 array。
type PubKey [32]byte

func (p PubKey) MarshalMsgpack() ([]byte, error) {
	arr := make([]int, 32)
	for i, b := range p {
		arr[i] = int(b)
	}
	return msgpack.Marshal(arr)
}

func (p *PubKey) UnmarshalMsgpack(b []byte) error {
	var arr []int
	if err := msgpack.Unmarshal(b, &arr); err != nil {
		return err
	}
	if len(arr) != 32 {
		return &badPubKeyLenError{got: len(arr)}
	}
	for i, v := range arr {
		p[i] = byte(v)
	}
	return nil
}

type badPubKeyLenError struct{ got int }

func (e *badPubKeyLenError) Error() string {
	return fmt.Sprintf("mesh: 公钥 wire 长度应为 32，实际 %d", e.got)
}

// Signature 是 Ed25519 签名（64 字节，wire 为 byte 序列）。
// Rust 侧 `Vec<u8>` 的 signature 编码为 bin（0xc4/0xc5） —— Go []byte 默认一致，无需自定义。
