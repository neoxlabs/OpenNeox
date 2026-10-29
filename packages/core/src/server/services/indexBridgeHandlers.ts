import type { RuntimeBridge } from '../index.js';
import { createIndexManager, type IndexManager } from '../../tools/smart-read/indexManager.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';

function resolveExcludePatterns(): string[] | undefined {
  try {
    const pats = loadConfig()?.indexing?.excludePatterns;
    if (!Array.isArray(pats) || pats.length === 0) return undefined;
    const out = new Set<string>();
    for (const raw of pats) {
      const s = String(raw ?? '').trim();
      if (!s) continue;
      out.add(s);
      if (!s.startsWith('**/') && !s.startsWith('/')) out.add(`**/${s}`);
    }
    return out.size > 0 ? [...out] : undefined;
  } catch {
    return undefined;
  }
}

type IndexBridgeMethods = Pick<
  RuntimeBridge,
  'getIndexStats' | 'buildIndex' | 'clearIndex' | 'searchIndex'
>;

interface CreateIndexBridgeHandlersOptions {
  workDir: string;
}

export function createIndexBridgeHandlers(options: CreateIndexBridgeHandlersOptions): IndexBridgeMethods {
  const { workDir } = options;
  let indexMgr: IndexManager | null = null;
  /* 排除规则改了要立刻生效 —— manager 是缓存的, 光缓存一次就等于"改了要重启才算数"。
   * 用规则本身当 key, 变了就重建 manager。 */
  let mgrExcludeKey: string | null = null;

  const getManager = (): IndexManager => {
    const exclude = resolveExcludePatterns();
    const key = (exclude ?? []).join('\n');
    if (!indexMgr || key !== mgrExcludeKey) {
      indexMgr = createIndexManager(workDir, exclude ? { exclude } : undefined);
      mgrExcludeKey = key;
    }
    return indexMgr;
  };

  return {
    async getIndexStats() {
      const stats = await getManager().getStats();
      return {
        hasIndex: stats.hasIndex,
        fileCount: stats.fileCount,
        symbolCount: stats.symbolCount,
        lastUpdated: stats.lastUpdated?.toISOString() ?? null,
        size: stats.size,
      };
    },

    async buildIndex(force?: boolean) {
      return getManager().buildIndex({ force });
    },

    async clearIndex() {
      await getManager().clear();
    },

    async searchIndex(query: string, kind?: string, limit?: number) {
      const results = await getManager().searchSymbol({
        query,
        kind: kind as any,
        limit: limit || 20,
        fuzzy: true,
      });

      return results.map((r: any) => ({
        symbol: {
          name: r.symbol.name,
          kind: r.symbol.kind,
          startLine: r.symbol.startLine,
          endLine: r.symbol.endLine,
          signature: r.symbol.signature,
          docstring: r.symbol.docstring,
          parent: r.symbol.parent,
        },
        file: r.file,
        score: r.score,
      }));
    },
  };
}
