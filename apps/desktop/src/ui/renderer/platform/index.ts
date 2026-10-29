/**
 * @ui/renderer/platform — Renderer 端的 IDE 平台层接入
 *
 * 这一层是 React 世界跟 src/ide/ 平台层之间的胶水。组件不直接 import
 * src/ide 里的具体实现，而是通过这里的 hook / Provider 拿到服务。
 *
 * 当前导出
 * --------
 * - WorkspacePlatformProvider  组合根，创建 + 注册所有 workspace 服务
 * - ServiceContainerProvider   底层 Context Provider（一般用 WorkspacePlatform 即可）
 * - useService                 拿一个类型化服务
 * - useServiceContainer        拿整个容器（极少需要）
 * - createWindowFsPort         把 window.neox 适配成 FileSystemPort（测试用）
 */

export {
  WorkspacePlatformProvider,
  type WorkspacePlatformProviderProps,
} from './WorkspacePlatformProvider.js';
export {
  ServiceContainerProvider,
  useServiceContainer,
  useOptionalServiceContainer,
  type ServiceContainerProviderProps,
} from './ServiceContainerContext.js';
export { useService } from './useService.js';
export {
  useCommand,
  useCommandShortcut,
  useCommandRegistry,
  useFocusScope,
} from './useCommand.js';
export { useTopicSubscription } from './useTopicSubscription.js';
export { useWorkspaceFsWatcher } from './useWorkspaceFsWatcher.js';
export {
  useToolWindowRegistry,
  useToolWindowsByAnchor,
} from './useToolWindows.js';
export { ToolWindowSlot } from './ToolWindowSlot.js';
export type { ToolWindowSlotProps } from './ToolWindowSlot.js';
export { createWindowFsPort } from './createWindowFsPort.js';
