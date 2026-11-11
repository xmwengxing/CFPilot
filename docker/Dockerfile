# CFPilot 桌面版 · 容器镜像
#
# ─────────────────────────────────────────────────────────────
# 为什么不在镜像里编译
# ─────────────────────────────────────────────────────────────
#
# Go 二进制由 `node scripts/build-desktop.mjs` 在**镜像外**构建好
# （放进 docker/dist/<arch>/），这里只负责装进一个最小运行环境。
#
# 理由：
#   1. **构建快** —— 镜像构建只做一次 COPY，秒级完成；
#      放在镜像里编要跑 npm install + 界面构建 + Go 编译，几分钟起步。
#   2. **镜像小** —— 最终只有 Alpine + 一个静态二进制。
#   3. **多架构干净** —— 每个架构的二进制在 CI 里各自原生编译，
#      buildx 只负责装配，不用 QEMU 跑 Go 编译（慢十倍）。
#
# 本地构建前置条件：
#   node scripts/build-desktop.mjs --only linux
#   docker build -f docker/Dockerfile -t cfpilot:local .
#
# 多架构（需要 buildx）：
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f docker/Dockerfile -t cfpilot:local .

ARG ALPINE_VERSION=3.21
FROM alpine:${ALPINE_VERSION}

# ca-certificates —— 访问 Cloudflare API 的 HTTPS 必需（Alpine 默认不带）
# tzdata         —— 定时任务的「运行时刻」按本地时区解析；
#                   缺了它时区会退化成 UTC，任务会在错误的时间点跑
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 10001 -S cfpilot && \
    adduser -u 10001 -S -G cfpilot -h /app cfpilot

# TARGETARCH 由 buildx 自动注入（amd64 / arm64 / …）。
# 声明默认值是为了兼容不带 buildx 的经典构建器 —— 那时按 amd64 处理。
ARG TARGETARCH=amd64
COPY dist/${TARGETARCH}/cfpilot /usr/local/bin/cfpilot
RUN chmod 0755 /usr/local/bin/cfpilot

# ─────────────────────────────────────────────────────────────
# 安全姿态
# ─────────────────────────────────────────────────────────────
#
# 面板持有 **Cloudflare Token 的读写权限**，能部署与删除 Cloudflare 项目。
# 所以容器默认按「只对本机可见」配置：
#
#   - 服务只监听 127.0.0.1（监听地址由 CFPILOT_ALLOW_LAN 控制，默认关）；
#   - 端口映射默认绑到宿主机的回环地址（见 docker-compose.yml）；
#   - 进程以非 root 用户（uid 10001）运行；
#   - 配置与凭据落在 /data，权限 0700。
#
# 想让局域网访问，用户必须**显式**做两件事：
#   1. 设 CFPILOT_ALLOW_LAN=1（服务改为监听 0.0.0.0，启动时会打风险警告）；
#   2. 把端口映射到宿主机的非回环地址（-p 8080:19726）。
#
# ⚠️ 这两步会把面板暴露给同网段的任何人。请只在可信网络里这么做，
#    并**永远不要**把它直接暴露到公网。

ENV CFPILOT_DATA_DIR=/data
ENV HOME=/app
# 面板默认端口（与桌面版一致）
ENV CFPILOT_PORT=19726
# 监听地址。
#
# ⚠️ 容器里**必须**监听 0.0.0.0 —— Docker 的端口转发连的是容器的网卡地址，
# 不是容器内的 127.0.0.1；只监听回环的话 `-p 19726:19726` 会「连得上但没响应」。
#
# 这**不是**「对外开放」：谁能访问由**宿主机上的端口映射**决定：
#   - `-p 127.0.0.1:19726:19726` → 只有本机能访问（默认，见 compose）
#   - `-p 19726:19726`             → 整个局域网能访问
#
# 另外，CFPILOT_ALLOW_LAN 控制的是 **Host 校验**（浏览器从局域网访问时，
# Host 头是局域网 IP，默认会被判为「非法 Host」而拒绝）。
# ⚠️ Host 校验不是访问控制 —— 非浏览器客户端可以伪造 Host 头绕过它。
# 真正的边界是端口映射。
ENV CFPILOT_LISTEN_ADDR=0.0.0.0

RUN mkdir -p /data && chown cfpilot:cfpilot /data
VOLUME ["/data"]

USER cfpilot
WORKDIR /app
EXPOSE 19726

# 健康检查：面板根路径返回静态页面，不需要会话 Cookie。
# 容器里没有浏览器也没有桌面会话 —— 所以不开托盘、不自动开浏览器。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${CFPILOT_PORT}/" || exit 1

ENTRYPOINT ["/usr/local/bin/cfpilot", "--no-tray", "--no-browser", "--console"]
