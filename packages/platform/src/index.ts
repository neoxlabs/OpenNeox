
export type * from '@neoxlabs/kernel/types/index.js';

/* worker 线程的文件订阅交给主线程代办 —— core 的 runtime worker 和桌面的 git 状态 worker 共用。
 * 纯协议、无副作用, 可以放进 barrel。 */
/* 接入线路自动选择 —— 桌面主进程 / runtime worker / CLI 各装一次。只用 node 内建, 导入无副作用
 * (要显式调 installEdgeRouting 才接管网络); 渲染层不引这个 barrel。 */
export {
  activeEdge,
  hostResolverRulesFor,
  installEdgeRouting,
  readCachedEdge,
  type EdgeDef,
} from './platform/edgeRoute.js';

export {
  createHostedWatcherClient,
  createHostedWatcherHost,
  type HostedWatcherClient,
  type HostedWatcherHost,
  type ParcelSubscribe,
} from './shared/hostedWatcher.js';
