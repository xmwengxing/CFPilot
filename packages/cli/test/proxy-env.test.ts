/**
 * CLI 的代理支持 —— 回归测试。
 *
 * ## 症状
 *
 * 用户在 PowerShell 里设了 `$env:HTTPS_PROXY`，跑 `cfpilot deploy` 时
 * 依然连不上 GitHub（超时）。
 *
 * ## 根因
 *
 * Node 的 `fetch`（undici）**默认不读环境变量** ——
 * 必须显式打开 `NODE_USE_ENV_PROXY=1`（Node 24+ 内置），
 * 而且这个开关只能在**进程启动前 / 任何 fetch 之前**设。
 */
import { describe, expect, it } from 'vitest'
import { enableEnvProxy, describeProxy } from '../src/shared/proxy'

describe('CLI 代理支持', () => {
  it('没设代理变量时不该动 NODE_USE_ENV_PROXY', () => {
    delete process.env.HTTPS_PROXY
    delete process.env.https_proxy
    delete process.env.HTTP_PROXY
    delete process.env.http_proxy
    delete process.env.NODE_USE_ENV_PROXY

    expect(enableEnvProxy()).toBe(false)
    expect(process.env.NODE_USE_ENV_PROXY).toBeUndefined()
  })

  it('设了代理变量就该打开 NODE_USE_ENV_PROXY', () => {
    delete process.env.NODE_USE_ENV_PROXY
    process.env.HTTPS_PROXY = 'http://127.0.0.1:10808'
    try {
      expect(enableEnvProxy()).toBe(true)
      expect(process.env.NODE_USE_ENV_PROXY).toBe('1')
    } finally {
      delete process.env.HTTPS_PROXY
      delete process.env.NODE_USE_ENV_PROXY
    }
  })

  it('用户显式关掉（=0）就不该打开', () => {
    delete process.env.HTTPS_PROXY
    delete process.env.HTTP_PROXY
    process.env.NODE_USE_ENV_PROXY = '0'
    try {
      expect(enableEnvProxy()).toBe(false)
      expect(process.env.NODE_USE_ENV_PROXY).toBe('0')
    } finally {
      delete process.env.NODE_USE_ENV_PROXY
    }
  })

  it('已经开着就不该重复设置', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:10808'
    process.env.NODE_USE_ENV_PROXY = '1'
    try {
      expect(enableEnvProxy()).toBe(true)
      expect(process.env.NODE_USE_ENV_PROXY).toBe('1')
    } finally {
      delete process.env.HTTPS_PROXY
      delete process.env.NODE_USE_ENV_PROXY
    }
  })

  it('空白的代理变量不算数', () => {
    delete process.env.NODE_USE_ENV_PROXY
    process.env.HTTPS_PROXY = '   '
    try {
      expect(enableEnvProxy()).toBe(false)
    } finally {
      delete process.env.HTTPS_PROXY
      delete process.env.NODE_USE_ENV_PROXY
    }
  })

  it('describeProxy 要说清楚当前用的哪个代理', () => {
    delete process.env.HTTP_PROXY
    delete process.env.http_proxy
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
    try {
      expect(describeProxy()).toContain('127.0.0.1:7890')
    } finally {
      delete process.env.HTTPS_PROXY
    }
  })

  it('没有代理时 describeProxy 说直连', () => {
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
      delete process.env[k]
    }
    expect(describeProxy()).toBe('直连')
  })
})
