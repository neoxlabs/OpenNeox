/**
 * ServiceContainerContext —— React 这边访问 IDE 平台层服务的入口。
 *
 * 跟 SessionStoreProvider / RuntimeStoreProvider 是同一类东西，但承载的不是
 * 业务状态，而是"取服务的能力"。组件通过 useService(TOKEN) 拿任意已注册的
 * 服务，不再 import 单例、不再 props drilling。
 *
 * 这一层故意做得**极薄** —— 它的全部职责就是把一个 ServiceContainer 塞进
 * React 树。具体的 service 注册、生命周期管理由 WorkspacePlatformProvider
 * 这种"组合根"完成。
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { ServiceContainer } from '../../../ide/index.js';

const ServiceContainerContext = createContext<ServiceContainer | null>(null);

export interface ServiceContainerProviderProps {
  container: ServiceContainer;
  children: ReactNode;
}

export function ServiceContainerProvider({
  container,
  children,
}: ServiceContainerProviderProps) {
  return (
    <ServiceContainerContext.Provider value={container}>
      {children}
    </ServiceContainerContext.Provider>
  );
}

/**
 * 拿当前 React 树范围内的 ServiceContainer。
 * 必须在 ServiceContainerProvider 内部使用，否则抛错（不返回 null，避免静默 bug）。
 */
export function useServiceContainer(): ServiceContainer {
  const container = useContext(ServiceContainerContext);
  if (!container) {
    throw new Error(
      'useServiceContainer must be used inside <ServiceContainerProvider>',
    );
  }
  return container;
}

/**
 * 安全版本：树外使用时返回 null，让组件自行决定降级。
 * 极少数场景需要（比如组件可能在 Provider 树内外都被渲染）。
 */
export function useOptionalServiceContainer(): ServiceContainer | null {
  return useContext(ServiceContainerContext);
}
