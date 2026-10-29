/**
 * 数据面单连接流量熔断 —— 回归测试。
 *
 * 守护两件事：
 *  1. `relay()` 的 `onChunk` 回调必须真的能**中止**中继（熔断的落点就在这里）；
 *  2. 中止时**不能**顺带关闭 socket 写流 —— 关闭写流等于关闭整条 TCP 连接，
 *     目标站会收到 RST 而来不及把响应发回来（表现为「握手成功但收不到数据」）。
 */
import { describe, expect, it } from 'vitest'
import { TrafficMeter, relay } from '../src/budget'
import { DEFAULT_CONFIG, configFromEnv, mergeConfig } from '../src/config'
import type { Env } from '../src/types'

const MB = 1024 * 1024

describe('TrafficMeter', () => {
  it('上限为 0 表示不限制：永远不触发熔断', () => {
    const meter = new TrafficMeter(0)
    expect(meter.enabled).toBe(false)
    expect(meter.add(64 * MB)).toBe(false)
    expect(meter.add(64 * MB)).toBe(false)
  })

  it('负数上限按不限制处理（配置写错时不至于把连接全断掉）', () => {
    const meter = new TrafficMeter(-1)
    expect(meter.enabled).toBe(false)
    expect(meter.add(MB)).toBe(false)
  })

  it('累计到超过上限才熔断，等于上限时不熔断', () => {
    const meter = new TrafficMeter(MB)
    expect(meter.add(MB)).toBe(false)
    expect(meter.add(1)).toBe(true)
    expect(meter.bytes).toBe(MB + 1)
  })

  it('分多次累计（上行 + 下行一起计）', () => {
    const meter = new TrafficMeter(1000)
    expect(meter.add(400)).toBe(false)
    expect(meter.add(400)).toBe(false)
    expect(meter.add(400)).toBe(true)
  })

  it('忽略非正数字节，避免空块把计数打乱', () => {
    const meter = new TrafficMeter(10)
    expect(meter.add(0)).toBe(false)
    expect(meter.add(-5)).toBe(false)
    expect(meter.bytes).toBe(0)
  })
})

/** 造一个按块下发的只读流 */
function sourceOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index]!)
      index += 1
    },
  })
}

/** 收集写入的字节，并记录目标是否被关闭 */
function sinkOf(): {
  stream: WritableStream<Uint8Array>
  bytes: () => number
  closed: () => boolean
} {
  let total = 0
  let closed = false
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      total += chunk.byteLength
    },
    close() {
      closed = true
    },
  })
  return { stream, bytes: () => total, closed: () => closed }
}

describe('relay 的流量熔断回调', () => {
  it('没有回调时整段转发，并关闭普通目标流', async () => {
    const sink = sinkOf()
    await relay(sourceOf([new Uint8Array(10), new Uint8Array(20)]), sink.stream)
    expect(sink.bytes()).toBe(30)
    expect(sink.closed()).toBe(true)
  })

  it('回调返回 true 时立即中止：超限那块不再写入', async () => {
    const sink = sinkOf()
    const meter = new TrafficMeter(15)
    await relay(
      sourceOf([new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)]),
      sink.stream,
      undefined,
      true,
      (bytes) => meter.add(bytes)
    )
    // 第一块 10 字节写入；第二块加上后 20 > 15 → 熔断，它自己也不写
    expect(sink.bytes()).toBe(10)
    expect(sink.closed()).toBe(true)
  })

  it('closeTarget=false 时熔断不关闭目标（socket 写流不能 close）', async () => {
    const sink = sinkOf()
    const meter = new TrafficMeter(1)
    await relay(
      sourceOf([new Uint8Array(8), new Uint8Array(8)]),
      sink.stream,
      undefined,
      false,
      (bytes) => meter.add(bytes)
    )
    expect(sink.bytes()).toBe(0)
    expect(sink.closed()).toBe(false)
  })
})

describe('dataBudgetMB 配置项', () => {
  it('默认不限制（保持历史行为）', () => {
    expect(DEFAULT_CONFIG.dataBudgetMB).toBe(0)
    expect(configFromEnv({} as Env).dataBudgetMB).toBe(0)
  })

  it('环境变量 DATA_BUDGET_MB 生效', () => {
    expect(configFromEnv({ DATA_BUDGET_MB: '128' } as unknown as Env).dataBudgetMB).toBe(128)
  })

  it('KV 覆盖环境变量，且按数值归一化', () => {
    const base = configFromEnv({ DATA_BUDGET_MB: '128' } as unknown as Env)
    expect(mergeConfig(base, { dataBudgetMB: 256 }).dataBudgetMB).toBe(256)
    // 面板 / KV 里可能存成字符串
    expect(mergeConfig(base, { dataBudgetMB: '64' as unknown as number }).dataBudgetMB).toBe(64)
    expect(mergeConfig(base, { dataBudgetMB: 'abc' as unknown as number }).dataBudgetMB).toBe(0)
  })
})
