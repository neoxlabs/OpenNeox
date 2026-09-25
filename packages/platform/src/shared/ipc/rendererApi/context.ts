type ContextConfig = import('../../ipc.js').ContextConfig;
type ContextUsage = import('../../ipc.js').ContextUsage;

export interface RendererAPIContext {
  // ==================== 上下文管理 ====================
  contextGetUsage: (sessionId: string) => Promise<ContextUsage | null>;
  contextGetConfig: () => Promise<ContextConfig>;
  contextSetConfig: (config: Partial<ContextConfig>) => Promise<void | { runtimeWarning?: string }>;
  contextTriggerCompaction: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
}
