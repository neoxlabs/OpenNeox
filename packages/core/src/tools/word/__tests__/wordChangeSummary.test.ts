/**
 * work:Q-10 改稿的段落级前后对照
 * ═══════════════════════════════════════════════════════════════════════
 * 回执要能写「原文 → 改为」, 而且必须跟文件里的真实内容一致。所以对照不是模型说的,
 * 是工具在写盘前后各抽一遍段落文本比出来的 (wordChangeSummary)。
 *
 * 这里锁三件事:
 *   1. 对比算法: 改写 / 新增 / 删除 / 多段替换 各归各位;
 *   2. 工具真的把 changes 带回来, 且 before/after 与保存后的文件逐字一致;
 *   3. 没改动就不带空 changes。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWithWorkspaceRoot } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { wordCreateTool } from '../wordCreateTool.js';
import { wordEditParagraphTool, wordReplaceTextTool, wordDeleteParagraphTool, wordInsertParagraphTool } from '../wordTools.js';
import { extractParagraphs, loadDocx } from '../wordOoxml.js';
import { diffParagraphTexts, summarizeDocxChanges, MAX_CHANGES_PER_RESULT } from '../wordChangeSummary.js';

describe('diffParagraphTexts', () => {
  it('一段换一段 = 改写, 前后都填', () => {
    expect(diffParagraphTexts(['标题', '本周营收 1280 万', '下周计划'], ['标题', '本周营收 2750 万', '下周计划']))
      .toEqual([{ index: 1, before: '本周营收 1280 万', after: '本周营收 2750 万' }]);
  });

  it('插入一段: before 为空, index 是改后段号', () => {
    expect(diffParagraphTexts(['A', 'C'], ['A', 'B', 'C']))
      .toEqual([{ index: 1, before: '', after: 'B' }]);
  });

  it('删掉一段: after 为空, 带着原文', () => {
    expect(diffParagraphTexts(['A', 'B', 'C'], ['A', 'C']))
      .toEqual([{ index: 1, before: 'B', after: '' }]);
  });

  it('两段并成一段 / 一段拆成两段', () => {
    expect(diffParagraphTexts(['A', 'B'], ['AB'])).toEqual([{ index: 0, before: 'A', after: 'AB' }, { index: 1, before: 'B', after: '' }]);
    expect(diffParagraphTexts(['AB'], ['A', 'B'])).toEqual([{ index: 0, before: 'AB', after: 'A' }, { index: 1, before: '', after: 'B' }]);
  });

  it('没改动就是空列表; 空段落的增删不算改动', () => {
    expect(diffParagraphTexts(['A', 'B'], ['A', 'B'])).toEqual([]);
    expect(diffParagraphTexts(['A', '', 'B'], ['A', 'B'])).toEqual([]);
  });

  it('段落很多时走按下标对比, 也能给出对照', () => {
    const before = Array.from({ length: 700 }, (_, i) => `第 ${i} 段`);
    const after = [...before];
    after[3] = '改过的第 3 段';
    expect(diffParagraphTexts(before, after)).toEqual([{ index: 3, before: '第 3 段', after: '改过的第 3 段' }]);
  });
});

describe('summarizeDocxChanges', () => {
  const doc = (texts: string[]) => `<w:document xmlns:w="w"><w:body>${texts.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;

  it('从 XML 抽出段落再比, 结果就是文件里的文字', () => {
    expect(summarizeDocxChanges(doc(['周报', '营收 100 万']), doc(['周报', '营收 120 万'])))
      .toEqual([{ index: 1, before: '营收 100 万', after: '营收 120 万' }]);
  });

  it('最多带 MAX_CHANGES_PER_RESULT 条', () => {
    const before = Array.from({ length: 20 }, (_, i) => `旧 ${i}`);
    const after = Array.from({ length: 20 }, (_, i) => `新 ${i}`);
    expect(summarizeDocxChanges(doc(before), doc(after))).toHaveLength(MAX_CHANGES_PER_RESULT);
  });
});

describe('word 工具返回值里的 changes', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-wordchange-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const makeDoc = async (name: string, content: string): Promise<string> => {
    const file = path.join(dir, name);
    await runWithWorkspaceRoot(dir, () => (wordCreateTool.function as any)({
      save_path: file, content, title: '周报', overwrite: true,
    }));
    return file;
  };
  const call = async (tool: { function: unknown }, args: Record<string, unknown>) =>
    JSON.parse(String(await runWithWorkspaceRoot(dir, () => (tool.function as any)(args))));
  const paragraphsOf = async (file: string) =>
    extractParagraphs((await loadDocx(file, dir)).documentXml).map((p) => p.text);

  it('word_edit_paragraph: 带回原文和改后文字, 与保存后的文件一致', async () => {
    const file = await makeDoc('edit.docx', '# 周报\n\n本周营收 100 万\n\n下周计划');
    const before = await paragraphsOf(file);
    const target = before.findIndex((t) => t.includes('本周营收'));
    const r = await call(wordEditParagraphTool, { file_path: file, index: target, new_text: '本周营收 120 万' });
    expect(r.ok).toBe(true);
    expect(r.changes).toEqual([{ index: target, before: before[target], after: '本周营收 120 万' }]);
    /* 与真实文件 diff 一致 */
    expect((await paragraphsOf(file))[target]).toBe(r.changes[0].after);
  });

  it('word_replace_text: 带回被替换那一段的前后', async () => {
    const file = await makeDoc('replace.docx', '# 周报\n\n本周营收 100 万');
    const r = await call(wordReplaceTextTool, { file_path: file, find: '100 万', replace: '120 万' });
    expect(r.ok).toBe(true);
    expect(r.replaced_count).toBe(1);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].before).toContain('100 万');
    expect(r.changes[0].after).toContain('120 万');
  });

  it('word_delete_paragraph / word_insert_paragraph: 删除带原文, 新增 after 有字', async () => {
    const file = await makeDoc('del.docx', '# 周报\n\n要删的一段\n\n留着');
    const before = await paragraphsOf(file);
    const target = before.findIndex((t) => t === '要删的一段');
    const del = await call(wordDeleteParagraphTool, { file_path: file, index: target });
    expect(del.changes).toEqual([{ index: target, before: '要删的一段', after: '' }]);

    const ins = await call(wordInsertParagraphTool, { file_path: file, after_index: 0, new_text: '新增的一段' });
    expect(ins.changes?.[0]?.after).toBe('新增的一段');
    expect(ins.changes?.[0]?.before).toBe('');
  });

  it('没改动 (替换成同样的字) 时不带空 changes', async () => {
    const file = await makeDoc('same.docx', '# 周报\n\n本周营收 100 万');
    const r = await call(wordReplaceTextTool, { file_path: file, find: '100 万', replace: '100 万' });
    expect(r.ok).toBe(true);
    expect(r.changes).toBeUndefined();
  });
});
