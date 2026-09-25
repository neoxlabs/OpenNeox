/**
 * @parcel/watcher/wrapper.js 的类型声明。
 *
 * 这个子路径是包里的纯 JS 外壳 (normalizeOptions + createWrapper), 没有 .d.ts —— 包的
 * 类型只覆盖主入口 index.js。WatchCoordinator 在编译版里要绕开主入口 (它会 require 平台
 * 原生包, 在 bun binary 的 $bunfs 里必然失败), 直接用这层外壳套 sidecar watcher.node,
 * 所以得自己声明。
 */
declare module '@parcel/watcher/wrapper.js' {
  import type * as parcelWatcher from '@parcel/watcher';
  export function createWrapper(binding: unknown): typeof parcelWatcher;
}
