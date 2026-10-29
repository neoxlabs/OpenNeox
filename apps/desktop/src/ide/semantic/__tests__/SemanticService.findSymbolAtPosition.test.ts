/**
 * SemanticService.findSymbolAtPosition —— delegation 测试.
 * SQL 的正确性由 SymbolStore 层覆盖 (与 better-sqlite3 集成过于重, 这里
 * 只 mock store 确认 service 层正确 forward 坐标 + 返回值).
 */
import { describe, it, expect, vi } from 'vitest';
import { SemanticService } from '../SemanticService.js';
import type { SymbolInfo } from '../types.js';
import { MessageBus } from '../../bus/MessageBus.js';

function makeSymbol(name: string): SymbolInfo {
  return {
    id: 1,
    filePath: '/ws/a.ts',
    fileLanguage: 'typescript',
    name,
    kind: 'function',
    range: { start: { line: 10, column: 0 }, end: { line: 20, column: 1 } },
    exported: true,
    containerName: undefined,
    signature: undefined,
    documentation: undefined,
    parentId: undefined,
    modifiers: undefined,
    nameRange: undefined,
  } as unknown as SymbolInfo;
}

function createService(storeOverrides: Partial<Record<string, any>> = {}) {
  const store: any = {
    getFile: () => undefined,
    indexFile: () => ({ fileId: 1, symbolIds: [] }),
    deleteFile: () => {},
    getSymbolsInFile: () => [],
    getSymbolCount: () => 0,
    getAllFiles: () => [],
    findSymbolsByNamePrefix: () => [],
    getReferences: () => [],
    findUsagesByName: () => [],
    getSymbolById: () => undefined,
    findSymbolAtPosition: vi.fn(() => undefined),
    ...storeOverrides,
  };

  const service = new SemanticService({
    workspaceRoot: '/ws',
    store,
    fs: {
      async walk() { return []; },
      async readFile() { return ''; },
      async stat() { return null; },
    },
    bus: new MessageBus(),
    parsers: new Map(),
  });

  return { service, store };
}

describe('SemanticService.findSymbolAtPosition', () => {
  it('forwards (path, line, column) to store', () => {
    const { service, store } = createService();
    service.findSymbolAtPosition('/ws/a.ts', 15, 5);
    expect(store.findSymbolAtPosition).toHaveBeenCalledWith('/ws/a.ts', 15, 5);
  });

  it('returns whatever store returns', () => {
    const sym = makeSymbol('foo');
    const { service } = createService({
      findSymbolAtPosition: vi.fn(() => sym),
    });
    expect(service.findSymbolAtPosition('/ws/a.ts', 15, 5)).toBe(sym);
  });

  it('undefined passes through', () => {
    const { service } = createService();
    expect(service.findSymbolAtPosition('/ws/nope.ts', 0, 0)).toBeUndefined();
  });
});
