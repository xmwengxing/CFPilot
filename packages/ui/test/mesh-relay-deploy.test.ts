import { describe, expect, it } from 'vitest'

import {
  buildRelayDeployScript,
  parseRelayInitOutput,
  randomRelayToken,
  relayHostFromAddr,
  relayPortFromAddr,
} from '../src/meshRelayDeploy'

describe('relayPortFromAddr', () => {
  it('取 IPv4 地址的端口', () => {
    expect(relayPortFromAddr('203.0.113.10:6000')).toBe(6000)
  })

  it('取带方括号的 IPv6 端口', () => {
    expect(relayPortFromAddr('[240e:379::1]:51821')).toBe(51821)
  })

  it('没有端口时回退默认值', () => {
    expect(relayPortFromAddr('relay.example.com')).toBe(51820)
    expect(relayPortFromAddr('')).toBe(51820)
  })

  it('端口越界时回退默认值', () => {
    expect(relayPortFromAddr('1.2.3.4:70000')).toBe(51820)
  })
})

describe('relayHostFromAddr', () => {
  it('去掉 IPv4 端口', () => {
    expect(relayHostFromAddr('203.0.113.10:51820')).toBe('203.0.113.10')
  })

  it('剥离 IPv6 方括号', () => {
    expect(relayHostFromAddr('[240e:379::1]:51820')).toBe('240e:379::1')
  })

  it('裸 IPv6 原样返回', () => {
    expect(relayHostFromAddr('240e:379::1')).toBe('240e:379::1')
  })
})

describe('randomRelayToken', () => {
  it('生成 48 位 hex 且两次不同', () => {
    const a = randomRelayToken()
    const b = randomRelayToken()
    expect(a).toMatch(/^[0-9a-f]{48}$/)
    expect(b).toMatch(/^[0-9a-f]{48}$/)
    expect(a).not.toBe(b)
  })
})

describe('buildRelayDeployScript', () => {
  it('令牌中继：带 --token、不带 --relay-only，且令牌与地址都写进命令', () => {
    const token = 'a'.repeat(48)
    const script = buildRelayDeployScript({
      mode: 'token',
      addr: '203.0.113.10:51820',
      token,
    })
    expect(script).toContain(`--token "$TOKEN"`)
    expect(script).toContain(`TOKEN='${token}'`)
    expect(script).toContain(`HOST='203.0.113.10'`)
    expect(script).toContain('--public-addr "$HOST:$PORT"')
    expect(script).not.toContain('--relay-only')
    expect(script).toContain(`DATA='/var/lib/mobihop-relay'`) // 默认值
    expect(script).toContain('--data-dir "$DATA"')
    expect(script).toContain('ExecStart=$BIN \\$RELAY_ARGS')
    // 服务已在运行时 enable --now 不会重读环境文件 ⇒ 必须 restart。
    expect(script).toContain('systemctl restart mobihop-relay')
    expect(script).not.toContain('enable --now')
    // 生成的脚本本身必须语法完整：set -euo pipefail 之后没有未定义变量。
    expect(script).not.toContain('TOKEN_CFP')
  })

  it('盲中继：带 --relay-only，不生成任何令牌行', () => {
    const script = buildRelayDeployScript({
      mode: 'blind',
      addr: '203.0.113.10:51820',
      token: '',
    })
    expect(script).toContain('"$BIN" --init --relay-only')
    expect(script).not.toContain('MOBIHOP_RELAY_TOKEN')
    expect(script).not.toMatch(/^TOKEN=/m)
    expect(script).not.toContain('--token')
    expect(script).toContain('RELAY_ARGS="--relay-only')
  })

  it('地址缺失或非法时直接报错（不要生成一条注定失败的命令）', () => {
    expect(() => buildRelayDeployScript({ mode: 'blind', addr: '', token: '' })).toThrow(/公网地址/)
    expect(() => buildRelayDeployScript({ mode: 'blind', addr: 'bad host:51820', token: '' })).toThrow(
      /非法字符/
    )
  })

  it('令牌太短时拒绝生成', () => {
    expect(() =>
      buildRelayDeployScript({ mode: 'token', addr: '203.0.113.10:51820', token: 'short' })
    ).toThrow(/令牌至少/)
  })

  it('自定义端口与二进制路径生效', () => {
    const script = buildRelayDeployScript({
      mode: 'blind',
      addr: 'relay.example.com:6000',
      token: '',
      binaryPath: '/opt/mobihop-relay',
      dataDir: '/srv/mh-relay',
    })
    expect(script).toContain(`BIN='/opt/mobihop-relay'`)
    expect(script).toContain(`DATA='/srv/mh-relay'`)
    expect(script).toContain(`PORT='6000'`)
    expect(script).toContain(`HOST='relay.example.com'`)
  })
})

describe('parseRelayInitOutput', () => {
  it('从整段输出里取出三项', () => {
    const text = [
      'MobiHop 中继初始化完成（--init）',
      '',
      'MOBIHOP_RELAY_NODE_ID=0123456789abcdef',
      'MOBIHOP_RELAY_ADDR=203.0.113.10:51820',
      'MOBIHOP_RELAY_TOKEN=' + 'b'.repeat(48),
      '',
      '[[relays]]',
      'node_id = "0123456789abcdef"',
    ].join('\n')
    expect(parseRelayInitOutput(text)).toEqual({
      nodeId: '0123456789abcdef',
      addr: '203.0.113.10:51820',
      token: 'b'.repeat(48),
    })
  })

  it('盲中继输出没有令牌行时只回填 ID 与地址', () => {
    const text = 'MOBIHOP_RELAY_NODE_ID=aaaabbbbccccdddd\nMOBIHOP_RELAY_ADDR=1.2.3.4:51820\n'
    expect(parseRelayInitOutput(text)).toEqual({
      nodeId: 'aaaabbbbccccdddd',
      addr: '1.2.3.4:51820',
    })
  })

  it('NodeId 大小写统一为小写', () => {
    expect(parseRelayInitOutput('MOBIHOP_RELAY_NODE_ID=AAAABBBBCCCCDDDD').nodeId).toBe(
      'aaaabbbbccccdddd'
    )
  })

  it('乱贴内容不会误报', () => {
    expect(parseRelayInitOutput('node_id = "0123456789abcdef"\n随机日志')).toEqual({})
    expect(parseRelayInitOutput('')).toEqual({})
  })
})
