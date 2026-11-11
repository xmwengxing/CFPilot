package config

import (
	"os"
	"strconv"
	"strings"
)

// 环境变量覆盖。
//
// ## 为什么需要
//
// 桌面版的默认行为是「只监听回环地址 + 配置目录在用户主目录下」，
// 这对「双击 exe」的桌面用法是对的，但对**容器 / 服务化**部署不合适：
//
//   - 容器里没有用户主目录，配置得落在挂载的卷上；
//   - 容器里要按需监听 0.0.0.0（配合 `-p 127.0.0.1:8080:8080` 或局域网访问）；
//   - 固定启动令牌让自动化 / 反代不必每次从日志里翻随机令牌。
//
// 这些都要能在**不改配置文件、不开界面**的前提下设定 —— 容器里也没有界面。
//
// ## 优先级
//
// 环境变量**高于**配置文件里的同名设置，但**低于**命令行参数
// （命令行参数由 main 包解析，作用在环境变量之后）。
const (
	// EnvDataDir 覆盖配置目录（设置、凭据、内核缓存都放这里）。
	//
	// 容器里用它把数据指到挂载卷，例如 `-v cfpilot-data:/data -e CFPILOT_DATA_DIR=/data`。
	EnvDataDir = "CFPILOT_DATA_DIR"

	// EnvAllowLAN 允许监听 0.0.0.0（局域网 / 容器对外访问）。
	//
	// 取值："1" / "true" / "yes" / "on" 视为开启，其余（含未设置）视为关闭。
	//
	// ⚠️ 开启意味着**任何能访问该端口的人**都能打开面板，
	// 而面板持有 Cloudflare Token 的读写权限、能部署与删除 Cloudflare 项目。
	// 详见 main 包的启动警告与 README 的说明。
	EnvAllowLAN = "CFPILOT_ALLOW_LAN"

	// EnvBootToken 固定启动令牌（取代每次启动随机生成的十六进制串）。
	//
	// 自动化、反代、容器编排需要它：不设的话令牌每次重启都变，
	// 只能从日志里翻。**不要用它来替代访问控制** ——
	// 它是「一次性换 Cookie」的钥匙，不是密码；Cookie 一旦换成就长期有效。
	EnvBootToken = "CFPILOT_BOOT_TOKEN"

	// EnvPort 覆盖监听端口。
	//
	// 容器里用它把服务挪到约定的端口（镜像默认 19726，与桌面版一致）。
	// 命令行 `--port` 的优先级高于它。
	EnvPort = "CFPILOT_PORT"

	// EnvListenAddr 单独覆盖**监听地址**，与「允许局域网访问」解耦。
	//
	// ## 为什么需要解耦
	//
	// 桌面版里「监听地址」与「Host 校验」是同一个开关（AllowLAN）驱动的：
	// 允许局域网 = 监听 0.0.0.0 + 放宽 Host 校验。桌面场景下这没问题。
	//
	// 但容器里必须**始终监听 0.0.0.0** ——
	// Docker 的端口转发是连容器的网卡地址，不是容器内的 127.0.0.1；
	// 只监听回环的话，`-p 19726:19726` 根本连不上（表现为「连接被接受但没有响应」）。
	//
	// 而「谁能访问」在容器里是由**宿主机的端口映射**决定的：
	//   - `-p 127.0.0.1:19726:19726` → 只有本机能访问
	//   - `-p 19726:19726`             → 整个局域网能访问
	//
	// 所以这两个开关必须分开：监听地址交给本变量，Host 校验仍由 AllowLAN 控制。
	//
	// ⚠️ 注意：Host 校验**不是访问控制** —— 非浏览器客户端可以随便伪造 Host 头。
	// 真正的边界是宿主机上的端口映射。
	EnvListenAddr = "CFPILOT_LISTEN_ADDR"
)

// EnvDataDirValue 返回配置目录的环境变量覆盖值（未设置时返回空串）。
func EnvDataDirValue() string {
	return strings.TrimSpace(os.Getenv(EnvDataDir))
}

// EnvAllowLANValue 返回「是否允许局域网访问」的环境变量取值。
//
// 只认明确的肯定词，避免把 `CFPILOT_ALLOW_LAN=0` 或空串误判成开启 ——
// 这个开关决定服务是否监听 0.0.0.0，**判错方向必须是「更安全」那一侧**。
func EnvAllowLANValue() bool {
	b, ok := parseBool(os.Getenv(EnvAllowLAN))
	return ok && b
}

// EnvBootTokenValue 返回启动令牌的环境变量覆盖值（未设置时返回空串）。
func EnvBootTokenValue() string {
	return strings.TrimSpace(os.Getenv(EnvBootToken))
}

// EnvPortValue 返回端口的环境变量覆盖值。
//
// 未设置、或不是合法端口号时返回 0（表示「不覆盖」）。
func EnvPortValue() int {
	raw := strings.TrimSpace(os.Getenv(EnvPort))
	if raw == "" {
		return 0
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 65535 {
		return 0
	}
	return n
}

// EnvListenAddrValue 返回监听地址的环境变量覆盖值（未设置时返回空串）。
//
// 只管地址，端口由 EnvPort / --port 单独决定。
func EnvListenAddrValue() string {
	return strings.TrimSpace(os.Getenv(EnvListenAddr))
}

// parseBool 把常见布尔写法解析成 bool，第二个返回值表示「是否解析成功」。
//
// 供内部复用；`strconv.ParseBool` 认 1/t/T/TRUE/true/True/0/f/F/FALSE/false/False，
// 但不认 yes/on —— 这里补上，因为容器编排里这两种写法更常见。
func parseBool(s string) (bool, bool) {
	s = strings.TrimSpace(strings.ToLower(s))
	switch s {
	case "1", "true", "yes", "on":
		return true, true
	case "0", "false", "no", "off":
		return false, true
	}
	if b, err := strconv.ParseBool(s); err == nil {
		return b, true
	}
	return false, false
}
