type MemoryConfig = import('../../ipc.js').MemoryConfig;
type MemoryStats = import('../../ipc.js').MemoryStats;

export interface RendererAPIMemory {
  // ==================== 记忆系统管理 ====================
  memoryGetStats: () => Promise<MemoryStats>;
  memoryGetConfig: () => Promise<MemoryConfig>;
  memorySetConfig: (config: Partial<MemoryConfig>) => Promise<void>;
  memoryGetInjectionPreview: () => Promise<string | null>;
}
