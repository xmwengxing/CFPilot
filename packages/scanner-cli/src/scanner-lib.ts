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
export { probeWs101, measureDownload } from './true-probe'
export type { WsProbeResult, DownloadResult } from './true-probe'
