package mesh

import "golang.org/x/crypto/curve25519"

// curve25519Public 从 X25519 私钥计算公钥（标量乘 basepoint）。
func curve25519Public(priv []byte) ([]byte, error) {
	if len(priv) != 32 {
		return nil, errInvalidKeyLen
	}
	return curve25519.X25519(priv, curve25519.Basepoint)
}

var errInvalidKeyLen = &keyLenError{}

type keyLenError struct{}

func (e *keyLenError) Error() string { return "mesh: X25519 私钥必须 32 字节" }
