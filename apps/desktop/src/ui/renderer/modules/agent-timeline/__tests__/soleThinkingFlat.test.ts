import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(
  join(__dirname, '..', 'agent-timeline.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length));

const TSX = readFileSync(
  join(__dirname, '..', 'components', 'ActivityRow.tsx'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length));

/** 取所有选择器命中 `.is-sole-thinking <suffix>` 的规则体。 */
function bodiesFor(suffix: string): string[] {
  const re = new RegExp(
    `([^{}]*\\.is-sole-thinking[^{}]*${suffix.replace('.', '\\.')})\\s*\\{([^}]*)\\}`,
    'g',
  );
  return [...CSS.matchAll(re)].map((m) => m[2]);
}

describe('只有一次思考的活动', () => {
  it('自检: 两个源文件都读到了', () => {
    /* 对照组 —— 路径或注释剥离写错时先红, 免得下面在空集上假绿 */
    expect(CSS).toContain('.atl-activity__head');
    expect(TSX).toContain('atl-activity__icon');
  });

  it('ActivityRow 会挂 is-sole-thinking', () => {
    expect(TSX).toMatch(/soleThinkingChild\s*\?\s*["'] is-sole-thinking["']/);
  });

  it('图标照画, 栅格盒子当然也留着', () => {
    expect(TSX).toMatch(/<IconLayers\s+size=\{14\}\s*\/>/);
    /* 真正要守的还是那条: 不许因为"只有一次思考"就把整个 icon 槽拿掉 —— 少一个子元素
     * 不会让 grid 少一列, 只会让每个孩子往左错一格, 折叠摘要「思考」被裁成一个「思」字。 */
    expect(TSX).not.toMatch(/!soleThinkingChild\s*&&\s*\(\s*<span[^>]*atl-activity__icon/);
    expect(TSX).not.toMatch(/soleThinkingChild\s*&&\s*null\s*:\s*<span[^>]*atl-activity__icon/);
  });

  it('折叠头仍是四槽 —— 只是第一槽归零', () => {
    const heads = bodiesFor('.atl-activity__head');
    expect(heads.length).toBeGreaterThan(0);
    const grid = heads.map((b) => b.match(/grid-template-columns\s*:([^;]+);/)).find(Boolean);
    expect(grid).toBeTruthy();
    const tracks = (grid as RegExpMatchArray)[1]
      .replace(/!important/, '')
      .replace(/minmax\([^)]*\)/g, 'T')
      .trim()
      .split(/\s+/);
    expect(tracks).toHaveLength(4);
    expect(tracks[0]).toBe('0');
  });

  it('折叠头与思考正文吃同一个内距变量', () => {
    const head = bodiesFor('.atl-activity__head').join('\n');
    const inner = bodiesFor('.atl-activity__body-shell-inner').join('\n');
    expect(head).toMatch(/padding-left\s*:\s*var\(--atl-think-inset\)/);
    expect(inner).toMatch(/padding-left\s*:\s*var\(--atl-think-inset\)/);
  });

  it('那张看不见的卡: 底色和内距一起拆', () => {
    const think = bodiesFor('.atl-thinking').join('\n');
    expect(think).toMatch(/background\s*:\s*none\s*!important/);
    expect(think).toMatch(/padding\s*:\s*0\s*!important/);
    expect(think).toMatch(/margin\s*:\s*0\s*!important/);
  });
});

/* 算选择器特异度的类计数部分 (0,B,0 里的 B) —— 这个文件里的对手全是纯类选择器,
 * 够用了。`:not(.x)` 里的 .x 也计数, 跟 CSS 规范一致。 */
function classCount(sel: string): number {
  return (sel.match(/\.[A-Za-z_][\w-]*/g) ?? []).length
    + (sel.match(/\[[^\]]+\]/g) ?? []).length;
}

/** 取规则组里**最强**的那一支 —— 逗号分组的特异度是逐支各算的。 */
function maxClassCount(selectorGroup: string): number {
  return Math.max(...selectorGroup.split(',').map((s) => classCount(s.trim())));
}

/** 所有设了 padding-left 且能命中活动子行的规则 (选择器组, 值, 是否 !important)。 */
function paddingRulesOnActivityChild(): Array<{ sel: string; body: string }> {
  const out: Array<{ sel: string; body: string }> = [];
  for (const m of CSS.matchAll(/([^{}]*\.atl-row-clamp[^{}]*)\{([^}]*)\}/g)) {
    if (!/padding-left|padding\s*:/.test(m[2])) continue;
    out.push({ sel: m[1].trim(), body: m[2] });
  }
  return out;
}

describe('思考正文的左缘 —— 特异度必须真的赢', () => {
  it('自检: 真的抓到了别的 padding 规则当对手', () => {
    const rivals = paddingRulesOnActivityChild().filter((r) => !r.sel.includes('is-sole-thinking'));
    expect(rivals.length).toBeGreaterThan(3);
  });

  it('sole-thinking 的清零规则特异度 > 所有对手', () => {
    const all = paddingRulesOnActivityChild();
    const mine = all.filter((r) => r.sel.includes('is-sole-thinking'));
    const rivals = all.filter((r) => !r.sel.includes('is-sole-thinking'));
    expect(mine.length).toBeGreaterThan(0);
    const mineSpec = Math.max(...mine.map((r) => maxClassCount(r.sel)));
    const rivalSpec = Math.max(...rivals.map((r) => maxClassCount(r.sel)));
    expect(mineSpec).toBeGreaterThan(rivalSpec);
  });

  it('而且带 !important —— 对手全都带', () => {
    const mine = paddingRulesOnActivityChild().filter((r) => r.sel.includes('is-sole-thinking'));
    for (const r of mine) expect(r.body).toMatch(/padding-left\s*:\s*0\s*!important/);
  });
});
