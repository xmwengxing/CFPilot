/**
 * CFNext 数据面（WebSocket 入站处理器）
 *
 * 来源：https://github.com/PAICNI/CFNext 的 `CFNext-明文版.js`
 * 用途：CFPilot 的 WS 数据面在真机上遇到 `TCP Loop detected`，
 *       而同一个模块里它的处理器可以正常拨号，因此这里直接复用其实现。
 *       CFPilot 只调用它的 `wsHandler`，面板/订阅/优选池仍是自己的代码。
 */
export declare function wsHandler(
  request: Request,
  config: {
    uuid: string
    enableTrojan?: boolean
    trojanPassword?: string
    proxyIP?: string
    outboundProxy?: string
    outboundMode?: string
    path?: string
  }
): Response
