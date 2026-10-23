#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地 TLS 代理：验证自研数据面的 **HTTPS 代理**路径（`secureTransport:'starttls'`）。

与 `tmp/cfp-proxy.py` 的差别：入站监听端口**先做 TLS 握手**，握手成功后才
在 TLS 之上解析 HTTP CONNECT —— 这正是 RFC 7231 §4.3.3 定义的 HTTPS 代理形态，
也是 Cloudflare Workers `starttls` + `startTls()` 的目标形态。

**为什么需要它**：
真机（Cloudflare 边缘）会校验 TLS 证书链，自签证书直接被拒，
无法区分「协议写错了」和「证书不被信任」。本地 workerd **不校验证书**，
因此能用它把问题隔离到协议层：如果这里能通，说明
「先 TLS 握手 → 再发明文 CONNECT」的时序是对的，
真机失败就只是证书信任问题（换受信任证书即可）。

**用法**：
    python3 tls-proxy.py --port 39190 --cert /tmp/localcert.pem --key /tmp/localkey.pem \
        [--user cfpuser --pass CfpTest2026]

零第三方依赖，Python 3.8+ 可跑。
"""

from __future__ import print_function

import argparse
import base64
import socket
import ssl
import sys
import threading

BUFSIZE = 65536


def log(msg):
    print('[tls-proxy] %s' % msg, flush=True)


def recv_until(sock, marker, limit=16384):
    """读到 marker（bytes）为止，返回累计数据；未读到则返回 None"""
    buf = b''
    while len(buf) < limit:
        try:
            chunk = sock.recv(1024)
        except socket.timeout:
            return None
        if not chunk:
            return None
        buf += chunk
        if marker in buf:
            return buf
    return None


def pipe(src, dst):
    try:
        data = src.recv(BUFSIZE)
    except (socket.timeout, socket.error, OSError):
        return False
    if not data:
        return False
    try:
        dst.sendall(data)
    except (socket.error, OSError):
        return False
    return True


def relay(a, b):
    a.setblocking(False)
    b.setblocking(False)
    open_sides = [a, b]
    try:
        while open_sides:
            readable, _, _ = select.select(open_sides, [], open_sides, 60)
            if not readable and not open_sides:
                break
            for s in readable:
                other = b if s is a else a
                if not pipe(s, other):
                    open_sides = []
                    break
    except Exception:
        pass
    finally:
        for s in (a, b):
            try:
                s.close()
            except Exception:
                pass


import select  # noqa: E402  （放在后面只是为了保持脚本头部整洁）


def handle(conn, addr, args):
    peer = '%s:%s' % (addr[0], addr[1])
    try:
        conn.settimeout(30)
        # ── 关键：TLS 握手。CF 用 starttls 时，这一层是 CF 主动发起的 ClientHello ──
        tls = args.ssl_ctx.wrap_socket(conn, server_side=True)
    except ssl.SSLError as e:
        log('TLS 握手失败 from %s：%s' % (peer, e))
        try:
            conn.close()
        except Exception:
            pass
        return
    except Exception as e:
        log('连接异常 from %s：%s' % (peer, e))
        return

    log('接受连接 from %s（TLS 已握手）' % peer)

    try:
        raw = recv_until(tls, b'\r\n\r\n')
        if raw is None:
            log('未收到 CONNECT 请求头（超时或连接关闭）from %s' % peer)
            tls.close()
            return

        head = raw.split(b'\r\n\r\n', 1)[0].decode('latin-1')
        first = head.split('\r\n')[0]
        log('收到请求：%s' % first)

        if not first.upper().startswith('CONNECT'):
            tls.sendall(b'HTTP/1.1 405 Method Not Allowed\r\n\r\n')
            tls.close()
            return

        # 可选认证
        if args.user:
            auth_ok = False
            for line in head.split('\r\n')[1:]:
                if line.lower().startswith('proxy-authorization:'):
                    token = line.split(':', 1)[1].strip()
                    if token.lower().startswith('basic '):
                        try:
                            decoded = base64.b64decode(token[6:].strip()).decode('utf-8')
                        except Exception:
                            decoded = ''
                        auth_ok = decoded == '%s:%s' % (args.user, args.password)
            if not auth_ok:
                log('认证失败 from %s' % peer)
                tls.sendall(b'HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
                tls.close()
                return

        target = first.split(' ')[1]
        if ':' in target:
            host, port = target.rsplit(':', 1)
            port = int(port)
        else:
            host, port = target, 80
        log('CONNECT 目标：%s:%d' % (host, port))

        try:
            upstream = socket.create_connection((host, port), timeout=20)
        except Exception as e:
            log('上游连接失败 %s:%d：%s' % (host, port, e))
            tls.sendall(b'HTTP/1.1 502 Bad Gateway\r\n\r\n')
            tls.close()
            return

        tls.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
        log('隧道已建立 → %s:%d' % (host, port))
        relay(tls, upstream)
    except Exception as e:
        log('处理异常 from %s：%s' % (peer, e))
    finally:
        try:
            tls.close()
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, required=True)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--cert', required=True)
    ap.add_argument('--key', required=True)
    ap.add_argument('--user', default='')
    ap.add_argument('--pass', dest='password', default='')
    args = ap.parse_args()

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(args.cert, args.key)

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.host, args.port))
    srv.listen(16)
    log('监听 %s:%d（TLS 模式%s）' % (args.host, args.port, '，需认证' if args.user else ''))

    while True:
        try:
            conn, addr = srv.accept()
        except KeyboardInterrupt:
            break
        except Exception as e:
            log('accept 异常：%s' % e)
            continue
        t = threading.Thread(target=handle, args=(conn, addr, args), daemon=True)
        t.start()


if __name__ == '__main__':
    sys.exit(main())
