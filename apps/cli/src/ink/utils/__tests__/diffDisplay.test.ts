/**
 * CLI-04: diff 折叠 / 全屏视图的行解析口径。
 * 卡片与 ctrl+d 全屏视图共用这套逻辑, 所以这里断言的既是卡片行为也是全屏行为。
 */
import { describe, it, expect } from 'vitest';
import {
  DIFF_PREVIEW_MAX_LINES,
  foldDiffPreview,
  parseDiffDetails,
  parseDiffLine,
  parseUnifiedDiffText,
  collectDiffViewerSections,
  renderDiffSectionLines,
} from '../diffDisplay.js';
import { generateDiffLines, DIFF_DETAIL_MAX_LINES } from '../diffPreview.js';

const details = [
  'H:0:--- a/src/auth/login.ts',
  'H:0:+++ b/src/auth/login.ts',
  'H:0:@@ -10,3 +10,4 @@',
  'C:10:  import { loginHandler } from "./handler";',
  '+:11:  import { rateLimit } from "../middleware";',
  'C:12:  router.post("/api/login", loginHandler);',
  '-:13:  router.post("/api/login", oldHandler);',
].join('\n');

describe('diffDisplay · parseDiffLine', () => {
  it('解析 type:lineNum:content 三种基本行', () => {
    expect(parseDiffLine('+:12:hello')).toEqual({ type: 'add', lineNum: 12, content: 'hello' });
    expect(parseDiffLine('-:7:gone')).toEqual({ type: 'remove', lineNum: 7, content: 'gone' });
    expect(parseDiffLine('C:3:ctx')).toEqual({ type: 'context', lineNum: 3, content: 'ctx' });
    expect(parseDiffLine('H:0:@@ -1 +1 @@')).toEqual({ type: 'header', lineNum: 0, content: '@@ -1 +1 @@' });
  });

  it('内容里带冒号不会被截断', () => {
    expect(parseDiffLine('+:9:const t = a ? b : c;').content).toBe('const t = a ? b : c;');
  });

  it('兼容旧格式 (无行号)', () => {
    expect(parseDiffLine('+:- no line number')).toEqual({ type: 'add', lineNum: 0, content: '- no line number' });
  });
});

describe('diffDisplay · parseDiffDetails', () => {
  it('卡片口径丢掉 ---/+++/@@ 噪音头', () => {
    const lines = parseDiffDetails(details);
    expect(lines.map(l => l.type)).toEqual(['context', 'add', 'context', 'remove']);
  });

  it('全屏口径保留 hunk 头, 用户能看出改动位置', () => {
    const lines = parseDiffDetails(details, { keepFileHeaders: true });
    expect(lines[0]).toEqual({ type: 'header', lineNum: 0, content: '--- a/src/auth/login.ts' });
    expect(lines.some(l => l.type === 'header' && l.content.startsWith('@@'))).toBe(true);
  });

  it('保留截断提示 (用户在卡里能看到还有多少行)', () => {
    const lines = parseDiffDetails(`H:0:--- a/x\n+:1:a\nH:0:... (7 more lines)`);
    expect(lines.some(l => l.type === 'header' && /more lines/.test(l.content))).toBe(true);
  });
});

describe('diffDisplay · foldDiffPreview', () => {
  it('默认折叠 12 行', () => {
    expect(DIFF_PREVIEW_MAX_LINES).toBe(12);
    const lines = Array.from({ length: 30 }, (_, i) => i);
    const { shown, hidden } = foldDiffPreview(lines);
    expect(shown).toHaveLength(12);
    expect(hidden).toBe(18);
    expect(shown[0]).toBe(0);
    expect(shown[11]).toBe(11);
  });

  it('不足 12 行不折叠, 也不吞行', () => {
    const { shown, hidden } = foldDiffPreview([1, 2, 3]);
    expect(shown).toEqual([1, 2, 3]);
    expect(hidden).toBe(0);
  });

  it('刚好 12 行不折叠', () => {
    const lines = Array.from({ length: 12 }, (_, i) => i);
    expect(foldDiffPreview(lines).hidden).toBe(0);
  });
});

describe('diffDisplay · 全屏视图分段', () => {
  it('file_update 条目被收进全屏视图, 标题用卡片那句话', () => {
    const sections = collectDiffViewerSections([
      { type: 'file_update', text: 'Edited src/auth/login.ts +1 -1', details },
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe('Edited src/auth/login.ts +1 -1');
    // 全屏口径保留头: --- / +++ / @@ 都在
    expect(sections[0].lines.filter(l => l.type === 'header').length).toBeGreaterThanOrEqual(3);
  });

  it('普通工具输出 / 只有描述没有 diff 明细的条目不进全屏视图', () => {
    const sections = collectDiffViewerSections([
      { type: 'command_exec', text: 'ls', details: 'a\nb' },
      { type: 'file_update', text: 'x.ts', details: '3 lines' },
    ]);
    expect(sections).toHaveLength(0);
  });

  it('git_diff 条目按 unified diff 解析 (含 JSON 包装)', () => {
    const raw = 'diff --git a/a.ts b/a.ts\nindex 111..222\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n keep';
    const sections = collectDiffViewerSections([
      { type: 'git_diff', text: 'Diff a.ts', details: JSON.stringify({ content: raw }) },
    ]);
    expect(sections).toHaveLength(1);
    const types = sections[0].lines.map(l => l.type);
    expect(types).toContain('add');
    expect(types).toContain('remove');
    expect(sections[0].lines.find(l => l.type === 'add')?.content).toBe('new');
    expect(sections[0].lines.find(l => l.type === 'remove')?.content).toBe('old');
  });

  it('多个 diff 按时间线顺序排列 (最近的在后)', () => {
    const sections = collectDiffViewerSections([
      { type: 'file_update', text: 'first', details },
      { type: 'file_update', text: 'second', details },
    ]);
    expect(sections.map(s => s.title)).toEqual(['first', 'second']);
  });
});

describe('diffDisplay · 着色', () => {
  it('新增/删除行分别带 +/- 标记与行号 (着色正确: 绿加红减)', () => {
    const section = {
      title: 'Edited x.ts',
      lines: parseDiffDetails(details, { keepFileHeaders: true }),
    };
    const rendered = renderDiffSectionLines(section);
    const addLine = rendered.find(l => /\d+ \+ +import \{ rateLimit \}/.test(l));
    const rmLine = rendered.find(l => /\d+ - +router\.post\("\/api\/login", oldHandler\)/.test(l));
    expect(addLine).toBeDefined();
    expect(rmLine).toBeDefined();
    // 行号保留: 新增行是第 11 行, 删除行是第 13 行
    expect(addLine).toContain('11');
    expect(rmLine).toContain('13');
  });
});

describe('diffDisplay · parseUnifiedDiffText', () => {
  it('尾部空行不算一行', () => {
    const lines = parseUnifiedDiffText('@@ -1 +1 @@\n+only\n');
    expect(lines.filter(l => l.type === 'add')).toHaveLength(1);
    expect(lines.some(l => l.type === 'context')).toBe(false);
  });
});

describe('diffDisplay · 全屏视图能看到卡片之外的行', () => {
  /* 生成端 (InkUIAdapter) 用 DIFF_DETAIL_MAX_LINES 存明细 —— 如果它还停在 15/30,
   * 卡里 12 行、全屏也只有 30 行, 「全屏看完整改动」就是空话。这里把两端口径钉在一起。 */
  it('50 行改动的明细超过卡片折叠数, 全屏能看到全部', () => {
    expect(DIFF_DETAIL_MAX_LINES).toBeGreaterThan(DIFF_PREVIEW_MAX_LINES);

    const oldCode = Array.from({ length: 50 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const newCode = Array.from({ length: 50 }, (_, i) => `const v${i} = ${i + 1};`).join('\n');
    const generated = generateDiffLines(oldCode, newCode, 'src/x.ts', { maxLines: DIFF_DETAIL_MAX_LINES });
    const parsed = generated.map(l => ({ type: l.type as any, lineNum: 0, content: l.content }));

    // 生成端没被 15/30 行截断
    expect(parsed.filter(l => l.type === 'add' || l.type === 'remove').length)
      .toBeGreaterThan(DIFF_PREVIEW_MAX_LINES * 2);
    // 卡片只显示 12 行, 剩下的在全屏里
    const { shown, hidden } = foldDiffPreview(parsed, DIFF_PREVIEW_MAX_LINES);
    expect(shown).toHaveLength(DIFF_PREVIEW_MAX_LINES);
    expect(hidden).toBeGreaterThan(0);
  });
});
