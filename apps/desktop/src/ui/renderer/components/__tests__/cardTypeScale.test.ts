import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'neox-cards.css'),
  'utf8',
);
const MD = fs.readFileSync(
  path.join(__dirname, '..', 'Markdown.tsx'),
  'utf8',
);
const TSX = fs.readFileSync(
  path.join(__dirname, '..', 'NeoxCards.tsx'),
  'utf8',
);

/** 信息类卡的选择器前缀 —— 生活场景卡 (ncard-tk/tp/pd/rc/bk/n/wx) 不在内 */
const INFO_PREFIXES = [
  'nrpt', 'nrep', 'nhead', 'nstats', 'nsec', 'nstep', 'nflow', 'ntl',
  'nchart', 'ncall', 'ncard-c', 'ndiff',
];

/** SVG 内部的文字 —— user-space 单位, 必须写绝对值 (见文件头豁免 1) */
const SVG_TEXT = new Set([
  '.nchart__cat', '.nchart__tick', '.nchart__col-val',
  '.nchart__gauge-val', '.nchart__bar-in', '.nchart__unit', '.nchart__delta',
]);

interface Rule { selector: string; body: string; }

function rules(): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS))) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

function isInfoCard(selector: string): boolean {
  return INFO_PREFIXES.some((p) => selector.includes(`.${p}`));
}

function isSvgText(selector: string): boolean {
  const last = lastSelector(selector);
  return [...SVG_TEXT].some((s) => last === s || last.endsWith(` ${s}`));
}

/** 规则的"最后一行选择器" —— 多选择器规则里用它对照豁免名单 */
function lastSelector(selector: string): string {
  const lines = selector.split('\n').map((x) => x.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? selector;
}

describe('富卡片字号阶梯', () => {
  it('阶梯本身是相对单位 —— 绝对像素会让卡片脱离它所在的正文', () => {
    for (const token of ['--ncard-fs-title', '--ncard-fs-body', '--ncard-fs-sub', '--ncard-fs-meta']) {
      const m = new RegExp(`${token}:\\s*([^;]+);`).exec(CSS);
      expect(m, `${token} 没定义`).not.toBeNull();
      expect(m![1].trim(), `${token} 必须是 em`).toMatch(/em\s*$/);
    }
  });

  it('信息类卡里没有写死的 font-size (SVG 内部文字除外)', () => {
    const offenders: string[] = [];
    for (const r of rules()) {
      if (!isInfoCard(r.selector)) continue;
      if (isSvgText(r.selector)) continue;
      const fs = /font-size:\s*([^;]+);/.exec(r.body);
      if (!fs) continue;
      const v = fs[1].trim();
      if (v.includes('var(--ncard-fs') || /em\s*$/.test(v)) continue;
      offenders.push(`${lastSelector(r.selector)} → ${v}`);
    }
    expect(offenders, `这些规则脱离了字号阶梯:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('两套报告卡实现都在扫描范围内 (只修一边是这轮最贵的错)', () => {
    expect(CSS).toContain('.nrpt__title');
    expect(CSS).toContain('.nrep__title');
  });

  it('图标不带彩底 —— 设计铁律: 图标永远裸, 无彩底 chip / inset 高光 / 圆角块', () => {
    for (const mark of ['.nhead__mark', '.nrep__mark', '.nrpt__badge']) {
      const r = rules().find((x) => lastSelector(x.selector) === mark);
      expect(r, `${mark} 规则不见了`).toBeDefined();
      expect(r!.body, `${mark} 又长出彩底了`).toMatch(/background:\s*none/);
      expect(r!.body, `${mark} 又长出圆角块了`).toMatch(/border-radius:\s*0/);
      expect(r!.body, `${mark} 又长出 inset 高光了`).not.toMatch(/box-shadow:\s*inset/);
    }
  });

  it('即时 UI 通栏 + 中间图形 float —— 不许再缩成 max-content 孤岛', () => {
    const nrpt = rules().find((x) => lastSelector(x.selector) === '.ncard.nrpt');
    expect(nrpt, '.ncard.nrpt 规则不见了').toBeDefined();
    expect(nrpt!.body, '回执卡必须拉满栏宽').toMatch(/width:\s*100%/);
    expect(nrpt!.body, '不许再缩成内容宽度孤岛').not.toMatch(/width:\s*max-content/);
    expect(nrpt!.body, 'overflow:hidden 会剪掉环绕').not.toMatch(/overflow:\s*hidden/);

    const fig = rules().find((x) => lastSelector(x.selector) === '.ncard__figure');
    expect(fig, '.ncard__figure 规则不见了').toBeDefined();
    expect(fig!.body, '中间图形必须 float, 文字才能绕').toMatch(/float:\s*right/);

    const hero = rules().find((x) => lastSelector(x.selector) === '.nrpt__hero');
    expect(hero, '.nrpt__hero 规则不见了').toBeDefined();
    expect(hero!.body, '标题必须是行框才能绕过 float, 不能再是 flex 行').toMatch(/display:\s*block/);
    expect(hero!.body).not.toMatch(/display:\s*flex/);

    /* 查 pre 渲染器的代码本身 (不看注释): 卡片围栏时直接返回内层元素, 不再包 <pre> */
    const preAt = MD.indexOf('pre({ node: _node, children, ...props })');
    expect(preAt, '围栏卡必须脱掉 pre, 否则 float 绕不到正文').toBeGreaterThan(0);
    const preBody = MD.slice(preAt, MD.indexOf('\n      },', preAt));
    expect(preBody, 'pre 的脱壳判据必须看围栏语言').toMatch(/language-\(neox-card:/);
    /* 判据后来又并进了 mermaid (同样不能包 pre), 只要卡片围栏在「直接返回内层」的条件里就行 */
    expect(preBody, '卡片围栏要直接返回内层, 不包 pre').toMatch(/if \(only && \(?isCardFence\b[^)]*\)?\) return only;/);

    expect(TSX, 'KPI 又被当成插图 float 了').not.toMatch(/ncard__figure[^"'`\n]*nrpt__kpis/);
    expect(TSX, '总结卡没有插图').toContain('nrpt__viz');
    expect(TSX, '卡要进上一条列表项, 该条正文才能绕').toContain("prev.tagName === 'OL'");
    expect(CSS, 'markdown 里总结卡必须 float, 正文才能绕').toMatch(
      /\.markdown-content \.ncard-wrap:has\(\.ncard--summary\)[\s\S]{0,280}float:\s*right/,
    );
  });
});
