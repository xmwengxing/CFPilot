export interface MeshInviteDefaultsInput {
  networkName: string
  psk: string
  virtualIp: string
}

export interface MeshInviteDefaults {
  networkName: string
  psk: string
  virtualIp: string
  suggestedIp: string
}

type FillRandom = (bytes: Uint8Array) => void

function randomBytes(length: number, fillRandom?: FillRandom): Uint8Array {
  const bytes = new Uint8Array(length)
  if (fillRandom) fillRandom(bytes)
  else crypto.getRandomValues(bytes)
  return bytes
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function suggestedIpv4(raw: string): string {
  const parts = raw.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255) ||
    parts[3]! < 1 ||
    parts[3]! > 254
  ) {
    throw new Error('虚拟 IP 必须是有效的 IPv4 地址')
  }
  const last = parts[3] === 254 ? 2 : parts[3]! + 1
  return `${parts[0]}.${parts[1]}.${parts[2]}.${last}`
}

export function createMeshInviteDefaults(
  input: MeshInviteDefaultsInput,
  fillRandom?: FillRandom
): MeshInviteDefaults {
  const networkName = input.networkName.trim() || `mesh-${toHex(randomBytes(6, fillRandom))}`
  const psk = input.psk.trim() || toHex(randomBytes(32, fillRandom))
  const rawVirtualIp = input.virtualIp.trim()
  // 固定默认网段，避免每次空表单生成邀请时换一个 /24，加入方旧值再与之混用。
  const virtualIp = rawVirtualIp || '10.97.0.1'

  return {
    networkName,
    psk,
    virtualIp,
    suggestedIp: suggestedIpv4(virtualIp),
  }
}
