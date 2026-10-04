
export type * from '@neoxlabs/kernel/types/index.js';

/* worker 线程的文件订阅交给主线程代办 —— core 的 runtime worker 和桌面的 git 状态 worker 共用。
 * 纯协议、无副作用, 可以放进 barrel。 */
export {
  createHostedWatcherClient,
  createHostedWatcherHost,
  type HostedWatcherClient,
  type HostedWatcherHost,
  type ParcelSubscribe,
} from './shared/hostedWatcher.js';
