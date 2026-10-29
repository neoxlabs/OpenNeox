/**
 * work:P-01 · 风格库从 5 套扩到 11 套
 *
 * 这里守的是**风格库自身的不变量** —— 数量、id 唯一、主题注册、字体 metrics、
 * 文字对比度。渲染层那半 (20 模板 × 全风格重叠) 由 `npm run verify -w
 * @neoxlabs/pptx-compose` 守着, 两者不重复。
 */
import { describe, expect, it } from 'vitest';
import { STYLE_SPECS, DEFAULT_STYLE_SPEC, pickStyleForBrief, type StyleSpec } from '../styleSpec.js';
import { THEMES, THEME_HINTS } from '../../templates/themes.js';
import { hasFontMetrics } from '../../layout/font-metrics.js';

const SPECS = Object.values(STYLE_SPECS);

/** 第一批 (2026-08 起就在的 5 套) —— 扩库不许把它们改没 */
const ORIGINAL_IDS = ['corporate-chevron', 'editorial-capsule', 'minimal-line', 'bold-ribbon', 'finance-navy'];

/** 第二批 (work:P-01 新增的 6 套) */
const ADDED_IDS = ['education-fresh', 'tech-dark', 'medical-calm', 'gov-red', 'mono-minimal', 'academic-serif'];

function lum(hex: string): number {
  const x = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(x.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

function contrast(a: string, b: string): number {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('STYLE_SPECS 数量与注册', () => {
  it('从 5 套扩到 10-12 套 (本次 11 套)', () => {
    expect(SPECS.length).toBeGreaterThanOrEqual(10);
    expect(SPECS.length).toBeLessThanOrEqual(12);
    expect(SPECS.length).toBe(11);
  });

  it('第一批 5 套一个都没少', () => {
    for (const id of ORIGINAL_IDS) expect(Object.keys(STYLE_SPECS)).toContain(id);
  });

  it('新增的 6 套都在, 且 id 与注册键一致', () => {
    for (const id of ADDED_IDS) {
      expect(STYLE_SPECS[id], `缺风格 ${id}`).toBeTruthy();
      expect(STYLE_SPECS[id]!.id).toBe(id);
    }
  });

  it('每个 spec 的 theme 都已注册在 THEMES 里', () => {
    for (const spec of SPECS) {
      expect(THEMES[spec.theme.id], `${spec.id} 的主题 ${spec.theme.id} 未注册`).toBe(spec.theme);
    }
  });

  it('每套都有给人看的名字和适用场景, 且不重复', () => {
    const names = new Set<string>();
    const suited = new Set<string>();
    for (const spec of SPECS) {
      expect(spec.displayName.trim().length, `${spec.id} 缺 displayName`).toBeGreaterThan(0);
      expect(spec.suitedFor.trim().length, `${spec.id} 缺 suitedFor`).toBeGreaterThan(0);
      expect(names.has(spec.displayName), `${spec.id} 的 displayName 撞了`).toBe(false);
      expect(suited.has(spec.suitedFor), `${spec.id} 的 suitedFor 撞了`).toBe(false);
      names.add(spec.displayName);
      suited.add(spec.suitedFor);
    }
  });

  it('主题提示表覆盖全部主题 (含此前漏掉的 navy-gold)', () => {
    for (const spec of SPECS) {
      expect(THEME_HINTS[spec.theme.id as keyof typeof THEME_HINTS], `缺 ${spec.theme.id} 的提示`).toBeTruthy();
    }
  });

  it('DEFAULT_STYLE_SPEC 仍在库里', () => {
    expect(STYLE_SPECS[DEFAULT_STYLE_SPEC.id]).toBe(DEFAULT_STYLE_SPEC);
  });
});

describe('风格冻结件的字段都是可执行的值', () => {
  const MOTIFS = new Set(['chevron', 'ribbon', 'capsule', 'line', 'none']);
  const TRANSITIONS = new Set(['none', 'fade', 'push', 'wipe', 'morph']);
  const BUILDS = new Set(['none', 'fadeIn', 'riseIn', 'wipeIn']);
  const IMAGERY = new Set(['generate', 'search', 'none', 'draw']);

  it.each(SPECS.map((s) => [s.id, s] as [string, StyleSpec]))('%s 的 motif / 动效 / 栅格合法', (_id, spec) => {
    expect(MOTIFS.has(spec.motif)).toBe(true);
    expect(TRANSITIONS.has(spec.motion.transition)).toBe(true);
    expect(BUILDS.has(spec.motion.build)).toBe(true);
    expect(spec.motion.stagger).toBeGreaterThanOrEqual(0);
    expect(spec.motion.stagger).toBeLessThanOrEqual(0.5);

    for (const key of ['sm', 'md', 'lg', 'path'] as const) {
      expect(Number.isFinite(spec.radius[key])).toBe(true);
      expect(spec.radius[key]).toBeGreaterThanOrEqual(0);
    }

    expect(spec.grid.cols).toBeGreaterThanOrEqual(6);
    expect(spec.grid.gutter).toBeGreaterThan(0);
    expect(spec.grid.baseline).toBeGreaterThan(0);
    expect(spec.grid.margin.left).toBeGreaterThan(0);
    expect(spec.grid.margin.right).toBeGreaterThan(0);
    expect(spec.grid.margin.top).toBeGreaterThan(0);
    expect(spec.grid.margin.bottom).toBeGreaterThan(0);

    for (const key of ['display', 'title', 'body', 'caption', 'numeral'] as const) {
      const t = spec.type[key];
      expect(t.size, `${spec.id}.${key}.size`).toBeGreaterThan(0);
      expect(t.lineHeight, `${spec.id}.${key}.lineHeight`).toBeGreaterThanOrEqual(1);
    }
    /* 层级必须真的拉开 —— 标题和正文同字号等于没有层级 */
    expect(spec.type.display.size).toBeGreaterThan(spec.type.title.size);
    expect(spec.type.title.size).toBeGreaterThan(spec.type.body.size);
    expect(spec.type.body.size).toBeGreaterThan(spec.type.caption.size);

    expect(IMAGERY.has(spec.imagery.abstract)).toBe(true);
    expect(IMAGERY.has(spec.imagery.concrete)).toBe(true);
    expect(IMAGERY.has(spec.imagery.decorative)).toBe(true);
  });

  it('两套新增风格不能只是换色: motif 组合在两批之间有区分度', () => {
    const added = ADDED_IDS.map((id) => STYLE_SPECS[id]!);
    const motifs = new Set(added.map((s) => s.motif));
    /* 新增 6 套里至少覆盖 4 种形态语言, 不许 6 套同一个 motif */
    expect(motifs.size).toBeGreaterThanOrEqual(4);
  });
});

describe('字体与对比度 (风格库上线前的硬门槛)', () => {
  it('每套风格的五个字体都有烘焙 metrics', () => {
    for (const spec of SPECS) {
      for (const [role, family] of Object.entries(spec.theme.fonts)) {
        expect(hasFontMetrics(family), `${spec.id} ${role}=${family} 缺 metrics`).toBe(true);
      }
    }
  });

  it('muted / ink / onInk 在各自纸底上达到 WCAG AA (4.5)', () => {
    for (const spec of SPECS) {
      const t = spec.theme;
      expect(contrast(t.muted, t.paper), `${spec.id} muted/paper`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.ink, t.paper), `${spec.id} ink/paper`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.onInk, t.ink), `${spec.id} onInk/ink`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('深色主题 (tech-dark) 的 ink 是浅字、onInk 是深字 —— 不能照抄浅色主题', () => {
    const t = STYLE_SPECS['tech-dark']!.theme;
    expect(lum(t.paper)).toBeLessThan(0.2);
    expect(lum(t.ink)).toBeGreaterThan(0.5);
    expect(lum(t.onInk)).toBeLessThan(0.2);
  });
});

describe('pickStyleForBrief: 不问也能挑对', () => {
  const cases: Array<[string, string]> = [
    ['给银行做年度经营汇报', 'finance-navy'],
    ['区政府政务公开工作汇报', 'gov-red'],
    ['医院临床护理质量改进汇报', 'medical-calm'],
    ['初一生物课件: 细胞的结构', 'education-fresh'],
    ['毕业论文答辩 PPT', 'academic-serif'],
    ['大模型发布会技术方案', 'tech-dark'],
    ['极简黑白品牌提案', 'mono-minimal'],
    ['公司年度表彰大会', 'bold-ribbon'],
    ['门店陈列技术复盘', 'minimal-line'],
  ];

  it.each(cases)('「%s」→ %s', (brief, expected) => {
    expect(pickStyleForBrief(brief).id).toBe(expected);
  });

  it('什么都没说时兜底商务推进', () => {
    expect(pickStyleForBrief('帮我做个 PPT').id).toBe('corporate-chevron');
    expect(pickStyleForBrief('').id).toBe('corporate-chevron');
  });

  it('政务优先于表彰: 「政务表彰」走政务红而不是誓师红', () => {
    expect(pickStyleForBrief('政务表彰大会').id).toBe('gov-red');
  });
});
