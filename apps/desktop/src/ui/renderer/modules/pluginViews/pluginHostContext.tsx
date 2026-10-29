/**
 * PluginHostContext — 渲染侧给 PluginViewHost 的 host API 实现.
 *
 * 主进程的 `plugin:host:getActiveFile` IPC 返回 null — "活动文件" 概念只在
 * 渲染侧 EditorService 里. 用 Context 把渲染侧的真实数据注入 PluginViewHost,
 * iframe 调 neoxCall('getActiveFile') 就能拿到正确的 path/content/language.
 *
 * Provider 由 WorkspacePage 包裹整个工作区.
 */

import React, { createContext, useContext, useMemo } from 'react';

export interface ActiveFileInfo {
  path: string | null;
  content: string | null;
  language: string | null;
}

export interface PluginHostResolvers {
  getActiveFile: () => ActiveFileInfo;
}

const PluginHostContext = createContext<PluginHostResolvers | null>(null);

export const PluginHostProvider: React.FC<{
  value: PluginHostResolvers;
  children: React.ReactNode;
}> = ({ value, children }) => {
  return <PluginHostContext.Provider value={value}>{children}</PluginHostContext.Provider>;
};

export function usePluginHostResolvers(): PluginHostResolvers | null {
  return useContext(PluginHostContext);
}

/** 构造一个稳定的 resolvers (memo 外部依赖, 避免每次 render 都变) */
export function useBuildPluginHostResolvers(
  activeFile: ActiveFileInfo,
): PluginHostResolvers {
  // 用 ref 隔离 closure 拿最新值而不引起 PluginViewHost 重挂
  const ref = React.useRef(activeFile);
  ref.current = activeFile;
  return useMemo<PluginHostResolvers>(() => ({
    getActiveFile: () => ref.current,
  }), []);
}
