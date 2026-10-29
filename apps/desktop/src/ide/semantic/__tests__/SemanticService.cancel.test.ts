/**
 * P3 regression test: SemanticService bootstrap cancel + lazy parser init.
 *
 * 覆盖:
 *  1. dispose() 触发 lifecycleCtx.cancel, 正在跑的 bootstrap 立即退 (state=idle)
 *  2. Parser 在 bootstrap 开始时不会 init —— 第一个 indexSingleFile 才 init
 *  3. Bootstrap 正常完成后 state=ready, 不被 cancel 打扰
 */
import { describe, it, expect, vi } from 'vitest';
import { SemanticService } from '../SemanticService.js';
import type { SemanticFileSystemPort } from '../SemanticService.js';
import type { LanguageParser, ParseInput, ParseResult } from '../parsers/Parser.js';
import type { SymbolInput } from '../symbolStore/SymbolStore.js';
import { MessageBus } from '../../bus/MessageBus.js';

/** In-memory store stub —— 只实现 SemanticService 实际用到的 API. */
function createStubStore() {
  const files = new Map<string, { id: number; path: string; language: string; mtime: number; hash: string }>();
  let nextId = 1;
  const indexedPaths: string[] = [];
  return {
    files,
    indexedPaths,
    getFile(path: string) {
      return files.get(path);
    },
    indexFile(path: string, language: string, mtime: number, hash: string, _syms: SymbolInput[], _usages: unknown[]) {
      if (!files.has(path)) {
        files.set(path, { id: nextId++, path, language, mtime, hash });
      }
      indexedPaths.push(path);
    },
    deleteFile() { /* not used */ },
    getSymbolsInFile() { return []; },
    getSymbolCount() { return 0; },
    getAllFiles() { return []; },
    findSymbolsByNamePrefix() { return []; },
    getReferences() { return []; },
    findUsagesByName() { return []; },
    getSymbolById() { return undefined; },
  } as any;
}

function createStubFs(fileList: Array<{ path: string; size: number; mtime: number; content: string }>): SemanticFileSystemPort {
  const map = new Map(fileList.map((f) => [f.path, f]));
  return {
    async walk() {
      return fileList.map((f) => ({ path: f.path, size: f.size, mtime: f.mtime }));
    },
    async readFile(p: string) {
      return map.get(p)?.content ?? '';
    },
    async stat(p: string) {
      const f = map.get(p);
      return f ? { size: f.size, mtime: f.mtime } : null;
    },
  };
}

class StubParser implements LanguageParser {
  readonly languages = ['typescript'] as const;
  initCallCount = 0;
  parseCallCount = 0;
  parseDelayMs = 0;
  async init(): Promise<void> {
    this.initCallCount += 1;
  }
  async parse(input: ParseInput): Promise<ParseResult> {
    this.parseCallCount += 1;
    if (this.parseDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.parseDelayMs));
    }
    return {
      symbols: [{
        name: `sym-${input.path}`,
        kind: 'function',
        range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
      }],
      hasErrors: false,
    };
  }
}

describe('SemanticService · P3 cancel + lazy init', () => {
  it('does not init parsers at bootstrap start', async () => {
    const store = createStubStore();
    const parser = new StubParser();
    const fs = createStubFs([]);  // empty workspace
    const parsers = new Map<string, LanguageParser>([['typescript', parser]]);
    const service = new SemanticService({
      workspaceRoot: '/ws',
      store,
      fs,
      bus: new MessageBus(),
      parsers,
    });

    await service.bootstrap();

    // no files → no parse → no init cost paid
    expect(parser.initCallCount).toBe(0);
    expect(parser.parseCallCount).toBe(0);
    expect(service.isReady()).toBe(true);
  });

  it('initializes parser on first indexSingleFile', async () => {
    const store = createStubStore();
    const parser = new StubParser();
    const fs = createStubFs([
      { path: '/ws/a.ts', size: 10, mtime: 1, content: 'export const a = 1' },
      { path: '/ws/b.ts', size: 10, mtime: 1, content: 'export const b = 2' },
    ]);
    const parsers = new Map<string, LanguageParser>([['typescript', parser]]);
    const service = new SemanticService({
      workspaceRoot: '/ws',
      store,
      fs,
      bus: new MessageBus(),
      parsers,
    });

    await service.bootstrap();

    // 2 files parsed, parser should have been init'd exactly once (lazy + idempotent)
    expect(parser.initCallCount).toBe(1);
    expect(parser.parseCallCount).toBe(2);
    expect(service.isReady()).toBe(true);
  });

  it('dispose during bootstrap stops further parsing', async () => {
    const store = createStubStore();
    const parser = new StubParser();
    parser.parseDelayMs = 20;  // 每次 parse 20ms, 确保有 cancel 窗口
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `/ws/file${i}.ts`,
      size: 10,
      mtime: 1,
      content: `// file ${i}`,
    }));
    const fs = createStubFs(files);
    const parsers = new Map<string, LanguageParser>([['typescript', parser]]);
    const service = new SemanticService({
      workspaceRoot: '/ws',
      store,
      fs,
      bus: new MessageBus(),
      parsers,
    });

    const bootstrapPromise = service.bootstrap();
    // Give bootstrap a chance to start (let it parse a few files)
    await new Promise((r) => setTimeout(r, 40));
    service.dispose();
    await bootstrapPromise;  // 应该 gracefully 退出, 不 reject

    // 应该 parse 了一部分后停下, 而不是全部 50 个
    expect(parser.parseCallCount).toBeLessThan(files.length);
    // state 被重置为 idle (canceled 不是 error)
    expect(service.isReady()).toBe(false);
  });

  it('dispose before bootstrap prevents any parse', async () => {
    const store = createStubStore();
    const parser = new StubParser();
    const files = [{ path: '/ws/a.ts', size: 10, mtime: 1, content: 'x' }];
    const parsers = new Map<string, LanguageParser>([['typescript', parser]]);
    const service = new SemanticService({
      workspaceRoot: '/ws',
      store,
      fs: createStubFs(files),
      bus: new MessageBus(),
      parsers,
    });

    service.dispose();
    await service.bootstrap();

    // 已 disposed, bootstrap 第一个 checkCanceled 就会退出
    expect(parser.parseCallCount).toBe(0);
  });

  it('parallel ensureParserInitialized calls share one init promise', async () => {
    // 通过多个小文件同时进入 indexSingleFile, 应该只触发一次 parser.init()
    const store = createStubStore();
    const parser = new StubParser();
    // 让 init 稍慢, 增加并发窗口
    const origInit = parser.init.bind(parser);
    parser.init = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return origInit();
    });
    const files = Array.from({ length: 8 }, (_, i) => ({
      path: `/ws/p${i}.ts`,
      size: 5,
      mtime: 1,
      content: `// ${i}`,
    }));
    const parsers = new Map<string, LanguageParser>([['typescript', parser]]);
    const service = new SemanticService({
      workspaceRoot: '/ws',
      store,
      fs: createStubFs(files),
      bus: new MessageBus(),
      parsers,
    });

    await service.bootstrap();
    // 8 个文件都 parse 了, 但 init 只应被调用 1 次
    expect(parser.initCallCount).toBe(1);
    expect(parser.parseCallCount).toBe(8);
  });
});
