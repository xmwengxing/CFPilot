/**
 * deploy-wizard 的库入口
 *
 * 部署逻辑本来就被 GUI 直接调用，这里做一个显式出口，
 * 让 GUI 把它当普通模块 require，不必在运行时动态 import TS 源码。
 * 构建时由 esbuild 打成 dist/main/deployer-lib.js（CJS）。
 *
 * ## 两种部署形态
 *
 * | 形态 | 函数 | 状态 |
 * |------|------|------|
 * | Pages 双项目 | `deployPagesSplit` | **默认推荐**，数据面已验证稳定 |
 * | Workers 双脚本 | `deployWorkerSplit` | 实验性，更新更稳定但数据面有已知 522 限制 |
 */
export { deployPagesSplit } from './pages-deploy'
export type { PagesSplitDeployOptions, PagesSplitDeployResult } from './pages-deploy'
export {
  deployWorkerSplit,
  readWorkerManifest,
  inspectWorkerKvOwnership,
  listCfPilotWorkerNamespaces,
  WORKER_MANIFEST_KEY,
} from './worker-deploy'
export type {
  WorkerSplitDeployOptions,
  WorkerSplitDeployResult,
  WorkerDeployManifest,
} from './worker-deploy'
export { CloudflareClient, CloudflareError } from './cf-api'
export type { PagesProject, PagesDeployment, WorkerDomain } from './cf-api'
