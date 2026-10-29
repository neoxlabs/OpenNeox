export interface MemoryStatsEntry {
  count: number;
  sizeBytes: number;
  path?: string;
}

export interface MemoryStats {
  shortTerm: MemoryStatsEntry;
  session: MemoryStatsEntry;
  longTerm: {
    total: MemoryStatsEntry;
    progress: MemoryStatsEntry;
    standard: MemoryStatsEntry;
    lesson: MemoryStatsEntry;
  };
  pinned: MemoryStatsEntry;
  totals: MemoryStatsEntry;
}

export interface MemoryConfig {
  /** 自动记忆 (开了 Jev 才生效) —— 对应 config.memory.autoMemoryEnabled */
  autoMemoryEnabled: boolean;
}
