/**
 * VcsContext —— 给 Git Commit tool window 注入业务数据。
 *
 * 同 ProjectPanelContext 的 DataContext 模式：tool window descriptor
 * 是稳定常量，通过 Context 拉数据避免 register/unregister 抖动。
 */

import { createContext, useContext, type ReactNode } from 'react';

export interface VcsContextValue {
  workspacePath: string;
  onToast: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  /** 在编辑器中打开文件 */
  onOpenFile: (path: string) => void;
}

const VcsContext = createContext<VcsContextValue | null>(null);

export interface VcsPanelProviderProps {
  value: VcsContextValue;
  children: ReactNode;
}

export function VcsPanelProvider({ value, children }: VcsPanelProviderProps) {
  return <VcsContext.Provider value={value}>{children}</VcsContext.Provider>;
}

export function useVcsContext(): VcsContextValue {
  const ctx = useContext(VcsContext);
  if (!ctx) {
    throw new Error('useVcsContext must be used inside <VcsPanelProvider>');
  }
  return ctx;
}
