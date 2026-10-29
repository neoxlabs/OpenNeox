import { describe, it, expect } from 'vitest';
import {
  collectDeliverables,
  extractDeliverableLines,
  hasDeliverablesSection,
  renderDeliverablesSection,
} from '../deliverablesDigest.js';
import { LLMSummarizer, COMPACTION_SUMMARY_MARKER } from '../llmSummarizer.js';
import { contextCollapse } from '../../../core/contextCollapse.js';

function call(name: string, args: Record<string, any>) {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: `t-${name}`, function: { name, arguments: JSON.stringify(args) } }],
  };
}

/** 交付流程: 生成 docx → 上屏 pptx → 导出 deck → 上屏 deck */
function deliveredHistory(): any[] {
  return [
    { role: 'user', content: '按这份提纲做周报和汇报 deck' },
    call('word_create', { save_path: '/w/周报.docx', content: '正文' }),
    { role: 'tool', name: 'word_create', tool_call_id: 't-word_create', content: '{"ok":true}' },
    call('deck_begin', { title: 'Q3 汇报', outline: [{ title: '封面', template: 'cover-hero' }] }),
    { role: 'tool', name: 'deck_begin', tool_call_id: 't-deck_begin', content: '{"ok":true}' },
    call('deck_export', { outputPath: '/w/deck.pptx' }),
    { role: 'tool', name: 'deck_export', tool_call_id: 't-deck_export', content: '{"ok":true}' },
    call('open_surface', { kind: 'pptx', source: { type: 'file', path: '/w/deck.pptx' } }),
    { role: 'tool', name: 'open_surface', tool_call_id: 't-open_surface', content: '{"ok":true}' },
    call('open_surface', { kind: 'docx', source: { type: 'file', path: '/w/周报.docx' } }),
    { role: 'tool', name: 'open_surface', tool_call_id: 't-open_surface2', content: '{"ok":true}' },
    { role: 'user', content: '把第 3 页的字改小一点' },
    { role: 'assistant', content: '好' },
  ];
}

describe('work:H-20 交付物清单', () => {
  describe('确定性扫描', () => {
    it('从工具调用里扫出交付物 (生成 / 导出 / 上屏)', () => {
      const d = collectDeliverables(deliveredHistory() as any);
      const byPath = new Map(d.map((x) => [x.path, x]));
      expect(byPath.get('/w/周报.docx')?.producedBy).toBe('生成 Word');
      expect(byPath.get('/w/周报.docx')?.shownCount).toBe(1);
      expect(byPath.get('/w/deck.pptx')?.producedBy).toBe('导出演示文稿');
      expect(byPath.get('/w/deck.pptx')?.shownCount).toBe(1);
      /* deck_begin 只是开会话, 不是交付物 (没有成品路径) */
      expect(d.some((x) => x.path === 'Q3 汇报')).toBe(false);
    });

    it('中间编辑 (write_file / edit) 不算交付物, 不重复占预算', () => {
      const d = collectDeliverables([
        call('write_file', { file_path: '/w/notes.md', content: 'x' }),
        call('edit', { file_path: '/w/notes.md', hunks: [{}] }),
      ] as any);
      expect(d).toHaveLength(0);
    });

    it('call_tool 动态派发也认得出来', () => {
      const d = collectDeliverables([
        call('call_tool', { tool: 'word_create', args: { save_path: '/w/a.docx', content: 'x' } }),
      ] as any);
      expect(d[0]?.path).toBe('/w/a.docx');
    });

    it('inline 上屏 (无文件路径) 不算交付物', () => {
      const d = collectDeliverables([
        call('open_surface', { kind: 'diagram', source: { type: 'inline', content: 'graph TD;' } }),
      ] as any);
      expect(d).toHaveLength(0);
    });
  });

  describe('渲染与合并', () => {
    it('同一路径只出现一条 —— 这是「用户拿到两个版本」的根源', () => {
      const entries = [
        ...collectDeliverables([
          call('word_create', { save_path: '/w/a.docx' }),
        ] as any),
        ...collectDeliverables([
          call('word_create', { save_path: '/w/a.docx' }),
          call('open_surface', { kind: 'docx', source: { type: 'file', path: '/w/a.docx' } }),
        ] as any),
      ];
      const section = renderDeliverablesSection(entries);
      const hits = section.split('\n').filter((l) => l.includes('/w/a.docx'));
      expect(hits).toHaveLength(1);
      /* 后一次生成覆盖前一次: 计数 1 (每次 collect 独立, 后发的记录覆盖) */
      expect(hits[0]).toContain('生成 Word');
    });

    it('滚动压缩: 旧清单被携带, 与本轮新交付合并', () => {
      const prior = ['- `/w/旧稿.docx` — 生成 Word 1 次 · 开屏 1 次'];
      const section = renderDeliverablesSection(collectDeliverables(deliveredHistory() as any), prior);
      expect(section).toContain('### Deliverables');
      expect(section).toContain('/w/旧稿.docx');
      expect(section).toContain('/w/deck.pptx');
    });

    it('没有交付物时明说 (而不是留个空节)', () => {
      expect(renderDeliverablesSection([])).toContain('本轮还没有交付物');
    });

    it('能从摘要正文里把这一节取回来 (供下一轮携带)', () => {
      const section = renderDeliverablesSection(collectDeliverables(deliveredHistory() as any));
      const lines = extractDeliverableLines([{ role: 'system', content: `x\n\n${section}` } as any]);
      expect(lines).toHaveLength(2);
      expect(lines.join('\n')).toContain('/w/deck.pptx');
    });
  });

  describe('接入压缩摘要 (端到端)', () => {
    const mockProvider = () => ({
      chat: async () => ({ choices: [{ message: { content: 'SUMMARY' } }] }),
    }) as any;

    it('压缩产物里一定有交付物清单, 且不止一条', async () => {
      const big = (i: number) => `output-${i} ` + 'x'.repeat(4000);
      const messages = [
        ...deliveredHistory().slice(0, 5),
        { role: 'tool', name: 'readfile', tool_call_id: 'r', content: big(1) },
        { role: 'tool', name: 'execute_shell', tool_call_id: 'r2', content: big(2) },
        ...deliveredHistory().slice(5),
      ];
      const r = await new LLMSummarizer({ protectHeadCount: 1, protectRecentCount: 2 })
        .summarize(messages as any, 100_000, mockProvider(), 'test-model');
      const summary = r.messages.find((m: any) => m.role === 'system' && String(m.content).startsWith(COMPACTION_SUMMARY_MARKER));
      const text = String(summary?.content ?? '');
      expect(hasDeliverablesSection(text)).toBe(true);
      expect(text).toContain('/w/周报.docx');
      expect(text).toContain('/w/deck.pptx');
      /* 同一份交付物在摘要里只出现一次 */
      expect(text.split('/w/deck.pptx')).toHaveLength(2);
    });

    it('上下文折叠 (Layer 2) 也不丢掉交付物路径', () => {
      const turns: any[] = [];
      /* 最老的一轮: 交付了 pptx */
      turns.push(
        { role: 'user', content: '做一份 Q3 汇报 deck' },
        call('deck_export', { outputPath: '/w/old-deck.pptx' }),
        { role: 'tool', name: 'deck_export', tool_call_id: 'x', content: '{"ok":true}' },
      );
      /* 后面若干轮填充, 让第一轮落进 Layer 2 */
      for (let i = 0; i < 12; i++) {
        turns.push(
          { role: 'user', content: `第 ${i} 轮: 读文件` },
          { role: 'assistant', content: `好 ${i}` },
          { role: 'tool', name: 'readfile', tool_call_id: `r${i}`, content: 'x'.repeat(500) },
        );
      }
      const collapsed = contextCollapse(turns, 0);
      const text = collapsed.messages.map((m: any) => String(m.content)).join('\n');
      expect(text).toContain('/w/old-deck.pptx');
    });
  });
});
