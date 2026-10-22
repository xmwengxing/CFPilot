# cfpilot-scanner

**CFPilot 本地真连接优选器** —— 用你自己的 Worker 域名做 SNI/Host，完成
**WebSocket 101 真连接校验**，只保留真正能连通的 Cloudflare 优选 IP，
彻底消灭客户端里的 `-1`。

> 绝大多数"优选 IP"工具只做 TCP 握手（端口通就算可用），
> 结果填进客户端大量 `-1`。本工具会真的发起 TLS + WebSocket 升级，
> 走完你自己 Worker 的入站路径，只有返回 `101` 的 IP 才会被保留。

## 安装

```bash
npx -y cfpilot-scanner --help
```

无需安装，`npx` 直接运行；也可 `npm i -g cfpilot-scanner`。

## 快速开始

```bash
# 1. 在你的面板里生成一次性扫描令牌（有效期短，用完即废）
# 2. 执行优选（域名必须是绑好自定义域名的那个）
npx -y cfpilot-scanner scan --host cfpilot.example.com --token <令牌>

# 结果会自动回填到面板的「手动优选 IP」池
```

只打印不回填：

```bash
npx -y cfpilot-scanner scan --host cfpilot.example.com --no-callback --top 20
```

## 运行前必须关闭代理工具

> ⚠️ 这是最容易踩的坑，也是「结果看起来正常但导入客户端全是 -1」的头号原因。

本工具测的是**本机直连某个 IP 的真实质量**。
只要本机有代理工具在接管流量，测出来的就是**到代理的延迟**，而不是到目标 IP 的延迟：

- Clash / Mihomo（含 TUN 模式、系统代理）
- v2rayN / v2rayNG
- sing-box / Nekoray
- Surge / Quantumult

**症状**：扫描不报错、结果看起来正常，但所有候选 IP 成绩趋于一致
（常常集中在一个小网段），导入客户端后大量 `-1` —— 因为从未真正直连验证过。

工具会在扫描前自动检测，发现异常会打印提醒：

```
⚠️  检测到可能干扰优选的因素：
   本机有代理程序在监听：
     Clash Verge → 127.0.0.1:7897
    → 关闭这些代理程序，或在其中把本程序加入直连/绕过名单
   DNS 把 your-domain.com 解析到 198.18.0.82（198.18/15 保留段），TUN / fake-ip 正在生效
    → 关闭代理工具的 TUN 模式与 fake-ip DNS
```

检测到问题**不会阻断扫描**（有些人确实需要走代理，比如域名在本地被污染），
但结果的可信度由你自己判断。

如果必须开着代理，请把它加入直连/绕过名单，
并确保**待测的 Cloudflare IP 段**走直连而不是代理节点。

## 对接任意 VLESS-WS 项目（CFNext / cfnew / BPB / edgetunnel）

不依赖 CFPilot 自己的探针端点，只要知道你项目的 **WebSocket 路径**即可：

```bash
# CFNext：路径通常就是 UUID（或面板里配置的 path）
npx -y cfpilot-scanner scan --host your-domain.com --path /<uuid> --no-callback

# 常见约定：/vless
npx -y cfpilot-scanner scan --host your-domain.com --path /vless --no-callback

# 有些项目把 WebSocket 放在根路径，那就填 /
npx -y cfpilot-scanner scan --host your-domain.com --path / --no-callback
```

**路径必须与目标项目实际的 WebSocket 路径完全一致**，填错一个 IP 都选不出来。
不知道就分别试 `/` 和 `/vless`，能出结果的那个就是对的。

- 阶段二会对 `<path>` 发起真实的 **TLS + WebSocket 101** 握手，只有 101 才算可用
- **测速支持任意项目**，不需要对方提供任何端点（见下节）
- 想控制行为可用 `--speed-mode`、`--speed-url`、`--no-speed`

## 测速：两种方式，只对已校验的 IP 生效

**关键前提**：测速**只作用于已通过 101 校验的 IP**。这一点很重要 ——
同类工具常见的失败模式是「只测带宽、不校验能不能服务你的域名」，
结果选出的 IP 速度很快，导入客户端却全是 `-1`。

| 方式 | 什么时候用 | 要求 | 忠实度 |
|------|-----------|------|--------|
| `probe` | 目标有 CFPilot 探针端点（如 `/__edge_probe`） | 目标须提供该端点 | 高（走代理真实路径） |
| `url` | 其它任何项目 | 无 | 中（测「候选 IP 到 Cloudflare 边缘」的带宽） |

默认 `--speed-mode auto`：自动探测目标有没有探针端点，有就走 `probe`，没有就切 `url`。
**因此对接第三方项目时速度不再永远是 0。**

```bash
# 强制用公开测速地址（任何项目都能测出速度）
npx -y cfpilot-scanner scan --host your-domain.com --path /vless \
  --speed-mode url --no-callback

# 换成自己的测速地址（需返回大文件）
npx -y cfpilot-scanner scan --host your-domain.com --path /vless \
  --speed-url "cdn.example.com/big.bin" --no-callback
```

### 测速精度的几个设计点

1. **取滑动窗口峰值，而不是总平均**
   TCP 慢启动会让开头 1~2 秒的速率远低于链路实际能力。
   实测同一 IP：峰值 `51.7 MB/s`、总平均仅 `16.4 MB/s` —— 用平均会严重低估。
   因此默认丢弃前 1 秒的样本，再取窗口速率的最大值。

2. **默认 3 条并发连接**（`--speed-conns`）
   单条 TCP 连接受拥塞窗口与 BDP 限制，高延迟线路上往往填不满实际带宽。

3. **测速地址可用性预检**
   测速地址本身可能在本网络下不可用。启动时并行探测候选地址，
   自动选用可用的那个，避免把「地址不可用」误判成「所有 IP 速度都是 0」。

4. **默认 6 秒测量时长**（`--speed-duration`）
   太短会被慢启动拉低，太长浪费时间。

## 输出：直接可复制的列表

扫描结束后会额外打印一段，**一行一个，直接粘进同类项目的「自定义 IP / 优选 IP」输入框**：

```
── 可直接复制（粘贴到「自定义 IP / 优选 IP」输入框）──
104.19.73.179:443#LAX
104.17.242.168:443#LAX
104.16.59.243:443#LAX
104.27.19.224:443#AMS
```

（`IP:端口#机房` 是这类项目通用的语法；优选几个就有几行，不用再手动删改）

## 三阶扫描

| 阶段 | 做什么 | 默认开销 |
|------|--------|----------|
| 一阶 · 延迟探测 | 采样大量 IP 做 TCP 连接测延迟 | 采样 20000，并发 300 |
| 二阶 · 真连接校验 | 对候选发起 **TLS + WebSocket 101** 握手 | 120 个候选 |
| 三阶 · 下行测速 | 通过 `/__edge_probe` 流式下载测真实速度 | 30 个候选，5 MB |

只有通过二阶的 IP 才算"可用"，三阶用于排序。

## 常用参数

```
--host <domain>       你的 Worker 自定义域名（SNI 与 Host）
--token <token>       面板生成的一次性令牌
--top <n>             保留条数（默认 15）
--concurrency <n>     一阶并发（默认 300）
--sample <n>          候选采样数（默认 20000）
--cidr <a,b>          自定义网段
--ip-file <path>      使用本地 IP 列表（支持 CloudflareSpeedTest 的 result.csv）
--max-latency <ms>    一阶延迟上限
--json                以 JSON 输出
```

## 本地面板桥接

```bash
npx -y cfpilot-scanner serve
```

在 `127.0.0.1:19527` 起一个本地服务，面板里点「本地真连接优选」会自动唤醒它，
通过 SSE 实时推送进度，不需要手动复制令牌。

## 输出示例

```
阶段一：采样 20000 个候选，并发 300 …
阶段二：120 个候选进入 101 校验 …
阶段三：30 个候选测速（5 MB）…
✅ 可用 14 个，已回填面板

  104.17.242.168:443   12ms   18.4 MB/s
  104.19.73.179:443    18ms   15.1 MB/s
  ...
```

## 为什么需要它

随机抽取的 Cloudflare 官方 IP 里，能真正完成 WebSocket 升级的比例只有约 1/4，
而且**因地区、运营商、时间而异**。只有用你自己的域名实测过，
才能得到当前网络下真正可用的那批 IP。

## 许可

MIT
