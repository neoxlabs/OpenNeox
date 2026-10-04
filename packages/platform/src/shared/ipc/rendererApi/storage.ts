type CheckpointClearResult = import('../../ipc.js').CheckpointClearResult;
type ConfigFileContent = import('../../ipc.js').ConfigFileContent;
type StorageFileInfo = import('../../ipc.js').StorageFileInfo;
type StorageInfo = import('../../ipc.js').StorageInfo;

export interface RendererAPIStorage {
  // Storage info
  getStorageInfo: () => Promise<StorageInfo>;
  readConfigFile: (filePath: string) => Promise<ConfigFileContent>;
  listConfigDir: (dirPath: string) => Promise<StorageFileInfo[]>;
  openInFinder: (filePath: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  clearCheckpointStorage: (workspacePath: string) => Promise<CheckpointClearResult>;
  clearAllCheckpointStorage: () => Promise<CheckpointClearResult>;
  /* 清理不会自动删除的残留资源；各方法保留最新备份或仅删除长期未使用的条目，
   * 具体保留规则由 storageService 中的实现说明定义。 */
  clearStaleDbBackups?: () => Promise<{ removed: number; freedBytes: number; kept: string[] }>;
  clearStaleCliBinaries?: () => Promise<{ removed: number; freedBytes: number; kept: string[] }>;
  clearOrphanSemanticIndexes?: () => Promise<{ removed: number; freedBytes: number }>;
  /** 一键备份 (~/.neox + 会话 SQLite → 用户选定 zip) */
  backupAll: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; sizeBytes?: number; error?: string }>;

  // 文件操作 (Monaco Editor)
  readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
  /** Surface viewer 专用 — bypass workspace 限制 + 返 mtimeMs 给 polling 检测.
   *  agent 写 /tmp / .neox/cache 等 workspace 外路径时 surface 也能读, 是 Doc/Diagram/Html
   *  等 surface viewer 自动 reload 的依赖.
   *  options.workspacePath: 会话工作区根, 切窗口工程后仍可稳定读会话文件. */
  surfaceReadFile: (
    filePath: string,
    options?: { encoding?: 'utf-8' | 'base64'; workspacePath?: string | string[] },
  ) => Promise<{ success: boolean; content?: string; mtimeMs?: number; error?: string; encoding?: string }>;
  /** 打开 Surface 时预批准 path/root, 用户无感 */
  surfaceRememberAccess?: (payload: {
    path?: string;
    root?: string | string[];
    capability?: 'read' | 'write';
  }) => Promise<{ success: boolean; error?: string }>;
  writeFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;
  /* withMtime:  文件树"按修改时间排序"需要 — 传 true 时 main 逐项 stat 返回 mtime (ms) */
  listFiles: (dirPath: string, pattern?: string, options?: { showHidden?: boolean; withMtime?: boolean }) => Promise<{ success: boolean; files: Array<{ name: string; path: string; isDirectory: boolean; isFile: boolean; mtime?: number }>; error?: string }>;
  statFile: (filePath: string) => Promise<{ success: boolean; stats?: { isFile: boolean; isDirectory: boolean; size: number; mtime: number }; error?: string }>;
  readFileDataUrl?: (filePath: string) => Promise<{ success: boolean; dataUrl?: string; mimeType?: string; error?: string }>;
  fsRename: (oldPath: string, newName: string) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  fsCreate: (parentDir: string, name: string, isDirectory: boolean) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  fsDuplicate: (srcPath: string) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  fsCopyTo: (srcPath: string, destDir: string) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  fsMoveTo: (srcPath: string, destDir: string) => Promise<{ success: boolean; newPath?: string; error?: string; noop?: boolean }>;
  fsTrash: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  fsRevealInFinder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  fsOpenInTerminal: (dirPath: string) => Promise<{ success: boolean; error?: string }>;
  fsExists: (filePath: string) => Promise<{ success: boolean; exists?: boolean; error?: string }>;

  /**
   * 大文件分页读 (借鉴 IntelliJ LargeFileEditor).
   *
   * 流程: open() 拿 handle+meta → readLines() 多次按需取行 → close().
   * Handle 在窗口 destroy / 10 分钟闲置 时会自动清, renderer 也应主动 close.
   */
  largeFile: {
    open: (filePath: string) => Promise<
      | { handle: string; meta: LargeFileMeta }
      | { error: string }
    >;
    readLines: (handle: string, from: number, to: number) => Promise<
      { lines: string[] } | { error: string }
    >;
    close: (handle: string) => Promise<{ ok: boolean }>;
    setEncoding: (handle: string, encoding: string) => Promise<
      { meta: LargeFileMeta } | { error: string }
    >;
    supportedEncodings: () => Promise<{ encodings: string[] }>;
    search: (
      handle: string,
      query: string,
      opts?: { caseSensitive?: boolean; useRegex?: boolean; maxResults?: number },
    ) => Promise<
      | {
          matches: Array<{
            line: number; column: number; preview: string;
            matchStart: number; matchEnd: number;
          }>;
        }
      | { error: string }
    >;
  };

  revertFileEdit: (filePath: string, oldString: string, newString: string, mode?: 'file' | 'edit') => Promise<{ success: boolean; error?: string }>;
  reapplyFileEdit: (filePath: string, oldString?: string, newString?: string, mode?: 'file' | 'edit') => Promise<{ success: boolean; error?: string }>;
  deleteFile: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  removeDirectory: (dirPath: string) => Promise<{ success: boolean; error?: string }>;

  // 全局搜索
  searchContent: (query: string, options?: {
    caseSensitive?: boolean;
    regex?: boolean;
    filePattern?: string;
    maxResults?: number;
  }) => Promise<{
    success: boolean;
    error?: string;
    matches: Array<{
      file: string;
      line: number;
      column: number;
      text: string;
      matchStart: number;
      matchEnd: number;
    }>;
  }>;
  searchFiles: (pattern: string, options?: {
    maxResults?: number;
  }) => Promise<{
    success: boolean;
    error?: string;
    files: Array<{ file: string; type: 'file' | 'directory' }>;
  }>;
  /**
   * Semantic layer —— 一次性列出工作区所有文件（Command Palette 用）。
   * 返回相对 workspace 的路径字符串数组。
   */
  semanticListFiles?: (options?: {
    maxResults?: number;
  }) => Promise<{
    success: boolean;
    error?: string;
    files: string[];
  }>;

  /**
   * Semantic layer (IDEA-like) —— 完整接口。
   * 由 main 进程 SemanticBridge 提供，每个 workspace 独立一份索引。
   */
  semantic?: {
    init?: (cwd?: string) => Promise<{ success: boolean; started: boolean }>;
    getProgress: () => Promise<{
      success: boolean;
      progress: {
        state: 'idle' | 'bootstrapping' | 'ready' | 'incremental' | 'error';
        filesIndexed: number;
        filesTotal: number;
        symbolsTotal: number;
        currentFile?: string;
        error?: string;
      } | null;
    }>;
    isReady: () => Promise<{ success: boolean; ready: boolean }>;
    searchFiles: (query: string, limit?: number) => Promise<{
      success: boolean;
      error?: string;
      items: SemanticPaletteItem[];
    }>;
    searchSymbols: (query: string, limit?: number) => Promise<{
      success: boolean;
      error?: string;
      items: SemanticPaletteItem[];
    }>;
    searchPalette: (query: string, limit?: number) => Promise<{
      success: boolean;
      error?: string;
      items: SemanticPaletteItem[];
    }>;
    fileOutline: (filePath: string) => Promise<{
      success: boolean;
      error?: string;
      symbols: SemanticSymbolInfo[];
    }>;
    getSymbol: (symbolId: number) => Promise<{
      success: boolean;
      error?: string;
      symbol?: SemanticSymbolInfo;
    }>;
    findSymbolsByName: (name: string, limit?: number) => Promise<{
      success: boolean;
      error?: string;
      symbols: SemanticSymbolInfo[];
    }>;
    findUsages: (
      name: string,
      options?: { includeDeclarations?: boolean; limit?: number },
    ) => Promise<{
      success: boolean;
      error?: string;
      usages: SemanticIdentifierUsage[];
    }>;
    listIndexedFiles: () => Promise<{
      success: boolean;
      error?: string;
      files: Array<{
        id: number;
        path: string;
        language: string;
        mtime: number;
        hash: string;
        indexedAt: number;
        symbolCount: number;
      }>;
    }>;
  };
}

/** LargeFileViewer 的 meta —— 跟主进程 FileAdapterMeta 对齐 */
export interface LargeFileMeta {
  path: string;
  size: number;
  lineCount: number;
  ext: string;
  encoding: string;
  detectedBomEncoding?: string;
  bomSize: number;
}

/** 轻量镜像 —— 对应 src/ide/semantic/types.ts 的 PaletteItem */
export interface SemanticPaletteItem {
  kind: 'file' | 'symbol' | 'command' | 'action';
  label: string;
  sublabel?: string;
  matchedIndices?: number[];
  score: number;
  payload: Record<string, unknown>;
}

/** 轻量镜像 —— 对应 src/ide/semantic/symbolStore/SymbolStore.ts 的 IdentifierUsage */
export interface SemanticIdentifierUsage {
  id: number;
  filePath: string;
  name: string;
  line: number;
  column: number;
  endColumn: number;
  preview?: string;
  isDeclaration: boolean;
}

/** 轻量镜像 —— 对应 src/ide/semantic/types.ts 的 SymbolInfo */
export interface SemanticSymbolInfo {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  nameRange?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  signature?: string;
  documentation?: string;
  parentId: number | null;
  containerName?: string;
  exported?: boolean;
  modifiers?: string;
}
