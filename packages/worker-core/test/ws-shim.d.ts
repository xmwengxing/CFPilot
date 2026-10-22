/**
 * `ws` 库的最小类型声明。
 *
 * 仅在测试环境使用：workerd 的 WebSocketPair 在 Node 下不存在，
 * 需要 ws 起本地服务器来构造真实双向通道。
 * ws 未安装 @types/ws，这里按本测试用到的 API 声明最小表面。
 */
declare module 'ws' {
  import type { Server as HttpServer } from 'node:http'

  export interface WebSocketLike {
    readyState: number
    binaryType: string
    send(data: unknown, cb?: (err?: Error) => void): void
    close(code?: number, reason?: string): void
    terminate(): void
    once(event: string, listener: (...args: never[]) => void): void
    on(event: string, listener: (...args: never[]) => void): this
    addEventListener?(event: string, listener: (event: unknown) => void): void
  }

  export class WebSocket {
    static readonly OPEN: number
    constructor(url: string)
    readyState: number
    binaryType: string
    send(data: unknown, cb?: (err?: Error) => void): void
    close(code?: number, reason?: string): void
    terminate(): void
    once(event: string, listener: (...args: never[]) => void): this
    on(event: string, listener: (...args: never[]) => void): this
  }

  export class WebSocketServer {
    constructor(options: { server: HttpServer })
    close(): void
    once(event: 'connection', listener: (socket: never) => void): this
    on(event: 'connection', listener: (socket: never) => void): this
  }
}
