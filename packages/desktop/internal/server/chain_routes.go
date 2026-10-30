package server

// 链式代理：在自己的 VPS 上部署 SOCKS5 落地节点。
//
// ## 为什么叫「链式代理」
//
// 这是社区通行的叫法，描述的是**链路形态**：
//
//	客户端 ──TLS/WS──> Cloudflare Worker（前置）──> 你的 VPS（落地）──> 目标站
//
// Worker 那一段是「前置」，它负责抗封锁与就近接入；
// VPS 那一段是「落地」，它决定目标站看到的出口 IP。
// 两段串起来就是「链式」。
//
// ## 为什么需要落地节点
//
// Cloudflare 的出口是机房 IP。Netflix / 银行 / Google 登录页对机房 IP 的
// 风控是结构性的：不是配置错了，是 IP 类型不对。任何「检测类」功能都只能
// 告诉你不行，只有换一个自己的出口才能让它行。
//
// ## 为什么由本机执行 ssh
//
// 脚本必须在 VPS 上以 root 跑。我们不做「把脚本托管到公网让人 curl」那种分发
// （等于把 root 执行权交给第三方站点），而是由本机把内嵌脚本通过 stdin
// 喂给系统自带的 ssh。整个过程中转的只有本机与你的 VPS。

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// chainScript 是内嵌的部署脚本（构建期由 scripts/build-desktop.mjs 从
// scripts/vps/deploy-socks5.sh 复制到 assets/）。
//
//go:embed assets/vps-socks5.sh
var chainScript string

// chainHostPattern 限定 ssh 目标的形态：`[user@]host`。
//
// 虽然 exec.Command 不经过 shell（不存在命令注入），但把参数限制在
// 合法字符集仍然有价值：能挡住「误把整条命令粘进来」这类用户操作，
// 也避免 `-oProxyCommand=...` 这种以 `-` 开头的参数被当成选项。
var chainHostPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+(@[A-Za-z0-9._:\[\]-]+)?$`)

// chainDeployTimeout 是整次远程部署的上限。
//
// 装 sing-box + 起 systemd 在慢机器上可能超过 1 分钟，给足 3 分钟；
// 超时就杀掉 ssh 并把已收到的输出回给界面（用户能看到卡在哪一步）。
const chainDeployTimeout = 3 * time.Minute

func (s *Server) registerChainRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/chain/script", s.guard(s.handleChainScript))
	mux.HandleFunc("/api/chain/run", s.guard(s.handleChainRun))
}

// handleChainScript 返回脚本原文与「手动执行」用的命令。
//
// 用途有两个：让用户先审计脚本内容；以及 ssh 走不通时（没有密钥）复制命令
// 到终端里手动跑 —— 终端里 ssh 才能正常提示输入密码。
func (s *Server) handleChainScript(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 GET/POST"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"script": chainScript,
		"command": "scp cfpilot-vps-socks5.sh root@你的VPS_IP:/tmp/ && " +
			"ssh -t root@你的VPS_IP \"bash /tmp/cfpilot-vps-socks5.sh\"",
	})
}

// handleChainRun 通过本机 ssh 在远端执行部署脚本。
//
// ## 为什么用 BatchMode
//
// 本进程没有终端，ssh 无法提示输入密码（它读的是 /dev/tty，不是 stdin）。
// 与其让请求挂在那里等一个永远不会出现的提示，不如显式 BatchMode：
// 没有可用密钥时立刻失败，并把「请改用复制命令」的提示回给界面。
func (s *Server) handleChainRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "仅支持 POST"})
		return
	}

	var body struct {
		Host string `json:"host"`
		Port int    `json:"port"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "请求体不是合法 JSON"})
		return
	}

	host := strings.TrimSpace(body.Host)
	if host == "" || !chainHostPattern.MatchString(host) {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "VPS 地址格式应为 user@主机（只允许字母、数字、点、下划线、短横线、冒号）",
		})
		return
	}
	if body.Port == 0 {
		body.Port = 1080
	}
	if body.Port < 1 || body.Port > 65535 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "端口超出范围（1-65535）"})
		return
	}

	script := withChainPort(chainScript, body.Port)

	ctx, cancel := context.WithTimeout(r.Context(), chainDeployTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "ssh",
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "ConnectTimeout=10",
		host, "bash -s",
	)
	cmd.Stdin = strings.NewReader(script)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out

	err := cmd.Run()
	output := out.String()
	code := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else if errors.Is(err, exec.ErrNotFound) {
			writeJSON(w, http.StatusOK, map[string]any{
				"ok":    false,
				"code":  -1,
				"error": "本机没有找到 ssh 客户端",
				"output": "Windows：设置 → 应用 → 可选功能 → 添加「OpenSSH 客户端」\n" +
					"或改用「复制命令」，在终端里手动执行（终端里 ssh 才能提示输入密码）",
			})
			return
		} else {
			code = -1
		}
		if ctx.Err() == context.DeadlineExceeded {
			output += "\n\n[超时] 部署超过 " + strconv.Itoa(int(chainDeployTimeout.Minutes())) + " 分钟，已中断。"
		}
	}

	hint := ""
	if code != 0 {
		// 把最常见的两种失败翻译成人话，否则用户只看到一行英文
		switch {
		case strings.Contains(output, "Permission denied"),
			strings.Contains(output, "Host key verification failed"),
			strings.Contains(output, "no such identity"):
			hint = "本机没有可用的 SSH 密钥（本程序无法替你输入密码）。" +
				"请改用「复制命令」在终端里执行，终端里 ssh 会正常提示输入密码。"
		case strings.Contains(output, "Could not resolve hostname"):
			hint = "主机名解析失败，检查 VPS 地址是否写错。"
		case strings.Contains(output, "Connection refused"), strings.Contains(output, "timed out"):
			hint = "连不上 VPS 的 22 端口，检查安全组与 sshd 是否放行。"
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     code == 0,
		"code":   code,
		"output": output,
		"error":  hint,
	})
}

// withChainPort 把界面选的端口写进脚本的默认值。
//
// 脚本本身支持 `--port`，但我们是把它当 stdin 喂给 `bash -s` 的，
// 没有命令行参数可传，所以改写脚本里的 `PORT=1080` 那一行。
func withChainPort(script string, port int) string {
	if port <= 0 || port == 1080 {
		return script
	}
	return strings.Replace(script, "\nPORT=1080\n", "\nPORT="+strconv.Itoa(port)+"\n", 1)
}
