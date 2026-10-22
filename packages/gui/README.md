# CFPilot GUI

CFPilot 的图形化部署与维护工具。功能与命令行版 `cfpilot-deploy` / `cfpilot-scanner` 相同，
适合不想碰终端的用户。

## 下载

在 [Releases](https://github.com/xmwengxing/CFPilot/releases) 页面下载：

| 文件 | 说明 |
|------|------|
| `CFPilot-<版本>-x64.exe` | 安装版：可选安装目录、创建桌面与开始菜单快捷方式 |
| `CFPilot-<版本>-portable.exe` | 便携版：免安装，双击即用 |

两个版本功能完全一致，都**不需要**预先安装 Node.js。

## 三步部署

1. **Cloudflare 凭据** —— 粘贴 API Token 并保存，点「自动检测账号与 KV」
   （账号与 KV 会自动识别/创建，不用手填）
2. **一键部署** —— 点「开始部署」。日志会给出控制面与数据面的地址
3. **本地真连接优选** —— 填上一步的**数据面域名**与 WS 路径，跑一次优选，
   把结果粘贴到面板的「手动优选 IP」

## 更新升级

再跑一次「开始部署」即可：工具在 KV 里存了部署清单，认得自己的项目，
会沿用原有的 UUID 与 WS 路径，**客户端订阅地址不用改**。

勾选「强制重新部署」可忽略「版本相同则跳过」。

## 安全

API Token 与面板密码只写在本机 `~/.cfpilot-gui/secrets.json`：

- **不会上传**到任何服务器，也不随安装包分发
- 工具的出境网络请求只有三类：
  - `api.cloudflare.com`（部署必需，令牌仅用于该请求的 Authorization 头）
  - 你自己的域名（优选阶段的 101 握手校验）
  - 你主动点击的官方链接（用系统浏览器打开）
- 不存在「把令牌发到第三方」的路径
- 随时可点「清除本机凭据」删除

## 已知限制

- 首次部署在部分环境可能因 GPU 进程起不来而失败（远程桌面 / 虚拟机常见）。
  工具会自动用 `--disable-gpu-sandbox` 降级重启；若仍失败，请更新显卡驱动
  或关闭安全软件的「应用沙箱」功能。
- 数据面复用 CFNext 的实现，**面板里配置的 SOCKS5 / HTTP 代理池不会生效**，
  只有 `PROXYIP` 有效。

## 从源码运行

```bash
npm install
npm run build -w @cfpilot/gui
npm run start -w @cfpilot/gui
```

打包：

```bash
cd packages/gui
npm run dist
```

产物在 `packages/gui/release/`。

## License

MIT
