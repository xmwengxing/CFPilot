// P4.2：最小化的 Cloudflare Workers 全局类型声明（离线可 `tsc --noEmit`）。
//
// 目的：本机无 `@cloudflare/workers-types`（npm 离线），但只用到 DO / Hibernation
// API 的一小部分。这里按 Cloudflare 官方文档声明所需成员，**不引入外部依赖**；
// 真机部署前建议换成 `npm i -D @cloudflare/workers-types`（见 README）。
//
// 只声明本项目真正使用到的成员，避免与 DOM lib 的 WebSocket / Response 等重复冲突。

declare module "*.html" {
  const content: string;
  export default content;
}

interface DurableObjectState {
  /** Hibernation API：接受一个 WebSocket 并登记标签（标签可在 `getWebSockets(tag)` 取回）。 */
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  /** 取回房间内（可按 tag 过滤）的 WebSocket。 */
  getWebSockets(tag?: string): WebSocket[];
  /** 取某个 WebSocket 的标签。 */
  getTags(ws: WebSocket): string[];
}

interface DurableObjectNamespace {
  /** 同名 = 同一 DO 实例（房间隔离由 DO 单例语义保证）。 */
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

interface DurableObjectStub {
  fetch(input: Request): Promise<Response>;
}

interface WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

declare const WebSocketPair: {
  new (): WebSocketPair;
};

/** Cloudflare 允许在 101 响应里带 `webSocket` 字段。 */
interface ResponseInit {
  webSocket?: WebSocket;
}

interface DurableObjectId {
  toString(): string;
}

/** `state.id` 可选（本项目不依赖它，仅用于日志时避免 any）。 */
interface DurableObjectState {
  readonly id?: DurableObjectId;
}

// D1 (Cloudflare Workers SQL) 最小类型声明，供监测路由使用。
interface D1ResultMeta {
  duration: number;
  size_after: number;
  rows_read: number;
  rows_written: number;
  last_row_id: number;
  changed_db: boolean;
  changes: number;
}
interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: D1ResultMeta;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(): Promise<T[]>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}
interface D1ExecResult {
  count: number;
  duration: number;
}
