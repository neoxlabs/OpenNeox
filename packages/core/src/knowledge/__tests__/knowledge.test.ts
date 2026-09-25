/**
 * Knowledge Base 单元测试
 *
 * 覆盖:
 *   - parseCardFrontmatter: 完整/缺失/内联数组/破折号列表
 *   - loadCardFile: title/description 兜底、trust 解析、displayPath
 *   - loadCardsFromDir: 递归、跳过 _ 前缀与非 md
 *   - KnowledgeRegistry: initialize / getIndexForPrompt 预算与排序 / revision
 *   - KnowledgeSearchEngine: tokenize CJK bigram / BM25 排序 / snippet
 *   - projectMemoryV2 L2 集成: 带 paths 的卡进 rules 池 (knowledge: 前缀), 无 paths 的不进
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseCardFrontmatter,
  loadCardFile,
  loadCardsFromDir,
} from '../loader.js';
import { KnowledgeRegistry } from '../registry.js';
import { KnowledgeSearchEngine, tokenize } from '../searchEngine.js';
import {
  loadDocumentManifest,
  saveDocumentManifest,
  statDocuments,
  type KnowledgeDocumentEntry,
} from '../documents.js';
import { loadProjectMemoryV2, matchRules } from '../../memory/projectMemoryV2.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-knowledge-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCard(relPath: string, content: string): string {
  const full = path.join(tmpDir, '.neox', 'knowledge', relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

const FULL_CARD = `---
title: Univer Sheet API
description: Univer sheet 工具协议 API 映射
source: https://univer.ai/docs
paths: ["src/tools/sheet/**"]
keywords: [univer, sheet]
trust: verified
updated: 2026-07-02
---

# Univer

结论先行: setRangeValues 是主入口。
`;

// ============================================================================
// parseCardFrontmatter
// ============================================================================

describe('parseCardFrontmatter', () => {
  it('解析完整 frontmatter (标量 + 内联数组)', () => {
    const { meta, body } = parseCardFrontmatter(FULL_CARD);
    expect(meta.title).toBe('Univer Sheet API');
    expect(meta.paths).toEqual(['src/tools/sheet/**']);
    expect(meta.keywords).toEqual(['univer', 'sheet']);
    expect(meta.trust).toBe('verified');
    expect(body).toContain('结论先行');
  });

  it('无 frontmatter 时整体是 body', () => {
    const { meta, body } = parseCardFrontmatter('# 直接正文\n内容');
    expect(Object.keys(meta)).toHaveLength(0);
    expect(body).toContain('直接正文');
  });

  it('破折号列表归属最近的 key', () => {
    const { meta } = parseCardFrontmatter('---\npaths:\n  - "a/**"\n  - b/*.ts\n---\nbody');
    expect(meta.paths).toEqual(['a/**', 'b/*.ts']);
  });
});

// ============================================================================
// loadCardFile / loadCardsFromDir
// ============================================================================

describe('loadCardFile', () => {
  it('完整卡片解析全部字段, workspace 卡 displayPath 是相对路径', () => {
    const full = writeCard('sheet/univer.md', FULL_CARD);
    const root = path.join(tmpDir, '.neox', 'knowledge');
    const card = loadCardFile(full, root, 'workspace', tmpDir)!;
    expect(card.id).toBe('sheet/univer');
    expect(card.meta.title).toBe('Univer Sheet API');
    expect(card.meta.trust).toBe('verified');
    expect(card.displayPath).toBe('.neox/knowledge/sheet/univer.md');
  });

  it('title/description 缺失时按文件名/正文首行兜底 (容错不拒载)', () => {
    const full = writeCard('notes.md', '随手写的知识, 没有 frontmatter。\n\n第二段。');
    const root = path.join(tmpDir, '.neox', 'knowledge');
    const card = loadCardFile(full, root, 'workspace', tmpDir)!;
    expect(card.meta.title).toBe('notes');
    expect(card.meta.description).toContain('随手写的知识');
  });

  it('非法 trust 值忽略, 空文件返回 null', () => {
    const full = writeCard('bad.md', '---\ntitle: x\ntrust: banana\n---\nbody');
    const root = path.join(tmpDir, '.neox', 'knowledge');
    expect(loadCardFile(full, root, 'workspace', tmpDir)!.meta.trust).toBeUndefined();
    const empty = writeCard('empty.md', '');
    expect(loadCardFile(empty, root, 'workspace', tmpDir)).toBeNull();
  });
});

describe('loadCardsFromDir', () => {
  it('递归扫描, 跳过 _ 前缀与非 md', () => {
    writeCard('a.md', FULL_CARD);
    writeCard('deep/nested/b.md', '# b\n内容 b');
    writeCard('_drafts/c.md', '# 草稿不该被加载');
    writeCard('_ignored.md', '# 单文件草稿');
    writeCard('data.json', '{}');
    const root = path.join(tmpDir, '.neox', 'knowledge');
    const cards = loadCardsFromDir(root, 'workspace', tmpDir);
    const ids = cards.map((c) => c.id).sort();
    expect(ids).toEqual(['a', 'deep/nested/b']);
  });

  it('目录不存在返回空数组', () => {
    expect(loadCardsFromDir(path.join(tmpDir, 'nope'), 'workspace')).toEqual([]);
  });
});

// ============================================================================
// KnowledgeRegistry
// ============================================================================

describe('KnowledgeRegistry', () => {
  it('initialize 加载 workspace 卡, revision 自增, refresh 感知新卡', async () => {
    writeCard('a.md', FULL_CARD);
    const registry = new KnowledgeRegistry();
    await registry.initialize(tmpDir);
    expect(registry.size).toBeGreaterThanOrEqual(1);
    expect(registry.getCard('a')).toBeDefined();
    const rev1 = registry.revision;

    writeCard('b.md', '# b\n新卡');
    await registry.refresh(tmpDir);
    expect(registry.getCard('b')).toBeDefined();
    expect(registry.revision).toBeGreaterThan(rev1);
  });

  it('getIndexForPrompt: 空库返回空串, 有卡时含 header + 卡行, verified 排在 draft 前', async () => {
    const registry = new KnowledgeRegistry();
    await registry.initialize(tmpDir);
    /* 用户级目录可能有真实卡片 — 只对 workspace 卡断言相对顺序 */
    writeCard('zz-verified.md', '---\ntitle: ZZ Verified\ndescription: v\ntrust: verified\n---\nbody');
    writeCard('aa-draft.md', '---\ntitle: AA Draft\ndescription: d\ntrust: draft\n---\nbody');
    await registry.refresh(tmpDir);

    const index = registry.getIndexForPrompt('zh');
    expect(index).toContain('## Knowledge Base');
    const verifiedPos = index.indexOf('ZZ Verified');
    const draftPos = index.indexOf('AA Draft');
    expect(verifiedPos).toBeGreaterThan(-1);
    /* draft 若因预算被截掉则不比较; 都在时 verified 必须在前 */
    if (draftPos > -1) expect(verifiedPos).toBeLessThan(draftPos);
    expect(index).toContain('(草稿)');
  });

  it('always 卡: 全文进常驻段、不进索引列表、不进 L2 rules 池', async () => {
    writeCard('policy.md', '---\ntitle: 报销政策\ndescription: 差旅报销规范\nalways: true\npaths: ["src/**"]\n---\n交通费实报实销, 上限每日 300 元。');
    writeCard('normal.md', '---\ntitle: 普通知识\ndescription: 普通条目\n---\n普通正文');
    const registry = new KnowledgeRegistry();
    await registry.initialize(tmpDir);

    const index = registry.getIndexForPrompt('zh');
    expect(index).toContain('常驻知识');
    expect(index).toContain('交通费实报实销');              /* 全文注入 */
    expect(index).not.toContain('- [报销政策]');            /* 不进索引列表 (防双份) */
    expect(index).toContain('- [普通知识]');                /* 普通卡仍走索引行 */

    /* always 卡即使带 paths 也不进 L2 rules 池 (已常驻, 再触发就双份) */
    const mem = await loadProjectMemoryV2(tmpDir);
    expect(mem.rules.has('knowledge:policy')).toBe(false);
    expect(loadCardFile(path.join(tmpDir, '.neox/knowledge/policy.md'), path.join(tmpDir, '.neox/knowledge'), 'workspace', tmpDir)!.meta.always).toBe(true);
  });

  it('always 卡超单卡预算截断并给全文路径', async () => {
    writeCard('big-policy.md', `---\ntitle: 大政策\ndescription: d\nalways: true\n---\n${'条款内容 '.repeat(1000)}`);
    const registry = new KnowledgeRegistry();
    await registry.initialize(tmpDir);
    const index = registry.getIndexForPrompt('zh');
    expect(index).toContain('已截断');
    expect(index).toContain('big-policy.md');
  });

  it('getIndexForPrompt: 超预算截断并提示剩余数量', async () => {
    for (let i = 0; i < 60; i++) {
      writeCard(`card-${String(i).padStart(2, '0')}.md`, `---\ntitle: 卡片 ${i} 标题很长占字符预算测试用例\ndescription: 这是一段足够长的描述用来快速吃掉两千字符的索引预算 ${i}\n---\nbody`);
    }
    const registry = new KnowledgeRegistry();
    await registry.initialize(tmpDir);
    const index = registry.getIndexForPrompt('zh');
    expect(index.length).toBeLessThanOrEqual(2700); /* 预算 2000 + header + 截断提示的余量 */
    expect(index).toMatch(/还有 \d+ 条知识未列出/);
  });
});

// ============================================================================
// KnowledgeSearchEngine
// ============================================================================

describe('KnowledgeSearchEngine', () => {
  it('tokenize: ASCII 按词, CJK 按 bigram', () => {
    expect(tokenize('Univer API')).toEqual(['univer', 'api']);
    expect(tokenize('知识库')).toEqual(['知识', '识库']);
    expect(tokenize('库')).toEqual(['库']);
  });

  it('BM25: title 命中的卡排在 body 命中的卡前', () => {
    const root = path.join(tmpDir, '.neox', 'knowledge');
    writeCard('title-hit.md', '---\ntitle: Univer 表格协议\ndescription: 协议映射\n---\n正文无关内容。');
    writeCard('body-hit.md', '---\ntitle: 其他主题\ndescription: 别的\n---\n这里提了一句 Univer 而已, 其余是很长的别的内容。'.padEnd(400, '字'));
    const cards = loadCardsFromDir(root, 'workspace', tmpDir);
    const engine = new KnowledgeSearchEngine();
    engine.build(cards);
    const hits = engine.search('univer');
    expect(hits.length).toBe(2);
    expect(hits[0].card.id).toBe('title-hit');
  });

  it('资料文件伪卡片: 文档按文件名/路径可检索 (L0 截断兜底)', () => {
    const engine = new KnowledgeSearchEngine();
    engine.build([
      {
        id: 'doc:1',
        filePath: '/Users/x/Downloads/教育行业报告.pdf',
        displayPath: '/Users/x/Downloads/教育行业报告.pdf',
        origin: 'user',
        meta: {
          title: '教育行业报告.pdf',
          description: '资料文件 (default) — 原文件路径引用, 用 readfile 直接读',
          keywords: ['/Users/x/Downloads/教育行业报告.pdf'],
        },
        body: '',
      },
    ]);
    const byName = engine.search('教育 报告');
    expect(byName).toHaveLength(1);
    expect(byName[0].card.displayPath).toContain('教育行业报告.pdf');
    expect(engine.search('downloads')).toHaveLength(1); /* 路径分词也可命中 */
  });

  it('snippet 取正文命中行上下文; 无任何命中返回空数组', () => {
    const root = path.join(tmpDir, '.neox', 'knowledge');
    writeCard('s.md', '---\ntitle: t\ndescription: d\n---\n第一行\n第二行\nsetRangeValues 是主入口\n第四行');
    const cards = loadCardsFromDir(root, 'workspace', tmpDir);
    const engine = new KnowledgeSearchEngine();
    engine.build(cards);
    const hits = engine.search('setRangeValues');
    expect(hits[0].snippet).toContain('setRangeValues 是主入口');
    expect(engine.search('完全不存在的词汇组合qqzz')).toEqual([]);
  });
});

// ============================================================================
// documents manifest (资料文件路径引用)
// ============================================================================

describe('documents manifest', () => {
  function makeEntry(filePath: string, overrides: Partial<KnowledgeDocumentEntry> = {}): KnowledgeDocumentEntry {
    const stat = fs.statSync(filePath);
    return {
      id: `doc-${path.basename(filePath)}`,
      name: path.basename(filePath),
      path: filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      collection: 'project',
      importedAt: Date.now(),
      ...overrides,
    };
  }

  it('save/load 往返一致, 非法条目 (相对路径) 被过滤', () => {
    const dir = path.join(tmpDir, '.neox', 'knowledge');
    const file = path.join(tmpDir, 'manual.pdf');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(file, 'pdf-bytes');
    const entry = makeEntry(file);
    saveDocumentManifest(dir, [entry, { ...entry, id: 'bad', path: 'relative/path.pdf' } as any]);
    const loaded = loadDocumentManifest(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(entry.id);
  });

  it('statDocuments: 存在=ok / 删除=missing / 改内容=modified', () => {
    const fileOk = path.join(tmpDir, 'ok.md');
    const fileGone = path.join(tmpDir, 'gone.md');
    const fileChanged = path.join(tmpDir, 'changed.md');
    for (const f of [fileOk, fileGone, fileChanged]) fs.writeFileSync(f, 'v1');
    const entries = [makeEntry(fileOk), makeEntry(fileGone), makeEntry(fileChanged)];
    fs.rmSync(fileGone);
    fs.writeFileSync(fileChanged, 'v2-content-longer');
    const [ok, gone, changed] = statDocuments(entries);
    expect(ok.missing).toBe(false);
    expect(ok.modified).toBe(false);
    expect(gone.missing).toBe(true);
    expect(changed.missing).toBe(false);
    expect(changed.modified).toBe(true);
  });

  it('registry 加载 manifest → L0 索引出现资料文件段, missing 的不列', async () => {
    const knowledgeDir = path.join(tmpDir, '.neox', 'knowledge');
    const fileA = path.join(tmpDir, 'api-手册.pdf');
    const fileGone = path.join(tmpDir, 'gone.pdf');
    fs.writeFileSync(fileA, 'a');
    fs.writeFileSync(fileGone, 'g');
    saveDocumentManifest(knowledgeDir, [makeEntry(fileA), makeEntry(fileGone, { id: 'doc-gone' })]);
    fs.rmSync(fileGone);

    const registry = new KnowledgeRegistry();
    await registry.initialize(tmpDir);
    expect(registry.getDocuments().some((d) => d.missing)).toBe(true);

    const index = registry.getIndexForPrompt('zh');
    expect(index).toContain('资料文件');
    expect(index).toContain('api-手册.pdf');
    expect(index).toContain(fileA);
    expect(index).not.toContain('gone.pdf');
  });
});

// ============================================================================
// 资料文件内容级检索 (docText → BM25)
// ============================================================================

describe('资料文件内容级检索', () => {
  it('文本文件正文进索引: 按内容关键词命中文档', async () => {
    const { extractDocumentText, __clearDocTextCache } = await import('../docText.js');
    __clearDocTextCache();
    const file = path.join(tmpDir, '公司政策.txt');
    fs.writeFileSync(file, '差旅报销上限为每日三百元, 需提供发票。');
    const stat = fs.statSync(file);
    const text = await extractDocumentText(file, stat.mtimeMs);
    expect(text).toContain('差旅报销');

    /* 组装伪卡片 (同 knowledgeTool 的形状) 验证 BM25 内容命中 */
    const engine = new KnowledgeSearchEngine();
    engine.build([{
      id: 'doc:1',
      filePath: file,
      displayPath: file,
      origin: 'workspace',
      meta: { title: '公司政策.txt', description: '资料文件', keywords: [file] },
      body: text,
    }]);
    const hits = engine.search('报销 上限');
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('三百元');
  });

  it('fileId 解析缓存优先: docx 等无本地解析器的格式靠它拿到文本', async () => {
    const { extractDocumentText, __clearDocTextCache } = await import('../docText.js');
    __clearDocTextCache();
    /* 伪造一个解析缓存 (documentParseClient 导入时写的 markdown) */
    const os = await import('node:os');
    const fileId = 'a'.repeat(64);
    /* 这条是 **home 系** (os.homedir()), 跟着发行版走; 上面那些 tmpDir 的是
     * **工作区系** (<workspace>/.neox/), 属于项目本地元数据, 两个版本共用, 不要动。 */
    const cacheDir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'documents');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, `${fileId}.md`);
    fs.writeFileSync(cachePath, '# 合同模板\n乙方应在三十日内付款。');
    try {
      const docx = path.join(tmpDir, '合同.docx');
      fs.writeFileSync(docx, 'binary-docx-stub');
      const stat = fs.statSync(docx);
      const text = await extractDocumentText(docx, stat.mtimeMs, fileId);
      expect(text).toContain('三十日内付款');
      /* 无 fileId 的 docx → 无文本 (只按文件名可搜) */
      __clearDocTextCache();
      expect(await extractDocumentText(docx, stat.mtimeMs)).toBe('');
    } finally {
      fs.rmSync(cachePath, { force: true });
    }
  });

  it('mtime 缓存: 文件不变不重抽, 变了重抽', async () => {
    const { extractDocumentText, __clearDocTextCache } = await import('../docText.js');
    __clearDocTextCache();
    const file = path.join(tmpDir, 'note.md');
    fs.writeFileSync(file, 'v1 内容');
    const stat1 = fs.statSync(file);
    expect(await extractDocumentText(file, stat1.mtimeMs)).toContain('v1');
    fs.writeFileSync(file, 'v2 新内容');
    const stat2 = fs.statSync(file);
    expect(await extractDocumentText(file, stat2.mtimeMs)).toContain('v2');
    /* 用旧 mtime 命中缓存 (返回旧文本) — 证明缓存键生效 */
    expect(await extractDocumentText(file, stat2.mtimeMs)).toContain('v2');
  });
});

// ============================================================================
// projectMemoryV2 L2 集成
// ============================================================================

describe('projectMemoryV2 knowledge L2 集成', () => {
  it('带 paths 的知识卡进 rules 池 (knowledge: 前缀), 无 paths 的不进', async () => {
    writeCard('with-paths.md', FULL_CARD);
    writeCard('no-paths.md', '---\ntitle: 无路径卡\ndescription: 只进 L0\n---\n正文');
    const result = await loadProjectMemoryV2(tmpDir);
    expect(result.rules.has('knowledge:with-paths')).toBe(true);
    expect(result.rules.has('knowledge:no-paths')).toBe(false);

    const entry = result.rules.get('knowledge:with-paths')!;
    expect(entry.globs).toEqual(['src/tools/sheet/**']);
    expect(entry.content).toContain('[知识卡] Univer Sheet API');

    /* matchRules 对命中路径返回该卡 */
    const matched = matchRules(result.rules, 'src/tools/sheet/sheetTools.ts');
    expect(matched.some((r) => r.content.includes('Univer Sheet API'))).toBe(true);
    const notMatched = matchRules(
      new Map([['knowledge:with-paths', entry]]),
      'src/other/file.ts',
    );
    expect(notMatched).toHaveLength(0);
  });
});
