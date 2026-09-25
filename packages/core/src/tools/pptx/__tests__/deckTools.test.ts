
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { runWithWorkspaceRoot } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { deckBeginTool, deckAddSlideTool, deckExportTool } from '../deckTools.js';

let ws: string;
const ctx = { sessionId: 'deck-test-session' } as any;

const call = (tool: typeof deckBeginTool, args: unknown) =>
  runWithWorkspaceRoot(ws, async () => JSON.parse(await tool.function(args as any, ctx)));

async function slideNames(pptxPath: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  const files = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml/)![1]) - Number(b.match(/(\d+)\.xml/)![1]));
  const out: string[] = [];
  for (const f of files) {
    const xml = await zip.file(f)!.async('string');
    out.push(/<p:cSld\s+name="([^"]*)"/.exec(xml)?.[1] ?? '?');
  }
  return out;
}

async function slideXml(pptxPath: string, n: number): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(pptxPath));
  return zip.file(`ppt/slides/slide${n}.xml`)!.async('string');
}

beforeAll(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'neox-deck-'));
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('deck_* 逐页生成', () => {
  it('乱序画页 + 重做一页 → 导出按大纲顺序、不重复, 并带自检结果', async () => {
    const begin = await call(deckBeginTool, {
      title: '季度汇报',
      styleId: 'minimal-line',
      outline: [
        { title: '封面', template: 'cover-hero' },
        { title: '第一章', template: 'section-divider' },
        { title: '要点', template: 'bullet-list' },
        { title: '分区域', template: 'data-table' },
      ],
    });
    expect(begin.error).toBeUndefined();

    /* 故意乱序: 3 → 0 → 2 → 1 */
    const r3 = await call(deckAddSlideTool, {
      index: 3,
      slots: { title: '分区域营收', headers: ['区域', 'Q3'], rows: [['华东', '640'], ['华南', '380']] },
      decor: { intensity: 'subtle' },
    });
    expect(r3.ok).toBe(true);
    expect(r3.note).toMatch(/decor 没画/);

    expect((await call(deckAddSlideTool, {
      index: 0, slots: { title: '第三季度汇报', subtitle: '营收与下季度重点' }, decor: { intensity: 'bold', corner: 'br' },
    })).ok).toBe(true);
    expect((await call(deckAddSlideTool, {
      index: 2, slots: { title: '做成的事', items: ['续约率 94%', '获客成本降 18%'] },
    })).ok).toBe(true);
    expect((await call(deckAddSlideTool, {
      index: 1, slots: { sectionNumber: '01', title: '经营回顾' },
    })).ok).toBe(true);

    /* 重做第 2 页 —— 原地替换 */
    const redo = await call(deckAddSlideTool, {
      index: 2, slots: { title: '本季做成的事', items: ['续约率 94%', '获客成本降 18%', '交付周期 12 天'] },
    });
    expect(redo.ok).toBe(true);
    expect(redo.replaced).toBe(true);

    const exp = await call(deckExportTool, {});
    expect(exp.ok).toBe(true);
    expect(exp.slideCount).toBe(4);
    expect(await slideNames(exp.path)).toEqual(['cover-hero', 'section-divider', 'bullet-list', 'data-table']);

    /* 重做后的内容才是导出的内容 */
    expect(await slideXml(exp.path, 3)).toContain('交付周期 12 天');

    /* 自检真的跑了, 结论带回来 (passed 或点名到页, 两者之一) */
    expect(exp.selfCheck).toBeDefined();
    expect(exp.selfCheck.available).not.toBe(false);
    if (exp.selfCheck.passed === false) {
      expect(exp.deckStillOpen).toBe(true);
      expect(exp.selfCheck.mustFix[0].index).toBeTypeOf('number');
    }
  }, 60_000);

  it('封面和章节页不编页码, 正文页编 (页型来自大纲时也一样)', async () => {
    await call(deckBeginTool, {
      title: '页码',
      styleId: 'minimal-line',
      outline: [
        { title: '封面', template: 'cover-hero' },
        { title: '正文', template: 'title-body' },
      ],
    });
    await call(deckAddSlideTool, { index: 0, slots: { title: '封面标题' } });
    await call(deckAddSlideTool, { index: 1, slots: { title: '正文标题', body: '一段正文内容。' } });
    const exp = await call(deckExportTool, {});
    const cover = await slideXml(exp.path, 1);
    const body = await slideXml(exp.path, 2);
    /* 页码是 slideChrome 画的一个只含数字的文本框: 正文页有 "2", 封面页不该有 "1" */
    expect(body).toMatch(/<a:t>0?2<\/a:t>/);
    expect(cover).not.toMatch(/<a:t>0?1<\/a:t>/);
  }, 60_000);

  it('稳健金融风格: 议程页 / 杂志式图表 / 纹样封面都能出, 导出自检通过', async () => {
    await call(deckBeginTool, {
      title: '金融样张',
      styleId: 'finance-navy',
      outline: [
        { title: '封面', template: 'cover-hero' },
        { title: '目录', template: 'agenda' },
        { title: '分区域', template: 'chart-focus' },
      ],
    });
    expect((await call(deckAddSlideTool, { index: 0, slots: { title: '第三季度经营汇报', subtitle: '营收与重点' } })).ok).toBe(true);
    expect((await call(deckAddSlideTool, {
      index: 1, slots: { title: '目录', items: [{ title: '经营概览', desc: '核心指标' }, { title: '区域结构' }, { title: '下季度重点' }] },
    })).ok).toBe(true);
    expect((await call(deckAddSlideTool, {
      index: 2,
      slots: { title: '分区域营收', unit: '万', note: '华东贡献近一半', data: [{ label: '华东', value: 640 }, { label: '华南', value: 380 }, { label: '西部', value: 130 }] },
    })).ok).toBe(true);
    /* 封面自带背景构成, decor 被忽略并说明原因 */
    const cov = await call(deckAddSlideTool, { index: 0, slots: { title: '第三季度经营汇报' }, decor: { intensity: 'bold' } });
    expect(cov.note).toMatch(/封面/);

    const exp = await call(deckExportTool, {});
    expect(exp.selfCheck.passed).toBe(true);
    expect(await slideNames(exp.path)).toEqual(['cover-hero', 'agenda', 'chart-focus']);
    /* 杂志式图表: 不画刻度网格, 柱顶直接写数值 */
    const chart = await slideXml(exp.path, 3);
    expect(chart).toContain('640万');
    expect(chart).not.toMatch(/<a:t>800<\/a:t>/);
  }, 60_000);

  it('decor 的取值不在枚举里 → 直接说清楚, 不静默画错', async () => {
    await call(deckBeginTool, { title: 'x', outline: [{ title: 'a', template: 'title-body' }] });
    const r = await call(deckAddSlideTool, {
      index: 0, slots: { title: 't', body: 'b' }, decor: { intensity: 'huge' },
    });
    expect(r.error).toMatch(/intensity/);
  });
});
