package server

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
)

// embeddedAssetsHash 返回 go:embed 进来的界面文件哈希前缀。
//
// 只取内容哈希，不取时间戳：构建产物每次都会重写，时间戳不稳定；
// 同版本号重编后界面变了，哈希必须跟着变，用户可在面板左上角核对。
func embeddedAssetsHash() string {
	digest := sha256.New()
	for _, name := range []string{"assets/index.html", "assets/renderer.js", "assets/adapter.js"} {
		raw, err := embeddedFS.ReadFile(name)
		if err != nil {
			return ""
		}
		_, _ = digest.Write(raw)
	}
	return hex.EncodeToString(digest.Sum(nil))[:8]
}

// buildVersionStamp 目前只用界面资源指纹；保留独立函数便于以后加入服务端版本摘要。
func embeddedUIBuild() string {
	return embeddedAssetsHash()
}

var _ embed.FS
