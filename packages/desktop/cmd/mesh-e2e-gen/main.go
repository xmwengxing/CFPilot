// 真机 E2E 配置生成器（**仅测试用**，不随产品发布）。
//
// 用固定种子派生两端身份，输出可直接 POST 给 cfpilot-meshd 的 JSON：
//   mesh-A.json（节点 A，10.97.0.1，对端地址 <addr-b>:51820）
//   mesh-B.json（节点 B，10.97.0.2，对端地址 <addr-a>:51820）
//
// 用法：
//   go run ./cmd/mesh-e2e-gen -dir ../../e2e -addr-a <A 的可达 IP> -addr-b <B 的可达 IP>
//
// 然后分别在两台机器上：
//   cfpilot-meshd --console          # Windows 调试模式（或安装为服务）
//   sudo ./cfpilot-meshd             # Linux
//   curl -X POST http://127.0.0.1:19727/api/mesh/start \
//        -H 'Content-Type: application/json' --data-binary @mesh-A.json
//
// 详见 internal/mesh/E2E_TEST.md。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/xmwengxing/cfpilot/packages/desktop/internal/mesh"
)

func fill(v byte) (out [32]byte) {
	for i := range out {
		out[i] = v
	}
	return out
}

func main() {
	outDir := flag.String("dir", "e2e", "输出目录")
	addrA := flag.String("addr-a", "10.126.126.6", "A 的可达地址（对端 B 用它连 A）")
	addrB := flag.String("addr-b", "10.126.126.20", "B 的可达地址（对端 A 用它连 B）")
	vipA := flag.String("vip-a", "10.97.0.1", "A 的虚拟 IP")
	vipB := flag.String("vip-b", "10.97.0.2", "B 的虚拟 IP")
	network := flag.String("network", "e2e-net", "网络名")
	psk := flag.String("psk", "e2e-psk-1234567890", "PSK")
	flag.Parse()

	idA, err := mesh.IdentityFromSeeds(fill(0x01), fill(0x11))
	if err != nil {
		panic(err)
	}
	idB, err := mesh.IdentityFromSeeds(fill(0x02), fill(0x22))
	if err != nil {
		panic(err)
	}

	base := func(self *mesh.Identity, vip string, peer *mesh.Identity, peerVIP, peerAddr string) mesh.Config {
		return mesh.Config{
			NodeID:        self.NodeID,
			NetworkName:   *network,
			PSK:           *psk,
			IdentitySeed:  self.IdentitySeed[:],
			TunnelPrivate: self.TunnelSeed[:],
			VirtualIP:     vip,
			Listen:        "0.0.0.0:51820",
			MTU:           1400,
			Verbose:       true,
			Peers: []mesh.PeerConfig{{
				NodeID:    peer.NodeID,
				Addr:      peerAddr + ":51820",
				StaticPub: peer.TunnelPub,
				VirtualIP: peerVIP,
			}},
		}
	}

	cfgA := base(idA, *vipA, idB, *vipB, *addrB)
	cfgB := base(idB, *vipB, idA, *vipA, *addrA)
	if err := cfgA.Validate(); err != nil {
		panic("A 配置非法: " + err.Error())
	}
	if err := cfgB.Validate(); err != nil {
		panic("B 配置非法: " + err.Error())
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		panic(err)
	}
	for name, cfg := range map[string]mesh.Config{"mesh-A.json": cfgA, "mesh-B.json": cfgB} {
		raw, err := json.MarshalIndent(cfg, "", "  ")
		if err != nil {
			panic(err)
		}
		path := filepath.Join(*outDir, name)
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			panic(err)
		}
		fmt.Printf("已写出 %s\n", path)
	}
	fmt.Printf("A nodeId=%s vip=%s peer=%s\n", idA.NodeID.Hex(), *vipA, *addrB)
	fmt.Printf("B nodeId=%s vip=%s peer=%s\n", idB.NodeID.Hex(), *vipB, *addrA)
}
