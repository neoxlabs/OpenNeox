/**
 * RunManagerProvider + useRunManager —— React 接入 RunManager 的通道.
 *
 * 为什么用 React Context 而不是 ServiceContainer:
 *   RunManager 是 workspace-scope, 生命周期绑工程路径. 现在 ServiceContainer
 *   在 WorkspacePlatformProvider 里是个长期存在的实例 (跨 workspace 切换都不
 *   重建), 我们不想把 RunManager "注入 + 反注入" 塞进容器. React Context
 *   天然跟着子树的生命周期走, 正好契合.
 *
 *   跟 ProjectPanelProvider 的模式一致 (见 WorkspacePage.tsx 2925 行附近).
 *
 * 这个 Provider 做的事情:
 *   1. useMemo 创建 RunManagerImpl (deps 是 workspacePath, 路径变就重建)
 *   2. useEffect load() + cleanup 里 dispose()
 *   3. 子树通过 useRunManager() 拿到实例, 通过 RUN_MANAGER_TOPIC 感知变化
 */

import * as React from 'react';
import { RunManagerImpl } from './RunManagerImpl.js';
import type { RunManager } from '../../../../../ide/index.js';
import { useServiceContainer } from '../../../platform/ServiceContainerContext.js';
import { MESSAGE_BUS } from '../../../../../ide/index.js';
import { RunOutputProvider } from '../output/RunOutputProvider.js';

const RunManagerContext = React.createContext<RunManager | null>(null);

export interface RunManagerProviderProps {
  workspacePath: string;
  children: React.ReactNode;
}

export const RunManagerProvider: React.FC<RunManagerProviderProps> = ({
  workspacePath,
  children,
}) => {
  const container = useServiceContainer();

  const manager = React.useMemo<RunManagerImpl>(() => {
    const bus = container.get(MESSAGE_BUS);
    return new RunManagerImpl({ workspacePath, bus, container });
    // 每次 workspacePath 变重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath]);

  // 初始化 load + dispose
  React.useEffect(() => {
    manager.load();
    return () => {
      manager.dispose();
    };
  }, [manager]);

  return (
    <RunManagerContext.Provider value={manager}>
      {/* RunOutputProvider 在 RunManagerProvider 内部, 这样它能订阅 RUN_MANAGER_TOPIC.
          它自己只管 xterm 实例 + tabs 状态, 不渲染 panel UI. UI 由 WorkspacePage
          的 <RunOutputPanel> 消费 context 渲染, 受 WorkspacePage 控制可见性. */}
      <RunOutputProvider>{children}</RunOutputProvider>
    </RunManagerContext.Provider>
  );
};

export function useRunManager(): RunManager {
  const value = React.useContext(RunManagerContext);
  if (!value) {
    throw new Error(
      'useRunManager must be called inside <RunManagerProvider>',
    );
  }
  return value;
}
