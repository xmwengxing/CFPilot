/**
 * deploy-wizard 的库入口
 *
 * 部署逻辑（pages-deploy.ts）本来就被 GUI 直接调用，这里做一个显式出口，
 * 让 GUI 把它当普通模块 require，不必在运行时动态 import TS 源码。
 * 构建时由 esbuild 打成 dist/main/deployer-lib.js（CJS）。
 */
export { deployPagesSplit } from './pages-deploy'
export type { PagesSplitDeployOptions, PagesSplitDeployResult } from './pages-deploy'
export { CloudflareClient, CloudflareError } from './cf-api'
export type { PagesProject, PagesDeployment } from './cf-api'
