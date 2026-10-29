import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeHome = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('node:os') as typeof import('node:os');
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'neox-kb-home-'));
});

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  return { ...real, default: { ...real, homedir: () => fakeHome }, homedir: () => fakeHome };
});
vi.mock('@neoxlabs/kernel/platform/cliLogger.js', () => ({
  cliLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { extractDocumentText, DocumentTextExtractionError, __clearDocTextCache } = await import('../docText.js');
const { knowledgeRegistry } = await import('../registry.js');
const { KnowledgeFtsIndex } = await import('../ftsIndex.js');
const { saveDocumentManifest } = await import('../documents.js');
const { createKnowledgeTools } = await import('../../tools/knowledgeTool.js');

afterAll(() => { fs.rmSync(fakeHome, { recursive: true, force: true }); });

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function makeWorkspaceWithDoc(content: string) {
  const ws = fs.mkdtempSync(path.join(fakeHome, 'ws-'));
  const file = path.join(ws, 'handbook.md');
  fs.writeFileSync(file, content);
  const stat = fs.statSync(file);
  saveDocumentManifest(path.join(ws, '.neox', 'knowledge'), [{
    id: 'doc1', name: 'handbook.md', path: file, size: stat.size, mtimeMs: stat.mtimeMs,
    collection: 'project', importedAt: Date.now(),
  }]);
  return { ws, file, stat };
}

beforeEach(() => { __clearDocTextCache(); });

describe.skipIf(isRoot)('docText', () => {
  it('读失败 → 抛 DocumentTextExtractionError (带原因), 且不缓存: 恢复后同一 mtime 能读到', async () => {
    const { file, stat } = makeWorkspaceWithDoc('reimbursement limit is 300 per day');
    fs.chmodSync(file, 0o000);
    try {
      await expect(extractDocumentText(file, stat.mtimeMs)).rejects.toBeInstanceOf(DocumentTextExtractionError);
      await expect(extractDocumentText(file, stat.mtimeMs)).rejects.toThrow(/handbook\.md: .*EACCES/);
    } finally {
      fs.chmodSync(file, 0o644);
    }
    expect(fs.statSync(file).mtimeMs).toBe(stat.mtimeMs);
    expect(await extractDocumentText(file, stat.mtimeMs)).toContain('reimbursement');
  });

  it('确实没有文本 (无解析缓存的 docx) → 返回空串, 不是失败', async () => {
    const { ws } = makeWorkspaceWithDoc('x');
    const docx = path.join(ws, 'contract.docx');
    fs.writeFileSync(docx, 'binary');
    expect(await extractDocumentText(docx, fs.statSync(docx).mtimeMs)).toBe('');
  });
});

describe.skipIf(isRoot)('knowledge_search', () => {
  it('内容读取失败 → 结果里明说哪个文件没读成; 恢复后下一次搜索就能按内容命中', async () => {
    const { ws, file } = makeWorkspaceWithDoc('reimbursement limit is 300 per day');
    const [search] = createKnowledgeTools({ workDir: ws });
    await knowledgeRegistry.refresh(ws);

    fs.chmodSync(file, 0o000);
    let out: string;
    try {
      out = await search.function({ query: 'reimbursement' });
    } finally {
      fs.chmodSync(file, 0o644);
    }
    expect(out).toMatch(/没有命中/);
    expect(out).toMatch(/handbook\.md: .*EACCES/);

    const recovered = await search.function({ query: 'reimbursement' });
    expect(recovered).toMatch(/命中 1 条/);
    expect(recovered).not.toMatch(/没能读取/);
  });
});

describe.skipIf(isRoot)('FTS 索引', () => {
  it('抽取失败的文档不带真签名落盘 → 下次 sync 重抽', async () => {
    const { ws, file, stat } = makeWorkspaceWithDoc('reimbursement limit is 300 per day');
    const index = new KnowledgeFtsIndex(path.join(ws, 'fts.db'));
    const doc = {
      id: 'doc1', name: 'handbook.md', path: file, size: stat.size, mtimeMs: stat.mtimeMs,
      collection: 'project' as const, importedAt: Date.now(), missing: false, modified: false,
    };
    try {
      fs.chmodSync(file, 0o000);
      let first;
      try { first = await index.sync([], [doc]); } finally { fs.chmodSync(file, 0o644); }
      expect(first.failures).toHaveLength(1);
      expect(index.search('reimbursement')).toHaveLength(0);

      const second = await index.sync([], [doc]);
      expect(second.upserted).toBe(1);
      expect(second.failures).toHaveLength(0);
      expect(index.search('reimbursement')).toHaveLength(1);
    } finally {
      index.close();
    }
  });
});
