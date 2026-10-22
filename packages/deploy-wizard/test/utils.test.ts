import { describe, expect, it } from 'vitest'
import {
  randomAlnum,
  randomPanelPath,
  randomPassword,
  randomProbeScriptName,
  randomWorkerName,
  randomWsPath,
} from '../src/utils'

describe('随机值生成', () => {
  it('Worker 名称为 8~10 位纯随机小写字母数字，且不带项目特征', () => {
    const names = new Set<string>()
    for (let i = 0; i < 300; i++) {
      const name = randomWorkerName()
      expect(name).toMatch(/^[a-z][a-z0-9]{7,9}$/)
      expect(name).not.toContain('cfpilot')
      expect(name).not.toContain('vless')
      expect(name).not.toContain('proxy')
      names.add(name)
    }
    // 300 次随机生成不应出现大量碰撞
    expect(names.size).toBeGreaterThan(295)
  })

  it('面板路径为 /p- 加 8 位随机字符', () => {
    expect(randomPanelPath()).toMatch(/^\/p-[a-z0-9]{8}$/)
  })

  it('WS 路径是随机串，不含 vless / trojan / proxy 等特征词', () => {
    const paths = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const path = randomWsPath()
      expect(path).toMatch(/^\/[a-z0-9]{10}$/)
      // 关键：不能是可预测的字面量，也不能含协议特征词
      expect(path).not.toBe('/vless')
      expect(path).not.toBe('/trojan')
      // 只检查「作为路径片段」的特征词，随机串里偶然出现 ws 这类字母组合无害
      for (const word of ['vless', 'trojan', 'proxy', 'cfpilot', 'xhttp', '/ws']) {
        expect(path).not.toContain(word)
      }
      paths.add(path)
    }
    expect(paths.size).toBeGreaterThan(195)
  })

  it('管理密码保留 cfp- 前缀与 14 位随机字符', () => {
    expect(randomPassword()).toMatch(/^cfp-[a-z0-9]{14}$/)
  })

  it('探测脚本名以 probe 开头，长度固定', () => {
    const name = randomProbeScriptName()
    expect(name).toMatch(/^probe[a-z0-9]{10}$/)
  })

  it('randomAlnum 只输出小写字母与数字', () => {
    expect(randomAlnum(64)).toMatch(/^[a-z0-9]{64}$/)
  })
})
