/**
 * import_style (work:P-02) —— 从用户既有 .pptx 提取风格
 *
 * 覆盖:
 *   1. 颜色 / 字体 / 形态 / 圆角 / 字阶 / 栅格的推断结果
 *   2. 字体缺 metrics 时必须替换并如实上报 (量和画用同一个字面)
 *   3. 非 16:9 稿件给出提示, 但不拿到一份坏 deck
 *   4. import_style → deck_begin → 9 页 deck_add_slide → deck_export 全链路,
 *      导出的 slide XML 里真的出现源稿的主色 (说明风格被用上了, 不是只回了个 id)
 *   5. 导入风格按 workspace 落盘, 新进程状态也能解析; 非法 id 拒绝
 *   6. 坏文件 / 不存在的文件给出可读错误
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { Presentation, exportPptx } from '@neoxlabs/pptx-renderer';
import { DEFAULT_STYLE_SPEC, hasFontMetrics, type StyleSpec } from '@neoxlabs/pptx-compose';
import { runWithWorkspaceRoot } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { extractStyleFromPptx } from '../importStyle.js';
import { importStyleTool } from '../importStyleTool.js';
import { loadImportedStyle, resolveStyleSpec, styleFilePath, validateSpec } from '../styleLibrary.js';
import { deckAddSlideTool, deckBeginTool, deckExportTool } from '../deckTools.js';

let ws: string;
const ctx = { sessionId: 'import-style-test' } as any;

const THEME_COLORS = {
  dk1: '#102030', lt1: '#FFFFFF', dk2: '#334455', lt2: '#F2F4F7',
  accent1: '#C8102E', accent2: '#1F6F5C', accent3: '#F2C94C',
  accent4: '#56CCF2', accent5: '#9B51E0', accent6: '#EB5757',
  hlink: '#1F6F5C', folHlink: '#9B51E0',
};

interface FixtureOptions {
  majorFont?: string;
  minorFont?: string;
  slideSize?: { width: number; height: number };
}

/** 造一份"用户公司模板"式的稿子: 自定义 theme + 实际用色 + chevron + 圆角卡片 */
async function buildFixture(opts: FixtureOptions = {}): Promise<Uint8Array> {
  const ppt = Presentation.create({ slideSize: opts.slideSize ?? { width: 1280, height: 720 } });
  ppt.setTheme({
    colors: THEME_COLORS,
    majorFont: opts.majorFont ?? 'Didot',
    minorFont: opts.minorFont ?? 'Helvetica Neue',
  });

  const s1 = ppt.slides.add();
  s1.background.fill = '#F7F5F2';
  s1.shapes.addText('XX 公司年度经营汇报', { left: 72, top: 56, width: 900, height: 80 },
    { fontSize: 40, bold: true, color: '#102030' });
  s1.shapes.addText('2025 年总结 · 董事会', { left: 72, top: 160, width: 600, height: 36 },
    { fontSize: 18, color: '#334455' });

  /* chevron 流程 —— 形态证据 */
  for (let i = 0; i < 4; i++) {
    s1.shapes.add({
      geometry: 'chevron',
      position: { left: 100 + i * 240, top: 260, width: 180, height: 72 },
      fill: '#C8102E',
    });
  }

  /* 圆角卡片 —— 圆角半径证据 */
  for (let i = 0; i < 2; i++) {
    s1.shapes.addRoundRect(
      { left: 72 + i * 588, top: 400, width: 540, height: 120 },
      '#FFFFFF', 16,
    );
    s1.shapes.addText(i === 0 ? '营收同比增长 18%' : '续约率 94%',
      { left: 100 + i * 588, top: 440, width: 480, height: 40 },
      { fontSize: 14, color: '#102030' });
  }

  const s2 = ppt.slides.add();
  s2.shapes.addText('经营回顾', { left: 72, top: 56, width: 700, height: 56 },
    { fontSize: 28, bold: true, color: '#102030' });
  s2.shapes.addText('上半年完成三件事, 下半年聚焦两个战场。', { left: 72, top: 150, width: 1000, height: 40 },
    { fontSize: 18, color: '#334455' });

  return (await exportPptx(ppt)).bytes();
}

const callTool = (tool: typeof importStyleTool, args: unknown) =>
  runWithWorkspaceRoot(ws, async () => JSON.parse(await tool.function(args as any, ctx)));

const callDeck = (tool: any, args: unknown) =>
  runWithWorkspaceRoot(ws, async () => JSON.parse(await tool.function(args as any, ctx)));

beforeAll(async () => {
  ws = mkdtempSync(path.join(tmpdir(), 'neox-import-style-'));
  writeFileSync(path.join(ws, 'company.pptx'), await buildFixture());
});

afterAll(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('extractStyleFromPptx', () => {
  it('从 theme + 实际用色里抽出颜色 / 字体 / 形态 / 圆角 / 字阶 / 栅格', async () => {
    const { spec, report } = await extractStyleFromPptx(await buildFixture(), { sourceName: 'company.pptx' });

    /* 颜色 */
    expect(report.colors.paper).toBe('#F7F5F2');
    expect(report.colors.ink).toBe('#102030');
    expect(report.colors.accent).toBe('#C8102E');
    expect(report.colorSource).toBe('theme');

    /* 字体: theme 的 major/minor 被沿用 */
    expect(spec.theme.fonts.displayLatin).toBe('Didot');
    expect(spec.theme.fonts.textLatin).toBe('Helvetica Neue');
    expect(report.fonts.substitutions).toEqual([]);

    /* 形态: 4 个 chevron 应当压过 2 个圆角卡片 */
    expect(spec.motif).toBe('chevron');
    expect(report.motif.evidence).toMatch(/箭头\/楔形 4 个/);

    /* 圆角: 原稿 16px */
    expect(spec.radius.md).toBe(16);
    expect(spec.radius.lg).toBeGreaterThanOrEqual(spec.radius.md);

    /* 字阶: 40 / 28 / 14 */
    expect(spec.type.display.size).toBe(40);
    expect(spec.type.title.size).toBe(28);
    expect(spec.type.body.size).toBe(14);

    /* 栅格: 文字左边距 72、上边距 56 */
    expect(spec.grid.margin.left).toBe(72);
    expect(spec.grid.margin.top).toBe(56);
    expect(spec.grid.margin.right).toBe(112);

    /* 画布/页数 */
    expect(report.source.slideCount).toBe(2);
    expect(report.source.slideWidthPx).toBe(1280);
    expect(report.source.slideHeightPx).toBe(720);
  });

  it('字体没有 metrics 时替换成同气质字体, 并逐条上报', async () => {
    const { spec, report } = await extractStyleFromPptx(
      await buildFixture({ majorFont: '思源黑体 CN', minorFont: 'Space Grotesk' }),
      { sourceName: 'company.pptx' },
    );

    for (const family of Object.values(spec.theme.fonts)) {
      expect(hasFontMetrics(family)).toBe(true);
    }
    const inRole = (role: string) => report.fonts.substitutions.find((s) => s.role === role);
    expect(inRole('textLatin')?.from).toBe('Space Grotesk');
    expect(inRole('textLatin')?.to).toBe('Helvetica Neue');
    expect(inRole('displayEast')?.to).toBe('PingFang SC');
    expect(report.notes.some((n) => n.includes('没有烘焙 metrics'))).toBe(true);
  });

  it('非 16:9 原稿给出提示, 风格仍可用', async () => {
    const { spec, report } = await extractStyleFromPptx(
      await buildFixture({ slideSize: { width: 960, height: 720 } }),
      { sourceName: 'company.pptx' },
    );
    expect(spec.motif).toBe('chevron');
    expect(report.notes.some((n) => n.includes('非 16:9'))).toBe(true);
  });

  it('styleId 稳定: 同一份稿重复导入得到同一个 id', async () => {
    const bytes = await buildFixture();
    const a = await extractStyleFromPptx(bytes, { sourceName: 'company.pptx' });
    const b = await extractStyleFromPptx(bytes, { sourceName: 'company.pptx' });
    expect(a.spec.id).toMatch(/^imported-company-[0-9a-f]{6}$/);
    expect(a.spec.id).toBe(b.spec.id);
  });

  it('坏文件 / 非 pptx 结构给出可读错误', async () => {
    await expect(extractStyleFromPptx(new TextEncoder().encode('not a pptx'))).rejects.toThrow();
  });
});

describe('import_style 工具 + deck 全链路', () => {
  it('导入 → 落盘 → deck_begin → 9 页 → 导出, 导出的页面真的用了源稿主色', async () => {
    const imported = await callTool(importStyleTool, { file_path: 'company.pptx', name: 'XX 公司模板' });
    expect(imported.ok).toBe(true);
    expect(imported.styleId).toMatch(/^imported-xx-/);
    expect(imported.extracted.colors.accent).toBe('#C8102E');
    expect(imported.extracted.motif.value).toBe('chevron');

    const saved = styleFilePath(ws, imported.styleId);
    expect(saved).toBeTruthy();
    expect(existsSync(saved!)).toBe(true);

    const begin = await callDeck(deckBeginTool, {
      title: '2025 年度经营汇报',
      styleId: imported.styleId,
      outline: [
        { title: '封面', template: 'cover-hero' },
        { title: '经营回顾', template: 'section-divider' },
        { title: '做成的事', template: 'bullet-list' },
        { title: '机会与挑战', template: 'two-column' },
        { title: '关键指标', template: 'kpi-cards' },
        { title: '里程碑', template: 'timeline' },
        { title: '分区域营收', template: 'data-table' },
        { title: '营收趋势', template: 'chart-focus' },
        { title: '结尾', template: 'quote-page' },
      ],
    });
    expect(begin.error).toBeUndefined();

    const pages = [
      { title: 'XX 公司 2025 年度经营汇报', subtitle: '董事会' },
      { sectionNumber: '01', title: '经营回顾' },
      { title: '本年度做成的事', items: ['营收同比增长 18%', '续约率 94%', '交付周期缩短至 12 天'] },
      { title: '机会与挑战', leftTitle: '机会', leftBody: '国产替代窗口打开。', rightTitle: '挑战', rightBody: '获客成本仍在上升。' },
      { title: '关键指标', cards: [{ value: '18%', label: '营收增长' }, { value: '94%', label: '续约率' }, { value: '12 天', label: '交付周期' }] },
      { title: '里程碑', steps: [{ label: 'Q1', detail: '完成产品重构' }, { label: 'Q2', detail: '进入三个新行业' }, { label: 'Q3', detail: '服务收入转正' }] },
      { title: '分区域营收', headers: ['区域', 'Q3', '同比'], rows: [['华东', '640', '+12%'], ['华南', '380', '+8%'], ['华北', '520', '+15%']] },
      { title: '营收趋势', chartType: 'line', data: [{ label: 'Q1', value: 120 }, { label: 'Q2', value: 150 }, { label: 'Q3', value: 180 }] },
      { quote: '把复杂留给自己, 把简单留给客户', attribution: '总经理' },
    ];
    for (let i = 0; i < pages.length; i++) {
      const r = await callDeck(deckAddSlideTool, { index: i, slots: pages[i] });
      expect(r.ok, `第 ${i + 1} 页生成失败: ${JSON.stringify(r)}`).toBe(true);
    }

    const exp = await callDeck(deckExportTool, {});
    expect(exp.ok, JSON.stringify(exp)).toBe(true);
    expect(exp.slideCount).toBe(9);
    expect(exp.selfCheck?.available).not.toBe(false);
    expect(exp.selfCheck?.passed, JSON.stringify(exp.selfCheck)).toBe(true);

    /* 风格真的被用上: 导出 XML 里出现源稿主色 (OOXML 的 srgbClr 不带 #) */
    const zip = await JSZip.loadAsync(await readFile(exp.path));
    const slideXmls: string[] = [];
    for (const name of Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
      slideXmls.push((await zip.file(name)!.async('string')).toLowerCase());
    }
    expect(slideXmls.some((x) => x.includes('c8102e'))).toBe(true);
  }, 120_000);

  it('落盘的风格能被新状态解析 (跨会话可用), 非法 id 拒绝', async () => {
    /* 直接落一份没注册过的 spec, 模拟上一次会话留下的文件 */
    const spec: StyleSpec = {
      ...DEFAULT_STYLE_SPEC,
      id: 'imported-persisted-sample',
      displayName: '落盘样例',
      theme: { ...DEFAULT_STYLE_SPEC.theme, id: 'imported-persisted-theme', accent: '#0B5FFF' },
    };
    const { saveImportedStyle } = await import('../styleLibrary.js');
    await saveImportedStyle(ws, spec);

    const resolved = await resolveStyleSpec(ws, spec.id);
    expect(resolved?.id).toBe(spec.id);
    expect(resolved?.theme.accent).toBe('#0B5FFF');

    expect(await loadImportedStyle(ws, '../evil')).toBeNull();
    expect(styleFilePath(ws, '../evil')).toBeNull();
    expect(await resolveStyleSpec(ws, 'no-such-style')).toBeUndefined();
  });

  it('文件不存在 / 扩展名不对 / 内置 id 被占用 → 可读错误', async () => {
    const missing = await callTool(importStyleTool, { file_path: 'nope.pptx' });
    expect(missing.error).toMatch(/文件不存在/);

    writeFileSync(path.join(ws, 'old.ppt'), 'x'.repeat(2048));
    const legacy = await callTool(importStyleTool, { file_path: 'old.ppt' });
    expect(legacy.error).toMatch(/只支持 \.pptx/);

    const builtin = await callTool(importStyleTool, { file_path: 'company.pptx', style_id: 'minimal-line' });
    expect(builtin.error).toMatch(/内置风格/);
  });

  it('validateSpec 拒绝缺字段 / 非法颜色的盘上 JSON', () => {
    expect(validateSpec({ id: 'imported-x' })).toBeNull();
    expect(validateSpec({
      ...DEFAULT_STYLE_SPEC,
      id: 'imported-bad-color',
      theme: { ...DEFAULT_STYLE_SPEC.theme, accent: 'red' },
    })).toBeNull();
  });
});
