# MobiHop 开发设备清单（**不含任何密码**）

> 本文件**可以进仓库** —— 它只列**变量名**与**含义**。
> 凭据真值在 **[`.local/devices.env`](../.local/devices.env)**（已被 `.gitignore` 排除，**不进 git**）。

---

## 1. 新会话怎么用（**给模型的三条指令**）

1. **不要 `cat`/整体读入 `.local/devices.env`** —— 密码会进上下文 → 进服务商日志。
2. **用助手脚本按变量名调用**（密码由脚本注入，模型看不到明文）：

   ```powershell
   powershell -File tools/dev.ps1 <设备别名> "<命令>"
   ```

   | 别名 | 设备 | 用途 |
   |---|---|---|
   | `ecs` | 阿里云 ECS（生产 + 跳板） | **只做 cargo 回归**（build / test / clippy / deny） |
   | `ubuntu` | Ubuntu 专用测试设备（Linux Mint 22.3） | 真机验收：NAT 矩阵 / 72h 长跑 / H1 跨机 Agent |
   | `ubuntu-admin` | Ubuntu 管理员账号 `mhopadmin`（SSH key） | 需要 root 的命令加 `sudo -n` |
   | `win` | Windows 宿主（Windows 11） | 管理 VMware 客户机；Windows→Windows 跨机测试候选 |
   | `local` | 本机开发机 | 本地执行 |

   例：
   ```powershell
   powershell -File tools/dev.ps1 ubuntu "bash /home/shijingtian/mh-h1/tools/h1-acceptance.sh all"
   powershell -File tools/dev.ps1 ubuntu-admin "id; hostname"
   powershell -File tools/dev.ps1 ecs "cd /root/mobihop-build && cargo test --workspace"
   ```

3. 只有在**确实需要**明文时（例如要手工写配置文件），才**单独**取一个变量：
   ```powershell
   (Get-Content .local\devices.env) | Select-String '^MH_UBUNTU_PASS='
   ```

---

## 2. 变量表

| 变量名 | 含义 | 备注 |
|---|---|---|
| `MH_ECS_HOST` / `MH_ECS_USER` / `MH_ECS_PASS` | 阿里云 ECS | 生产实例；**禁止**在此跑 netlab（见 §4） |
| `MH_ECS_EASYTIER_IP` | ECS 的 easytier 地址 | |
| `MH_UBUNTU_HOST` / `MH_UBUNTU_USER` / `MH_UBUNTU_PASS` | Ubuntu 专用测试设备 | **地址会漂移**，见 §3；普通 SSH 用户为 `shijingtian`，`sudo` 免密（已实测 `sudo -n id` 返回 root） |
| `MH_UBUNTU_ADMIN_USER` / `MH_UBUNTU_ADMIN_KEY` / `MH_UBUNTU_ADMIN_PASS` | Ubuntu 管理员账号与 SSH key | `ubuntu-admin` 别名使用；当前为 `mhopadmin`；优先 key，`MH_UBUNTU_ADMIN_PASS` 仅作回退 |
| `MH_UBUNTU_WORKDIR` | VM 上的 MobiHop 工作目录 | |
| `MH_UBUNTU_VMW_PATH` | 客户机 `.vmx` 路径（Windows 宿主上） | |
| `MH_WIN_HOST` / `MH_WIN_USER` / `MH_WIN_PASS` | Windows 宿主 | 同时是 VMware 宿主 |
| `MH_LOCAL_EASYTIER_IP` | 本机 easytier 地址 | MCP 客户端侧 |
| `MH_EASYTIER_CIDR` | easytier 网段 | |
| `MH_CLOUDFLARE_TOKEN` | Cloudflare 部署测试 API Token（`cfat_` 前缀，**全权限**） | 见 §4 |

---

## 3. Ubuntu 设备的 easytier 静态 IP（**已固定**）

| 项 | 值 |
|---|---|
| 固定 IP | **`10.126.126.20`** |
| 固定方式 | `/opt/easytier/config/default.conf`：`dhcp = false` + `ipv4 = "10.126.126.20"` |
| machine_id | `mobihop-ubuntu-vm-01`（官方：用于配置恢复，**必须唯一且固定**） |
| 服务单元 | `easytier@default`（模板单元，配置在 `/opt/easytier/config/default.conf`） |

**为什么原本会漂移**：原配置是 `dhcp = true`，而 easytier 官方文档明确写着
「**若发生 IP 冲突，IP 会被自动更改**」⇒ 虚拟 IP 会随启动顺序变化
（实测 `10.126.126.1` → `10.126.126.2`）⇒ 每次重启后 SSH 都要重新找地址。

### 3.1 Windows 宿主到 Ubuntu 的独立 SSH 通道

Ubuntu 是运行在远端 Windows 宿主 VMware 中的客户机。VMnet8 LAN 与 EasyTier 是独立链路，
停止 Ubuntu EasyTier 后仍可从 Windows 宿主通过 VMnet8 SSH 管理客户机。

| 项 | 值 |
|---|---|
| Windows 宿主 VMnet8 地址 | `192.168.107.1/24` |
| Ubuntu VMnet8 地址 | `192.168.107.128/24` |
| Ubuntu SSH 用户 | `mhopadmin` |
| Windows 宿主 SSH 私钥 | `C:\Users\Administrator\.ssh\id_ed25519` |
| Windows 宿主 SSH 公钥 | `C:\Users\Administrator\.ssh\id_ed25519.pub` |

Windows 宿主公钥已登记到 Ubuntu `mhopadmin` 的 `~/.ssh/authorized_keys`。在宿主 PowerShell
中使用以下命令验证独立通道：

```powershell
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=8 mhopadmin@192.168.107.128 "hostname; ip -4 route; systemctl is-active easytier@default"
```

首次非交互连接若报 `Host key verification failed`，是因为 `BatchMode=yes` 不允许确认新主机指纹。
先从 Ubuntu 控制台或已验证的管理通道核对主机密钥：

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

当前 Ubuntu ED25519 主机密钥指纹为
`SHA256:0XVxbdD6gWKNZCfi2fMdvaRbMQZjaLVkIL3Jn6eCHCE`。确认指纹一致后，在 Windows 宿主首次连接时
移除 `-o BatchMode=yes` 并接受该指纹；之后可恢复上面的非交互命令。若客机重建或 SSH 主机密钥轮换，
应重新核对指纹，再更新 Windows 宿主 `known_hosts` 中对应记录。

VMware Tools 正常时，可在 Windows 宿主获取客机当前 IP：

```powershell
& 'D:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe' getGuestIPAddress 'H:\envos\Linux Mint\Linux Mint.vmx' -wait -timeout 20
```

确认宿主到 Ubuntu 的 SSH 命令可用后，才可停止 Ubuntu EasyTier 并验证独立通道仍在：

```bash
sudo -n systemctl stop easytier@default
systemctl is-active easytier@default || true
ip -4 route
```

验证结束后如需恢复 EasyTier，可运行 `sudo -n systemctl start easytier@default`。不要在 SSH 通道未验证前停止服务。

已核实的路由为 Ubuntu EasyTier 仅负责 `10.126.126.0/24`（`tun0`）；
`192.168.107.0/24` 与默认网关走 VMware NAT 网卡 `ens33`。

**2026-11-20 实测确认**：Windows 宿主到 Ubuntu 的独立 SSH 通道可用，Ubuntu 返回主机名 `G6`，
`192.168.107.0/24` 直连路由和默认网关均走 `ens33`，只有 `10.126.126.0/24` 走 EasyTier `tun0`；
测试目标地址使用 `192.168.107.128` 时不会经过 EasyTier。`easytier@default` 当时仍为 `active`。

**2026-11-22 复核**：开发机经 EasyTier `10.126.126.20` 登录 G6，已核对本文记录的 SSH 主机指纹和公钥授权。远端 Windows `10.126.126.3` 的 SSH 端口可达，仍待核对 Windows 宿主的主机指纹。要隔离 Ubuntu 的 EasyTier，先从 Windows 宿主验证 `192.168.107.128` 的独立 SSH 通道。

公网打洞验收应核对两端实际选中的接口和路由。开发机上的 EasyTier 网卡可能使用 `et_` 前缀，曾观察到标为 `udp4` 的双向流量经过 EasyTier。CFPilot 自动生成的邀请和打洞候选已排除该类网卡，旧邀请中的地址需要用新邀请刷新。

同一组 Windows 与 G6 已验证单向邀请和 WSS 双向传输。排除 EasyTier 候选后，G6 没有 IPv6 默认路由，当前版本与 `0.60.0-beta.1` 的对照中均未建立物理出口直连。UDP 兜底中继已在 Windows 回环验证双向传输和重启恢复。ECS 的公网 `51820/UDP` 仍待核对 SSH 主机指纹后实测。

后续从本机经 Windows 宿主管理 Ubuntu 时，先用 `tools/dev.ps1 win` 执行宿主 PowerShell 命令，
再由宿主执行上面的 SSH 命令；例如停止 Ubuntu EasyTier（不会中断 VMnet8 SSH）：

```powershell
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes mhopadmin@192.168.107.128 "sudo -n systemctl stop easytier@default; systemctl is-active easytier@default || true; ip -4 route"
```

开始隔离网络实验前可按需停止 EasyTier；完成后可用同一 SSH 通道执行
`sudo -n systemctl start easytier@default` 恢复。停止前应确认没有其他测试依赖 EasyTier 虚拟网。

**改法**（配置键与 CLI 选项同名，TOML **顶层**，裸 IP **不带掩码** —— 官方 config.toml 格式）：

```toml
instance_name = "default"
dhcp = false
ipv4 = "10.126.126.20"
machine_id = "mobihop-ubuntu-vm-01"
```

**改完重启 easytier 会断 SSH 约 10–20 秒** —— 用下面任一方式操作（都不依赖 SSH 通道）：

```powershell
# 方式 A（推荐）：经 Windows 宿主 → vmrun 在客户机内直接操作
powershell -File tools/dev.ps1 win "..."   # 见 target/run-vmrun-guest.ps1
```

**回滚**（若 easytier 起不来）：VMware 控制台登录客户机执行
```bash
sudo cp /opt/easytier/config/default.conf.bak.* /opt/easytier/config/default.conf
sudo systemctl restart easytier@default
```

**Windows 宿主（10.126.126.3）与 ECS（47.104.173.139）目前仍用 DHCP** —— 建议同样固定，
避免将来出现同样的漂移问题（ECS 的 easytier 地址当前是 `10.126.126.10`）。

---

## 4. Cloudflare 部署测试令牌

| 项 | 值 |
|---|---|
| 变量名 | `MH_CLOUDFLARE_TOKEN`（令牌）、`MH_CLOUDFLARE_ACCOUNT_ID`（Account ID，32 位 hex，**非机密**） |
| 形态 | `cfat_` 前缀 —— Cloudflare **API Token**（不是 Global API Key） |
| 用途 | Cloudflare 部署测试（DNS / Workers / Pages / Tunnel 等） |

### 调用方式（**两种**）

```powershell
# ① 推荐：cf-api —— 令牌走 header 对象，**不落进程命令行**
powershell -File tools/dev.ps1 cf-api GET  https://api.cloudflare.com/client/v4/zones
powershell -File tools/dev.ps1 cf-api POST https://api.cloudflare.com/client/v4/zones '{"name":"example"}'

# ② 便捷：cf —— 注入环境变量后执行任意命令
#    ⚠️ 令牌会被 PowerShell 展开进命令行（进程列表可见）—— 仅在必要时用
powershell -File tools/dev.ps1 cf 'curl -s -H "Authorization: Bearer $env:CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify'

# ③ 不带命令：查看注入说明（令牌长度，不显示明文）
powershell -File tools/dev.ps1 cf
```

`cf` / `cf-api` 会设置两个环境变量供子进程继承：
`CLOUDFLARE_API_TOKEN` 与 `CF_API_TOKEN`（不同工具读不同变量名）。

### 该令牌的实测权限范围（2026-11-13）

| 端点 | 结果 | 含义 |
|---|---|---|
| `/zones` | **200**，4 个 zone 全部可见 | Zone:Read ✓ |
| `/accounts` | **200**，1 个账户 | Account:Read ✓ |
| `/zones/<id>/dns_records` | 200（读）· POST 200（写） | **DNS 读写权限 ✓**（部署测试需要） |
| `/zones/<id>/settings` | 200 | Zone 设置读 ✓ |
| `/zones/<id>/workers/scripts` | 200 | Workers 脚本端点可达 |
| `/accounts/<id>/workers/scripts` | 200 | 账户级 Workers 端点可达 |
| `/user` | 403 | 缺 User:Read（列举型端点；不影响部署） |
| `/user/tokens/verify` | 401 | 该端点不接受此类型令牌（端点限制） |

**结论**：令牌权限**足以做部署测试**（DNS 读写 + Workers + Zone 设置）。
`/user` 403 与 `/user/tokens/verify` 401 属**端点/权限范围限制**，不代表令牌无效。

> ⚠️ **探测权限时不要用「会真的创建资源」的 POST** —— Cloudflare 会**照常创建**。
> 2026-11-13 实测：用于探测 DNS 写权限的 POST 真的建出了一条 TXT 记录
> （`probe-mobihop-validity.invalid`），**已当场删除并复核无残留**。
> 探测写权限请用**目标资源已存在**的记录做 PUT/PATCH，或用**明显无效的 zone id**
> （返回 404/403 而不会创建）。

---

## 5. 设备使用纪律（**踩过的坑，别重犯**）

| 设备 | 纪律 | 原因 |
|---|---|---|
| **阿里云 ECS** | **绝不**在上面跑 `tools/netlab/`（真实 NAT 实验） | 内核 3.10 的 nf_tables **无 netns 隔离** ⇒ masquerade 规则污染宿主全局表 ⇒ **公网完全失联两次**（需从云控制台重启恢复）。该实例同时托管 `edumaster_api` / `edumaster_postgres` / `easytier` 等生产容器 |
| **Ubuntu 测试设备** | 实验脚本**只写 netns**，不写宿主防火墙；`ubuntu` 以 `shijingtian` 登录，`ubuntu-admin` 以 `mhopadmin` 的 SSH key 登录；两者都**不是 root**，systemd / TUN 操作使用 `sudo -n`（sudo 免密） | 同类风险；且它是 H1 验收的唯一远端 |
| **实验进程** | **用 release 构建**；用完**清理**；**不要** `pkill -x mobihop`（会误杀同机其它实例） | debug 二进制 155MB（release 9.2MB，**17 倍**）；多个实例叠加会耗尽内存 ⇒ sshd 无法 fork ⇒ 整机失联（2026-11-12 实测） |
| **清理进程** | 按 netns / PID 精确清理（`ip netns pids <ns>`），或用字符类避免 `pkill -f` 自匹配 | `pkill -f "mcp-bridge --config ..."` 会**匹配到自己的 shell** 并自杀（整条 SSH 命令行含目标串时） |
| **本地文件** | `.local/` 与 `opencode.json` 必须保持 gitignore | 含凭据 / 本机绝对路径 |
| **同步工作区到设备** | 必须加 `--with-dist`：`bash tools/pack-worktree.sh --with-dist target/mh.tar.gz` | `ui/dist` 是构建产物、不入库，但 `mhop-rpc/build.rs` 编译期需要它；ubuntu/ecs 通常没装 node，缺了它会直接在 build.rs 处报错 |

---

## 6. 恢复凭据文件（**新克隆仓库时**）

`.local/devices.env` 不在 git 里。若仓库被重新克隆，需要**手工重建**（内容见本仓库的
`docs/DEVICES.md` 说明与本会话历史；凭据值由项目负责人提供）。

建议：**单独用密码管理器保存一份**，重建时粘贴回去。

---

## 7. 凭据轮换

设备失陷或人员变动时，轮换下列密码并**同步更新** `.local/devices.env`：

- 阿里云 ECS `root`
- Ubuntu 测试设备 `shijingtian` 与管理员 `mhopadmin`（轮换 SSH key）
- Windows 宿主 `Administrator`
- Cloudflare API Token（`MH_CLOUDFLARE_TOKEN`）—— 在 Cloudflare 控制台重新签发后替换

### ④ 一键部署 MobiHop 边缘盲中继（P4.2）

```powershell
# 部署 + 协议级验证（**推荐**：必须给自定义域，见下方说明）
powershell -File edge/deploy-cf.ps1 -Domain mobihop-edge.<你的zone> -Probe

# 只验证已部署的端点（不重新部署）
powershell -File edge/deploy-cf.ps1 -Domain mobihop-edge.<你的zone> -SkipDeploy -Probe

# 只编译校验（不上传）
powershell -File edge/deploy-cf.ps1 -Domain mobihop-edge.<你的zone> -DryRun
```

脚本会：从 `.local/devices.env` 读 `MH_CLOUDFLARE_TOKEN` / `MH_CLOUDFLARE_ACCOUNT_ID` →
注入**进程环境变量**（不落命令行、不回显）→ `npx -y wrangler@4 deploy`（可选 `--domain`）→
可选 `node tools/netlab/cf-edge-probe.mjs` 做**协议级验证**（单播/广播/房间隔离）。

> ⚠️ **为什么必须绑自定义域**　实测（2026-11-13，中国大陆网络）`*.workers.dev` 的 DNS **被污染**：
> 解析到 `103.252.114.101` 与 Facebook 的 IPv6（`2a03:2880:…:face:b00c…`），HTTPS 直接超时。
> 绑定账号下已有 zone 的自定义域后（`edge/deploy-cf.ps1 -Domain …` → `wrangler deploy --domain`），
> 解析到真实 CF 边缘 IP（如 `104.21.12.189`），443 可达。**面向国内用户部署必须这么做**。
>
> ⚠️ **WSS 房间名必须是 8–64 位小写 hex**（`^[0-9a-f]{8,64}$`）。用 `probe-room-a1` 这类名字会被
> Worker 回 **400**，客户端侧表现为 WebSocket **1006 异常关闭**（容易误判成"中继坏了"）。
>
> ⚠️ **Node 侧探测脚本**必须 `ws.binaryType = 'arraybuffer'`（默认交付 `Blob`，
> `new Uint8Array(blob)` 长度恒 0，会误判"中继只转了 0 字节"）。

---

## 6. 远端 Windows 测试机（`win`）——真机 TUN 跑法（2026-11-13 实测）

| 项 | 说明 |
|---|---|
| 登录 | `powershell -File tools/dev.ps1 win "<命令>"`（cmd 语义；**要跑 PowerShell 请用 `-EncodedCommand`**，见下） |
| 身份 | `worka06\wxgo8`（管理员会话，可创建 TUN） |
| 二进制 | `C:\mobihop\mobihop.exe`（`cargo build --release --bin mobihop` 产物，scp 上去） |
| **wintun.dll** | 必须放 `C:\mobihop\`（与 exe 同目录）；**SHA256 必须 = `e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce`**（wintun 0.14.1 amd64），否则节点直接退出：`wintun bootstrap: DLL SHA256 校验失败` |
| 下载源 | `https://www.wintun.net/builds/wintun-0.14.1.zip`（国内可达） |

### 6.1 命令注入的正确姿势

`dev.ps1 win` 把参数交给远端 **cmd**，所以：

```powershell
# ✅ 需要 PowerShell 逻辑时：本地编码成 Base64，远端 -EncodedCommand 执行（避免与 cmd/引号打架）
$script = 'Get-NetAdapter | Where-Object { $_.Name -like "mobihop*" }'
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
powershell -File tools/dev.ps1 win "powershell -NoProfile -EncodedCommand $enc"
```

### 6.2 节点必须用 WMI 启动（否则 SSH 一断就带走）

```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = "C:\mobihop\mobihop.exe up --config C:\mobihop\a\node.toml"
}
```

`Start-Process` 起的进程会在 SSH 会话结束时被终止（实测：日志显示启动成功，几秒后进程消失）。

### 6.3 **同机双节点**的硬性要求（踩过）

1. **两个节点必须用不同的 `virtual_ipv4` 网段**（例如 A `10.93.0.1/24`、B `10.94.0.2/24`）。
   若两者都用同一 `/24`，Windows 路由表只会有歧义的条目 ⇒ ping 走进错误的 TUN ⇒ **100% 丢包**（实测）。
2. **各自加对端 /32 主机路由**指向自己的 TUN：

```powershell
route add 10.94.0.2 mask 255.255.255.255 0.0.0.0 if <A 的 ifIndex>
route add 10.93.0.1 mask 255.255.255.255 0.0.0.0 if <B 的 ifIndex>
```

3. 吞吐测试若用 TCP **服务端**：需放行防火墙（`New-NetFirewallRule -Direction Inbound -Action Allow -Protocol TCP -LocalPort <port>`），
   否则 `connect` 超时（ICMP 能通不代表 TCP 能通 —— 实测踩过）。
4. `node.toml` 里 Windows 路径**用正斜杠**（`data_dir = "C:/mobihop/a"`）：TOML 会把 `\` 当转义符，
   写成 `C:\mobihop\a` 会报 `invalid escape sequence`。

### 6.4 已验证结果与报告

Win↔Win 同机双节点：ping **20/20 0% 丢包、RTT <1 ms**、TCP **24.87–25.03 Mbps**（单流 8 MiB）。
详见 [`docs/archive/reports-v1/P0-win-win-baseline.md`](archive/reports-v1/P0-win-win-baseline.md)（含「不能与 M3 的 iperf3 数字横比」的说明）。
