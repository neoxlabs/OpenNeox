type IndexBuildProgress = import('../../ipc.js').IndexBuildProgress;
type IndexBuildResult = import('../../ipc.js').IndexBuildResult;
type IndexStats = import('../../ipc.js').IndexStats;
type IndexSymbolKind = import('../../ipc.js').IndexSymbolKind;
type IndexSymbolSearchResult = import('../../ipc.js').IndexSymbolSearchResult;
type ProjectStartupStatus = import('../../projectStartup/types.js').ProjectStartupStatus;

interface EmbeddingStatus {
  ready: boolean;
  fileCount: number;
  chunkCount: number;
  lastBuilt: number | null;
  indexing: boolean;
}

interface EmbeddingChunk {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  relatedSymbols?: Array<{
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    signature?: string;
    containerName?: string;
  }>;
}

export interface RendererAPIIndexing {
  // ==================== 代码索引管理 ====================
  indexGetStats: () => Promise<IndexStats>;
  indexBuild: (force?: boolean) => Promise<IndexBuildResult>;
  indexClear: () => Promise<{ success: boolean; error?: string }>;
  indexSearch: (query: string, kind?: IndexSymbolKind, limit?: number) => Promise<IndexSymbolSearchResult[]>;
  onIndexProgress: (callback: (progress: IndexBuildProgress) => void) => () => void;

  // ==================== Codebase chunk index ====================
  embeddingInit?: (cwd: string) => Promise<void>;
  embeddingBuild?: (cwd: string, force?: boolean) => Promise<{ success: boolean; filesIndexed: number; chunksCreated: number; timeMs: number }>;
  embeddingStatus?: (cwd: string) => Promise<EmbeddingStatus>;
  embeddingSearch?: (cwd: string, query: string, topK?: number) => Promise<{ chunks: EmbeddingChunk[] }>;
  embeddingClear?: (cwd: string) => Promise<{ success: boolean }>;
  onEmbeddingProgress?: (callback: (progress: { phase: string; done: number; total: number }) => void) => () => void;

  projectStartupNotifyRendererReady?: (cwd: string) => Promise<{ started: boolean }>;
  projectStartupGetStatus?: (cwd?: string) => Promise<ProjectStartupStatus>;
  /** main→renderer push of ProjectStartupStatus. Returns unsubscribe. */
  onProjectStartupChanged?: (callback: (status: ProjectStartupStatus) => void) => () => void;
}
