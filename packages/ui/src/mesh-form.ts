function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function monitorSeconds(milliseconds: unknown): string {
  return typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds > 0
    ? String(Math.max(5, Math.round(milliseconds / 1000)))
    : ''
}

export function meshProfileFormValues(saved: Record<string, unknown>): Record<string, string | boolean> {
  return {
    meshNetwork: text(saved.networkName),
    meshPsk: text(saved.psk),
    meshVirtualIp: text(saved.virtualIp),
    meshListen: text(saved.listen),
    meshTunName: text(saved.tunName),
    meshRelayDomain: text(saved.relayDomain),
    meshRelayRoom: text(saved.relayRoom),
    meshRelayConnectIp: text(saved.relayConnectIp),
    meshEnableDegrade: saved.enableDegrade !== false,
    meshEnablePunch: saved.disablePunch !== true,
    meshMonitorEndpoint: text(saved.monitorEndpoint ?? saved.monitoringEndpoint),
    meshMonitorToken: text(saved.monitorToken ?? saved.monitoringToken),
    meshMonitorInterval: text(saved.monitorInterval ?? monitorSeconds(saved.monitoringIntervalMs)),
    meshMonitorAlias: text(saved.monitorAlias ?? saved.monitoringAlias),
    meshRelayServerId: text(saved.relayServerId),
    meshRelayServerAddr: text(saved.relayServerAddr),
    meshRelayServerToken: text(saved.relayServerToken),
    meshRelayServerMode: saved.relayServerMode === 'blind' ? 'blind' : 'token',
    meshInviteInput: '',
  }
}

export function meshInviteFormValues(invite: Record<string, unknown>): Record<string, string> {
  const suggestedIp = text(invite.suggestedIp)
  return {
    meshNetwork: text(invite.network),
    meshPsk: text(invite.psk),
    ...(suggestedIp ? { meshVirtualIp: suggestedIp } : {}),
    meshRelayDomain: text(invite.relayDomain),
    meshRelayRoom: text(invite.relayRoom),
    meshRelayConnectIp: text(invite.relayConnectIp),
    meshMonitorEndpoint: text(invite.monitoringEndpoint),
    meshMonitorToken: text(invite.monitoringToken),
    meshMonitorInterval: monitorSeconds(invite.monitoringIntervalMs),
  }
}
