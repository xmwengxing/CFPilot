/**
 * 账号 / KV 归属解析
 *
 * ## 为什么需要这一层
 *
 * KV 命名空间是**账号作用域**的：同一个 KV ID 只在它所属的账号下有意义。
 * 而「本次部署用哪个账号」与「本次部署用哪个 KV」在 CLI 里是**两个独立来源**
 * （命令行参数 vs 本地配置文件），两者一旦不一致就会：
 *
 *   - 在账号 A 里建出**孤儿 Pages 项目**（KV 绑定必然失败）；
 *   - 往**别的账号**的 KV 里写数据；
 *   - 留下一堆半成品实例，用户完全不知道发生了什么。
 *
 * 所以这里统一提供两个能力：
 *
 *   1. `findAccountByKv` —— 给定 KV ID，**反查**它属于哪个账号；
 *   2. `checkKvInAccount` —— 给定账号与 KV ID，**校验**两者是否同源。
 *
 * 两者都不接受「猜」：查不到就返回「无法确认」，由调用方按**不可放行**处理。
 */

import type { CloudflareAccount, CloudflareClient } from './cf-api'

/** 反查结果。 */
export interface KvOwnerLookup {
  /** 持有该 KV 的账号；查不到为 null */
  owner: CloudflareAccount | null
  /** 有多少个账号的命名空间列表读取失败（权限 / 网络） */
  unreadable: number
}

/**
 * 按 KV ID 反查它属于哪个账号。
 *
 * KV 是账号作用域的，所以「KV 属于谁」只能靠**逐个账号列出命名空间**来判定
 * （CF 没有「按 KV ID 反查账号」的接口）。
 *
 * ⚠️ 某个账号的命名空间列表**读不到**（无权限 / 网络抖动）时**跳过它**，
 * 继续试下一个 —— 但要记下来，因为「所有账号都读不到」和「所有账号都没有这个 KV」
 * 是两回事，前者不能报「KV 不存在」。
 */
export async function findAccountByKv(
  client: CloudflareClient,
  accounts: CloudflareAccount[],
  kvId: string
): Promise<KvOwnerLookup> {
  let unreadable = 0
  for (const account of accounts) {
    let namespaces: Array<{ id: string }>
    try {
      namespaces = await client.listKvNamespaces(account.id)
    } catch {
      // 该账号读不到 → 跳过，继续试下一个账号。
      // 这里**不能**当成「这个账号没有该 KV」：那会把「读不到」误判成「不存在」。
      unreadable++
      continue
    }
    if (namespaces.some((ns) => ns.id === kvId)) {
      return { owner: account, unreadable }
    }
  }
  return { owner: null, unreadable }
}

/** KV 与账号的同源校验结果。 */
export type KvAccountCheck =
  /** KV 确实属于该账号 */
  | 'yes'
  /** KV 明确不属于该账号（该账号的命名空间列表里没有它） */
  | 'no'
  /** 无法确认（列不出命名空间 / 网络失败 / 权限不足） */
  | 'unknown'

/**
 * 校验 KV 是否属于指定账号。
 *
 * 「无法确认」与「明确不属于」必须分开：
 * 前者意味着**不能放行**（读不到 ≠ 不存在，见 B9），
 * 后者意味着**肯定要拦下**（跨账号写入）。
 */
export async function checkKvInAccount(
  client: CloudflareClient,
  accountId: string,
  kvId: string
): Promise<KvAccountCheck> {
  let namespaces: Array<{ id: string }>
  try {
    namespaces = await client.listKvNamespaces(accountId)
  } catch {
    return 'unknown'
  }
  return namespaces.some((ns) => ns.id === kvId) ? 'yes' : 'no'
}
