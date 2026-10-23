/**
 * scanner-cli 的库入口
 *
 * 扫描逻辑本来就是库函数（runScan / resolveCandidates / formatCopyable），
 * 这里只做一个显式出口，供 CFPilot GUI 直接 import 使用：
 *   - 图形版优选器不需要起子进程，也不需要系统装 Node
 *   - 命令行版与图形版走**完全相同**的扫描实现，行为一致
 */
export { runScan, formatCopyable, formatEntries } from './scan'
export type { ScanOptions, ScanEvent, ScanEntry, ScanSummary } from './scan'
export { resolveCandidates, normalizeCandidateList } from './candidates'
export type { CandidateOptions, IpFamily } from './candidates'
export { probeWs101, measureDownload, measureThroughput } from './true-probe'
export type { WsProbeResult, DownloadResult, ThroughputResult, ThroughputOptions } from './true-probe'
export { detectProxyInterference, isFakeIp, isPortListening, readSystemProxy, PROXY_PORTS } from './net-env'
export type { NetEnvResult, ProxyFinding } from './net-env'
export {
  DEFAULT_SPEED_URL,
  SPEED_URL_PRESETS,
  parseSpeedUrl,
  withBytes,
  schemeForPort,
  checkSpeedUrlAvailable,
  pickAvailableSpeedUrl,
  detectProbeEndpoint,
  resolveSpeedMode,
} from './speed-url'
export type { ParsedSpeedUrl } from './speed-url'
export { COUNTRY_COLOS, COUNTRY_NAMES, SUPPORTED_COUNTRIES, countryOfColo, isKnownCountry, normalizeCountryFilter } from './countries'
