/**
 * SemanticService —— 语义层的门面。
 *
 * 职责
 * ----
 * 本类是 UI 层唯一应该跟语义能力打交道的入口。内部编排 FileIndex /
 * SymbolStore / LanguageParser 三者的协作，对外暴露 **同步查询**（热路径）
 * 和 **异步索引**（冷路径）两类 API。
 *
 * 设计原则
 * --------
 * 1. **只依赖已有平台层**：VfsService + MessageBus，不碰 Electron / React / DOM
 * 2. **同步查询优先**：Cmd+P / Cmd+T / Goto Symbol 都要 <10ms 响应，
 *    热路径全部走内存 Map + 预编译 SQL，不 await
 * 3. **异步索引容错**：单个文件 parse 失败不能影响整个索引；
 *    parse 错误只报事件，不抛异常
 * 4. **可测试**：通过依赖注入（SymbolStore / FileIndex / parsers）
 *    让单测可以用内存 mock 跑完整个流程，不碰真实文件系统
 * 5. **增量优先**：bootstrap 尽量 skip 没变的文件（hash / mtime 比对）
 */

import { performance } from 'perf_hooks';
import type { MessageBus } from '../bus/MessageBus.js';
import type { SymbolStore, SymbolInput } from './symbolStore/SymbolStore.js';
import { FileIndex, basenameOf } from './fileIndex/FileIndex.js';
import type { FileEntry } from './fileIndex/FileIndex.js';
import type { LanguageParser } from './parsers/Parser.js';
import { languageFromPath } from './parsers/Parser.js';
import type {
  FileInfo,
  IndexingProgress,
  IndexingState,
  PaletteItem,
  ReferenceInfo,
  SymbolInfo,
} from './types.js';
import type { IdentifierUsage } from './symbolStore/SymbolStore.js';
import { SEMANTIC_TOPIC } from './types.js';
import { fuzzyMatch, fuzzyFilter } from './fuzzy/FuzzyMatcher.js';
import { CanceledError, isCanceledError, ProgressContext } from '@neoxlabs/platform/shared/async/progressContext.js';

// ============================================================================
// 文件系统端口 —— 由注入方提供
// ----------------------------------------------------------------------------
// 语义层需要 *比* VfsService 更多一点能力 —— 列目录、读 mtime —— 这些
// VfsService 刻意没做。为了不污染 VfsService，语义层定义自己的端口。
// 在 Electron 场景下，调用方会用 fs/promises 绑定；测试里可以用 memfs。
// ============================================================================

export interface SemanticFileSystemPort {
  /**
   * 递归列出 rootPath 下所有可索引的文件。调用方负责 .gitignore / node_modules
   * 等过滤规则 —— 语义层信任传入的是一个 "已经筛好的" 列表。
   */
  walk(
    rootPath: string,
    options?: { ignore?: string[]; maxFiles?: number },
  ): Promise<Array<{ path: string; size: number; mtime: number }>>;

  /** 读文件内容 */
  readFile(filePath: string): Promise<string>;

  /** 读取 mtime（epoch ms），用于增量判断 */
  stat(filePath: string): Promise<{ size: number; mtime: number } | null>;
}

// ============================================================================
// 构造选项
// ============================================================================

export interface SemanticBootstrapPlan {
  files?: Array<{ path: string; size: number; mtime: number }>;
  changedPaths?: string[];
  removedPaths?: string[];
  reason?: string;
}

export interface SemanticServiceOptions {
  /** workspace 根目录 */
  workspaceRoot: string;
  /** 已经打开的 SymbolStore 实例 */
  store: SymbolStore;
  /** 文件系统端口 */
  fs: SemanticFileSystemPort;
  /** MessageBus —— 对外发索引事件 */
  bus: MessageBus;
  /**
   * 注册的语言 parser。key 是语言 id，value 是对应的 parser。
   * 允许多个语言 id 指向同一个 parser（例如 ts + tsx 共用 TypeScriptParser）。
   */
  parsers: Map<string, LanguageParser>;
  /**
   * bootstrap 时 ignore 的文件 / 目录 glob。默认 = 合理的 IDE 默认值。
   * 调用方可以传自定义列表补充。
   */
  ignoreGlobs?: string[];
  /** 节流进度事件发布间隔（ms），默认 100 */
  progressThrottleMs?: number;
}

const DEFAULT_IGNORE: string[] = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.DS_Store',
  '.neox',
  'reverse',         // IDEA 源码逆向目录（几十万文件）
  'vendor',          // Monaco/VSCode fork 源码（不是我们的代码）
  'prebuilds',
  '*.node',
  '*.wasm',
];

// ============================================================================
// SemanticService
// ============================================================================

export class SemanticService {
  private readonly workspaceRoot: string;
  private readonly store: SymbolStore;
  private readonly fs: SemanticFileSystemPort;
  private readonly bus: MessageBus;
  private readonly parsers: Map<string, LanguageParser>;
  private readonly ignoreGlobs: string[];
  private readonly progressThrottleMs: number;
  private readonly fileIndex: FileIndex = new FileIndex();

  private state: IndexingState = 'idle';
  private filesTotal = 0;
  private filesIndexed = 0;
  private lastProgressEmit = 0;
  private bootstrapError: string | undefined;
  private disposed = false;

  /**
   * service 生命周期 ctx —— dispose() 时 cancel. 所有长任务 (bootstrap /
   * reindexFile) 创建 child 并在 batch 边界 checkCanceled(), workspace 切换
   * 时立即退出, 不再浪费 CPU 继续 parse.
   */
  private readonly lifecycleCtx: ProgressContext;

  /** 已经完成 init() 的 parser —— Lazy init: 首次遇到该语言才 init. */
  private readonly initializedParsers = new WeakSet<LanguageParser>();

  constructor(opts: SemanticServiceOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.store = opts.store;
    this.fs = opts.fs;
    this.bus = opts.bus;
    this.parsers = opts.parsers;
    this.ignoreGlobs = opts.ignoreGlobs ?? DEFAULT_IGNORE;
    this.progressThrottleMs = opts.progressThrottleMs ?? 100;
    this.lifecycleCtx = ProgressContext.detached(`semantic:${opts.workspaceRoot}`);
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * 启动全量索引。幂等 —— 已经在 ready 状态时调用会直接 return。
   *
   * 流程：
   *   1. state = bootstrapping，发事件
   *   2. 让所有 parser init()
   *   3. fs.walk() 扫出候选文件列表，灌进 FileIndex
   *   4. 逐个文件 hash 对比 SymbolStore 中的记录 —— 跳过未变的
   *   5. 对剩下的文件调 parser.parse()，结果写入 SymbolStore
   *   6. state = ready，发事件
   */
  async bootstrap(plan?: SemanticBootstrapPlan): Promise<void> {
    if (this.state === 'ready' || this.state === 'bootstrapping') {
      return;
    }
    this.setState('bootstrapping');
    this.publisher().onBootstrapStarted();
    this.bootstrapError = undefined;

    // Per-bootstrap ctx —— 继承 lifecycle, dispose 时级联取消.
    const runCtx = this.lifecycleCtx.child('bootstrap');

    const bootstrapStartedAt = performance.now();
    let lastYieldAt = performance.now();
    let unchangedFiles = 0;
    let parseCandidates = 0;
    let slowestFile = '';
    let slowestParseMs = 0;

    const maybeYield = async () => {
      if (performance.now() - lastYieldAt < 12) return;
      await yieldToEventLoop();
      lastYieldAt = performance.now();
      runCtx.checkCanceled();
    };

    try {
      // Parser init 延后 —— 只在 indexSingleFile 首次遇到该语言时 init.
      // 这让: (1) 只有 JS 的项目不必付 Python parser native .node 的加载成本;
      //       (2) 启动时没有串行的 parser.init() 阻塞.
      // concurrency 从 parser 列表一次性采样 (取最大值), 避免每批次重算.
      const uniqueParsers = [...new Set(this.parsers.values())];
      const parseConcurrency = Math.max(1, ...uniqueParsers.map((parser) => {
        const value = Number((parser as { maxConcurrency?: number }).maxConcurrency ?? 1);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
      }));
      console.info('[SemanticService] parsers registered (lazy-init)', {
        workspaceRoot: this.workspaceRoot,
        parserCount: uniqueParsers.length,
        parseConcurrency,
      });
      runCtx.checkCanceled();
      await maybeYield();

      const walkStartedAt = performance.now();
      const fileList = plan?.files ?? await this.fs.walk(this.workspaceRoot, { ignore: this.ignoreGlobs });
      const changedPaths = plan?.changedPaths ? new Set(plan.changedPaths) : null;
      const removedPaths = plan?.removedPaths ?? [];
      for (const removedPath of removedPaths) {
        this.removeFile(removedPath);
      }
      this.filesTotal = fileList.length;
      this.filesIndexed = 0;
      console.info('[SemanticService] workspace walk done', {
        workspaceRoot: this.workspaceRoot,
        fileCount: this.filesTotal,
        removedPaths: removedPaths.length,
        mode: plan ? 'startup-plan' : 'full-scan',
        reason: plan?.reason,
        elapsedMs: roundMs(performance.now() - walkStartedAt),
      });

      const planningStartedAt = performance.now();
      const toIndex: Array<{ path: string; language: string; mtime: number; size: number }> = [];
      for (const f of fileList) {
        const language = languageFromPath(f.path);
        if (!language) {
          await maybeYield();
          continue;
        }

        this.fileIndex.upsert({
          path: f.path,
          basename: basenameOf(f.path),
          language,
          size: f.size,
          mtime: f.mtime,
        });

        if (changedPaths && !changedPaths.has(f.path)) {
          unchangedFiles++;
          this.filesIndexed++;
          await maybeYield();
          continue;
        }

        const existing = this.store.getFile(f.path);
        if (!changedPaths && existing && existing.mtime === f.mtime) {
          unchangedFiles++;
          this.filesIndexed++;
          await maybeYield();
          continue;
        }

        if (this.parsers.has(language)) {
          parseCandidates++;
          toIndex.push({ path: f.path, language, mtime: f.mtime, size: f.size });
        } else {
          this.filesIndexed++;
        }
        await maybeYield();
      }
      console.info('[SemanticService] bootstrap plan ready', {
        workspaceRoot: this.workspaceRoot,
        filesTotal: this.filesTotal,
        unchangedFiles,
        parseCandidates,
        plannedChangedFiles: changedPaths?.size,
        elapsedMs: roundMs(performance.now() - planningStartedAt),
      });

      for (let index = 0; index < toIndex.length; index += parseConcurrency) {
        if (this.disposed || runCtx.isCanceled) break;
        const batch = toIndex.slice(index, index + parseConcurrency);
        const results = await Promise.all(batch.map(async (entry) => {
          const parseStartedAt = performance.now();
          await this.indexSingleFile(entry.path, entry.language, entry.mtime);
          return {
            path: entry.path,
            parseMs: performance.now() - parseStartedAt,
          };
        }));

        for (const result of results) {
          if (result.parseMs > slowestParseMs) {
            slowestParseMs = result.parseMs;
            slowestFile = result.path;
          }
          this.filesIndexed++;
          this.maybeEmitProgress(result.path);
          await maybeYield();  // 这里会 runCtx.checkCanceled()
        }
      }

      if (this.disposed || runCtx.isCanceled) {
        runCtx.dispose();
        return;
      }

      this.setState('ready');
      this.publisher().onReady(this.snapshotProgress());
      console.info('[SemanticService] bootstrap done', {
        workspaceRoot: this.workspaceRoot,
        filesTotal: this.filesTotal,
        filesIndexed: this.filesIndexed,
        unchangedFiles,
        parseCandidates,
        symbolsTotal: this.store.getSymbolCount(),
        slowestFile: slowestFile || undefined,
        slowestParseMs: slowestFile ? roundMs(slowestParseMs) : undefined,
        elapsedMs: roundMs(performance.now() - bootstrapStartedAt),
      });
    } catch (err) {
      // Canceled 不是 error: workspace 切换 / dispose 触发的中止属于正常路径.
      if (isCanceledError(err)) {
        this.setState('idle');
        console.info('[SemanticService] bootstrap canceled', {
          workspaceRoot: this.workspaceRoot,
          filesIndexed: this.filesIndexed,
          elapsedMs: roundMs(performance.now() - bootstrapStartedAt),
        });
        return;
      }
      this.setState('error');
      this.bootstrapError = errorToString(err);
      console.error('[SemanticService] bootstrap failed', {
        workspaceRoot: this.workspaceRoot,
        error: this.bootstrapError,
        elapsedMs: roundMs(performance.now() - bootstrapStartedAt),
      });
      this.publisher().onError(`Bootstrap failed: ${this.bootstrapError}`, {
        error: this.bootstrapError,
      });
    } finally {
      runCtx.dispose();
    }
  }

  /**
   * 处理单个文件变动（chokidar / VFS event 驱动的增量更新）。
   */
  async reindexFile(filePath: string): Promise<void> {
    if (this.disposed || this.lifecycleCtx.isCanceled) return;
    const language = languageFromPath(filePath);
    if (!language) return;

    const stat = await this.fs.stat(filePath).catch(() => null);
    if (!stat) {
      // 文件没了 —— 从索引中删除
      this.removeFile(filePath);
      return;
    }

    this.fileIndex.upsert({
      path: filePath,
      basename: basenameOf(filePath),
      language,
      size: stat.size,
      mtime: stat.mtime,
    });

    if (!this.parsers.has(language)) return;
    await this.indexSingleFile(filePath, language, stat.mtime);
  }

  /** 从索引中移除一个文件（用户删文件时调用） */
  removeFile(filePath: string): void {
    this.fileIndex.remove(filePath);
    this.store.deleteFile(filePath);
    this.publisher().onFileRemoved(filePath);
  }

  /** 销毁 —— 不再接受索引请求，已在途的会被尽快跳出 */
  dispose(): void {
    this.disposed = true;
    // cancel lifecycleCtx → 正在跑的 bootstrap / reindexFile 在下一个
    // checkCanceled (batch 边界) 立即退出, 不等 parse 完全部文件.
    this.lifecycleCtx.cancel(new CanceledError('SemanticService disposed'));
  }

  /**
   * Parser 按需 init —— 第一次 parse 某 language 才付 load 成本.
   * 幂等: 多并发调用同一 parser 只会 init 一次 (前者会被 await 完成).
   */
  private async ensureParserInitialized(parser: LanguageParser): Promise<void> {
    if (this.initializedParsers.has(parser)) return;
    const pending = (parser as LanguageParser & { __initPromise?: Promise<void> }).__initPromise;
    if (pending) {
      await pending;
      return;
    }
    const promise = parser.init();
    (parser as LanguageParser & { __initPromise?: Promise<void> }).__initPromise = promise;
    try {
      await promise;
      this.initializedParsers.add(parser);
    } finally {
      delete (parser as LanguageParser & { __initPromise?: Promise<void> }).__initPromise;
    }
  }

  // --------------------------------------------------------------------------
  // Queries (同步 —— 热路径)
  // --------------------------------------------------------------------------

  getProgress(): IndexingProgress {
    return this.snapshotProgress();
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  searchFiles(query: string, limit = 50): PaletteItem[] {
    const items = this.fileIndex.all();
    /** basename 命中的加权分 — 保证 "Explorer" 时 FileExplorer.tsx 排在路径里含 explorer 的杂项之前 */
    const BASENAME_BONUS = 60;
    const matched: Array<{ item: FileEntry; score: number; indices: number[] }> = [];
    for (const item of items) {
      const byName = fuzzyMatch(query, item.basename);
      const byPath = fuzzyMatch(query, item.path);
      const nameScore = Number.isFinite(byName.score) ? byName.score + BASENAME_BONUS : -Infinity;
      if (nameScore === -Infinity && !Number.isFinite(byPath.score)) continue;
      if (nameScore >= byPath.score) {
        matched.push({ item, score: nameScore, indices: byName.indices });
      } else {
        /* path 匹配赢 — UI 的 label 是 basename, 把落在 basename 段内的下标平移过去,
         * 路径段命中的下标丢弃 (sublabel 不做高亮, 丢了无害) */
        const offset = item.path.length - item.basename.length;
        const nameIndices = byPath.indices
          .filter((i) => i >= offset)
          .map((i) => i - offset);
        matched.push({ item, score: byPath.score, indices: nameIndices });
      }
    }
    matched.sort((a, b) => b.score - a.score);
    return matched.slice(0, limit).map(({ item, score, indices }): PaletteItem => ({
      kind: 'file',
      label: item.basename,
      sublabel: item.path,
      matchedIndices: indices,
      score,
      payload: { path: item.path, language: item.language },
    }));
  }

  /**
   * 模糊搜索符号。Cmd+T 的后端。
   *
   * 两阶段：
   *   1. SymbolStore.findSymbolsByNamePrefix() 快速收集候选（前缀匹配，SQL 走索引）
   *   2. FuzzyMatcher 对候选做二次精排
   *
   * 如果 query 太短（<2 字符），不走前缀，直接全量 + fuzzy（量大但 UI 会截断）
   */
  searchSymbols(query: string, limit = 50): PaletteItem[] {
    if (query.length === 0) return [];
    // IDEA DumbMode 等价: bootstrapping 状态下允许查询已索引的部分结果.
    // SymbolStore 的 SQL 查询本来就可以在写入中读取 (SQLite WAL 模式),
    // 用户打开 Find Usages / Cmd+T 时能看到"至今为止的结果", 好过空列表.
    // UI 侧通过 DumbModeContext 显示 "Indexing..." 提示告知结果可能不全.

    // Phase 1: 候选集合
    // 用 query 的首字符做一个 LIKE 前缀筛（大小写不敏感），限制候选规模
    const firstChar = query.charAt(0);
    const candidates = this.store.findSymbolsByNamePrefix(firstChar, 2000);

    // Phase 2: fuzzy 精排
    const matched = fuzzyFilter(query, candidates, (s) => s.name, {}, limit);
    return matched.map(({ item, result }): PaletteItem => ({
      kind: 'symbol',
      label: item.name,
      sublabel: item.containerName
        ? `${item.containerName} · ${item.filePath}`
        : item.filePath,
      matchedIndices: result.indices,
      score: result.score,
      payload: {
        symbolId: item.id,
        filePath: item.filePath,
        line: item.nameRange?.start.line ?? item.range.start.line,
        column: item.nameRange?.start.column ?? item.range.start.column,
        kind: item.kind,
        exported: item.exported,
        signature: item.signature,
      },
    }));
  }

  /**
   * 同一个 palette 查询同时搜文件和符号，按 score 合并。
   * Cmd+Shift+P 的"SearchEverywhere"入口。
   */
  searchPalette(query: string, limit = 50): PaletteItem[] {
    if (query.length === 0) return [];
    const files = this.searchFiles(query, limit);
    // bootstrapping 期也返回部分符号 —— UI 会展示 "incomplete" 提示
    const symbols = this.searchSymbols(query, limit);
    const all = [...files, ...symbols];
    all.sort((a, b) => b.score - a.score);
    return all.slice(0, limit);
  }

  /** 返回某个文件的所有符号 —— 文件 outline 面板用 */
  getFileOutline(filePath: string): SymbolInfo[] {
    const fileInfo = this.store.getFile(filePath);
    if (!fileInfo) return [];
    return this.store.getSymbolsInFile(fileInfo.id);
  }

  /** 按符号 id 拿完整 SymbolInfo —— 跳转后展示详情用 */
  getSymbolById(symbolId: number): SymbolInfo | undefined {
    return this.store.getSymbolById(symbolId);
  }

  /**
   * 按光标位置找覆盖该位置的最小符号 —— 精准 Hover / breadcrumbs 后端.
   *
   * 相比 `findSymbolsByName` 按字符串匹配, 这个 API 靠 range 精确命中,
   * 不怕同名符号的假阳性. 适合:
   *   - Monaco Hover provider: 显示当前光标下 "你在 class Foo 的 method bar 里"
   *   - Breadcrumbs bar: 逐层展开 containing symbols (可递归 parent_id)
   *   - "Select enclosing symbol" 操作
   *
   * 坐标约定: 0-based (对齐 tree-sitter / SymbolInput). UI 层从 Monaco 读到
   * 1-based 需要减 1.
   */
  findSymbolAtPosition(
    filePath: string,
    line: number,
    column: number,
  ): SymbolInfo | undefined {
    return this.store.findSymbolAtPosition(filePath, line, column);
  }

  /** Find Usages —— 某符号的所有引用点（按 symbol_refs 表，Phase 3 暂无数据） */
  getReferences(symbolId: number): ReferenceInfo[] {
    return this.store.getReferences(symbolId);
  }

  /**
   * Find Usages by name —— 按名字查所有 identifier 出现点。
   *
   * 这是 IDEA non-scoped "Find Usages" 的 Neox 等价实现 ——
   * 没有类型推断的情况下，按名字精确匹配全工程所有 identifier。
   */
  findUsagesByName(
    name: string,
    options?: { includeDeclarations?: boolean; limit?: number },
  ): IdentifierUsage[] {
    // Dumb 期也返回 (可能不全的) 结果. UI 通过 isSmart 决定是否展示 "incomplete"
    // 提示, 用 runWhenSmart 在 smart 后 rerun 拿完整结果.
    return this.store.findUsagesByName(name, options);
  }

  /** 所有已索引文件元数据 —— 调试 / 诊断面板用 */
  listIndexedFiles(): FileInfo[] {
    return this.store.getAllFiles();
  }

  listKnownFiles(): FileEntry[] {
    return this.fileIndex.all();
  }

  // --------------------------------------------------------------------------
  // 内部：单文件索引
  // --------------------------------------------------------------------------

  private async indexSingleFile(
    filePath: string,
    language: string,
    mtime: number,
  ): Promise<void> {
    if (this.disposed || this.lifecycleCtx.isCanceled) return;
    const parser = this.parsers.get(language);
    if (!parser) return;

    let content: string;
    try {
      content = await this.fs.readFile(filePath);
    } catch (err) {
      this.publisher().onError(`Read failed: ${filePath}`, { error: errorToString(err) });
      return;
    }


    const hash = simpleHash(content);
    // 如果 hash 也没变，彻底跳过 parse
    const existing = this.store.getFile(filePath);
    if (existing && existing.hash === hash) {
      return;
    }

    // Lazy init: 首次遇到这个 parser 才付 init 成本 (tree-sitter native load 等).
    await this.ensureParserInitialized(parser);
    if (this.disposed || this.lifecycleCtx.isCanceled) return;

    let parseResult;
    try {
      parseResult = await parser.parse({ path: filePath, content, language });
    } catch (err) {
      this.publisher().onError(`Parse failed: ${filePath}`, { error: errorToString(err) });
      return;
    }

    // parse 完可能已经过去几十 ms, service 可能已被 dispose. 跳过写 store
    // 以免 "insert into closed database" 报错.
    if (this.disposed || this.lifecycleCtx.isCanceled) return;

    try {
      this.store.indexFile(
        filePath,
        language,
        mtime,
        hash,
        parseResult.symbols,
        parseResult.usages ?? [],
      );
    } catch (err) {
      this.publisher().onError(`Store write failed: ${filePath}`, {
        error: errorToString(err),
      });
      return;
    }

    // 发事件 —— 订阅者（Outline 面板 / Monaco provider 缓存）据此刷新
    const fileInfo = this.store.getFile(filePath);
    if (fileInfo) {
      const symbols = this.store.getSymbolsInFile(fileInfo.id);
      this.publisher().onFileIndexed(filePath, symbols);
    }
  }

  // --------------------------------------------------------------------------
  // 内部：进度 / 状态
  // --------------------------------------------------------------------------

  private setState(s: IndexingState): void {
    this.state = s;
  }

  private snapshotProgress(): IndexingProgress {
    return {
      state: this.state,
      filesIndexed: this.filesIndexed,
      filesTotal: this.filesTotal,
      symbolsTotal: this.store.getSymbolCount(),
      error: this.bootstrapError,
    };
  }

  private maybeEmitProgress(currentFile: string): void {
    const now = Date.now();
    if (now - this.lastProgressEmit < this.progressThrottleMs) return;
    this.lastProgressEmit = now;
    const p = this.snapshotProgress();
    p.currentFile = currentFile;
    this.publisher().onProgress(p);
  }

  private publisher() {
    return this.bus.publisher(SEMANTIC_TOPIC);
  }
}

// ============================================================================
// 辅助
// ============================================================================

/**
 * 极简 "哈希" —— 用于快速判断内容是否变化。
 *
 * 不追求加密强度，只要分布均匀足以避免常见冲突即可。
 * 用了 FNV-1a 32位变种，纯 JS，对 MB 级文件也只要几毫秒。
 */
function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function errorToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
