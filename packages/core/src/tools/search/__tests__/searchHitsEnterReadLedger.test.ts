/**
 * Lines shown by search enter the read ledger as contiguous ranges, so edit
 * coherence treats the displayed source as fresh input.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildSearchContentOutput } from '../contentSearchOutput.js';
import { checkCoherence, runWithReadScope, getFileReads } from '../../smart-read/readLedger.js';

describe('search 展示的行进读账本', () => {
  it('展示过的连续块登记为 S:<start>-<end>, edit 的一致性诊断判 fresh', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-search-ledger-'));
    try {
      const file = path.join(dir, 'a.ts');
      await fs.writeFile(file, ['l1', 'import { IdeError } from "./x.js";', 'l3', 'l4', 'l5', 'l6'].join('\n') + '\n');
      const st = await fs.stat(file);
      await runWithReadScope('t-search-ledger', async () => {
        const out = await buildSearchContentOutput({
          querySummary: 'IdeError', displayPath: dir, shouldRecurse: false, resolvedFrom: 'workspace',
          caseInsensitive: false, shouldUseRipgrep: false, filesSearched: 1, filesWithMatches: 1,
          totalMatches: 2, maxMatches: 50, countOnly: false,
          results: [{
            file, matchCount: 2,
            matches: [
              { lineNum: 1, line: 'l1', isMatch: false },
              { lineNum: 2, line: 'import { IdeError } from "./x.js";', isMatch: true },
              { lineNum: 3, line: 'l3', isMatch: false },
              { lineNum: 6, line: 'l6', isMatch: true },
            ],
          }],
          readHints: [],
          formatDisplayPath: (p) => path.relative(dir, p),
          throwIfAborted: () => {},
          yieldToEventLoop: async () => {},
        });
        expect(out).toContain('import { IdeError }');
        const reads = getFileReads(path.resolve(file));
        expect(reads.map((r) => r.rangeKey).sort()).toEqual(['S:1-3', 'S:6-6']);
        expect(reads.find((r) => r.rangeKey === 'S:1-3')?.content).toBe('l1\nimport { IdeError } from "./x.js";\nl3');
        expect(checkCoherence(path.resolve(file), st.mtimeMs, st.size).state).toBe('fresh');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
