/**
 * work:H-19 · 工具结果瘦身 (inspect / describe) —— 返回 ≤1.5K 字符且带定位。
 *
 * 事故形状: 自检把整份 issue 列表原样回给模型 (一条一个对象, 带 shape 矩形 / 长 message),
 * 一份 20 页 deck 动辄几千字符, 模型反而漏掉里面那几条 mustFix。
 *
 * 这里守三条:
 *   1. 每个 issue 压成一行, **定位不丢** (第 N 页 / Sheet1!B4 / index=N);
 *   2. 总量不超过 1.5K 字符 (方案验收线);
 *   3. 截断必须明说截了多少, 不能静默 —— 否则模型以为已经改完。
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_REPORT_CHARS,
  compactIssues,
  compactDescribeJson,
  fitIssueLinesIntoPayload,
  formatIssueLine,
  officeIssueToSized,
  pptxIssueToSized,
  type SizedIssue,
} from '../compactToolReport.js';

const sized = (n: number, prefix = '第'): SizedIssue[] =>
  Array.from({ length: n }, (_, i) => ({
    where: `${prefix} ${i + 1} 页`,
    text: '标题文字溢出文本框, 右侧被裁掉约 12pt, 建议缩短标题或降低字号',
  }));

describe('work:H-19 inspect / describe 结果瘦身', () => {
  it('验收线是 1.5K 字符', () => {
    expect(MAX_REPORT_CHARS).toBe(1500);
  });

  it('少量 issue 全量保留, 每行都带定位', () => {
    const r = compactIssues(sized(3));
    expect(r.shown).toBe(3);
    expect(r.dropped).toBe(0);
    expect(r.lines).toHaveLength(3);
    for (const [i, line] of r.lines.entries()) {
      expect(line).toContain(`第 ${i + 1} 页`);
      expect(line.startsWith('- [')).toBe(true);
    }
  });

  it('几十条 issue 也守住预算', () => {
    const r = compactIssues(sized(60));
    expect(r.dropped).toBeGreaterThan(0);
    /* 预算只算 issue 部分; 真实出口还有 error / next 等固定字段, 这里留出余量 */
    expect(r.chars).toBeLessThanOrEqual(MAX_REPORT_CHARS);
  });

  it('截断时明说还有多少条, 不静默丢', () => {
    const r = compactIssues(sized(60));
    const tail = r.lines[r.lines.length - 1];
    expect(tail).toContain(`还有 ${r.dropped} 条`);
  });

  it('顺序就是优先级: mustFix 在前 (inspect 已排好序, 这里不重排)', () => {
    const issues: SizedIssue[] = [
      { where: '第 2 页', text: '[必须修] 文字重叠' },
      { where: '第 7 页', text: '[必须修] 文字出页' },
      ...sized(40),
    ];
    const r = compactIssues(issues, { maxChars: 400 });
    expect(r.lines[0]).toContain('第 2 页');
    expect(r.lines[0]).toContain('文字重叠');
    expect(r.lines[1]).toContain('第 7 页');
  });

  it('预算极紧也至少给 minKeep 条, 不让模型没有可修的东西', () => {
    const r = compactIssues(sized(20), { maxChars: 10, minKeep: 3 });
    expect(r.shown).toBe(3);
    expect(r.dropped).toBe(17);
  });

  it('单条超长 message 被截短, 但定位完整', () => {
    const line = formatIssueLine({ where: '第 9 页 形状「正文」', text: 'x'.repeat(500) }, 60);
    expect(line).toContain('第 9 页');
    expect(line.length).toBeLessThanOrEqual(60 + 20);
  });

  it('没写定位的 issue 也不会变成裸文本', () => {
    expect(formatIssueLine({ where: '', text: '不知道哪里错了' })).toContain('(未标明位置)');
  });

  describe('各格式的定位字段', () => {
    it('pptx: 导出页序 + 大纲 index + 页标题 + 形状名', () => {
      const s = pptxIssueToSized(
        { slide: 3, severity: 'error', kind: 'text-overflow', message: '文字溢出', shape: { name: '正文占位符' } },
        { outlineIndex: 1, slideTitle: '交付周期' },
      );
      expect(s.where).toContain('index=1');
      expect(s.where).toContain('第 3 页');
      expect(s.where).toContain('交付周期');
      expect(s.where).toContain('正文占位符');
      expect(s.text).toContain('text-overflow');
      expect(s.text).toContain('文字溢出');
    });

    it('xlsx / docx: 检查器给的 location 原样保留 (Sheet1!B4 / 第 3 页)', () => {
      const s = officeIssueToSized({ severity: 'error', kind: 'error_value', location: 'Sheet1!B4', detail: '#REF!' });
      expect(s.where).toBe('Sheet1!B4');
      expect(s.text).toContain('#REF!');
    });
  });

  describe('整个工具返回的预算 (不只是 issues 部分)', () => {
    const officeIssues = Array.from({ length: 40 }, (_, i) => ({
      severity: 'error', kind: 'error_value', location: `Sheet1!B${i + 2}`,
      detail: '#REF! 公式引用了已删除的行，需要重新选择数据区域',
    }));
    const build = (lines: string[]) => ({
      error: '交付闸门拦截: 这份 xlsx 有 40 处必须修的结构问题, 未上屏。',
      format: 'xlsx', mustFixCount: 40, issues: lines,
      next: '按 issues 里每行开头的 [位置] 逐条修: 错误值用 sheet_get_range 定位后改掉; 修完再调 open_surface 复检。',
    });

    it('40 条 issue 时整段 JSON 仍然 ≤1.5K', () => {
      const fitted = fitIssueLinesIntoPayload(build, officeIssues.map(officeIssueToSized), { minKeep: 3 });
      expect(fitted.json.length).toBeLessThanOrEqual(MAX_REPORT_CHARS);
      expect(fitted.shown).toBeGreaterThanOrEqual(3);
      expect(fitted.dropped).toBeGreaterThan(0);
      expect(fitted.json).toContain('Sheet1!B2');
      /* 截断要明说 */
      expect(fitted.json).toContain('还有');
    });

    it('少量 issue 时不多截, 全部保留', () => {
      const few = officeIssues.slice(0, 2).map(officeIssueToSized);
      const fitted = fitIssueLinesIntoPayload(build, few, { minKeep: 3 });
      expect(fitted.shown).toBe(2);
      expect(fitted.dropped).toBe(0);
      expect(fitted.json.length).toBeLessThanOrEqual(MAX_REPORT_CHARS);
    });
  });

  describe('describe 类结构概览', () => {
    it('小工作簿原样返回 (不额外加字段)', () => {
      const payload = {
        source: 'a.xlsx',
        total_sheets: 2,
        sheets: [
          { name: 'Sheet1', used_range: 'A1:D10', rows: 10, cols: 4 },
          { name: 'Sheet2', used_range: 'A1:B3', rows: 3, cols: 2 },
        ],
        mtime_ms: 1,
      };
      const out = compactDescribeJson(payload);
      expect(JSON.parse(out)).toEqual(payload);
    });

    it('几十个 sheet 的工作簿不超预算, 且说明省略了多少', () => {
      const sheets = Array.from({ length: 120 }, (_, i) => ({
        name: `Sheet_${i}_很长的名字用于撑爆预算`, used_range: 'A1:Z999', rows: 999, cols: 26,
      }));
      const out = compactDescribeJson({ source: 'huge.xlsx', total_sheets: 120, sheets, mtime_ms: 1 });
      expect(out.length).toBeLessThanOrEqual(MAX_REPORT_CHARS);
      const parsed = JSON.parse(out);
      expect(parsed.total_sheets).toBe(120);
      expect(parsed.sheets_omitted).toBeGreaterThan(0);
      expect(parsed.note).toContain('sheet_get_range');
    });
  });
});
