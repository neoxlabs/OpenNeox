/**
 * useService —— 从 ServiceContainer 取一个类型化服务。
 *
 * 这是组件接入平台层的最小用法：
 *
 * ```tsx
 * import { useService } from '@ui/renderer/platform'
 * import { EDITOR_SERVICE } from '@neox/ide'
 *
 * function MyComponent() {
 *   const editor = useService(EDITOR_SERVICE)
 *   // editor 是 EditorService 实例，类型从 token 推导而来
 * }
 * ```
 *
 * 不在 Provider 树内调会抛错（来自 useServiceContainer），跟 React 同类
 * hook（useDispatch/useStore 等）的失败模式一致。
 */

import type { ServiceToken } from '../../../ide/index.js';
import { useServiceContainer } from './ServiceContainerContext.js';

export function useService<T>(token: ServiceToken<T>): T {
  return useServiceContainer().get(token);
}
