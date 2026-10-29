import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(__dirname, '..', 'agent-timeline.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length));

/** 取一个 @container 块的整段文本 */
function containerBlock(maxWidthPx: number): string {
  const re = new RegExp(
    `@container\\s+atl-empty\\s*\\(max-width:\\s*${maxWidthPx}px\\s*\\)\\s*\\{`, 'g');
  const m = re.exec(CSS);
  if (!m) return '';
  let depth = 1; let i = m.index + m[0].length; const start = i;
  while (i < CSS.length && depth > 0) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}') depth--;
    i++;
  }
  return CSS.slice(start, i - 1);
}

/** 从一段 CSS 里取某选择器某属性的 px 数值 */
function pxOf(block: string, selector: string, prop: string): number | null {
  const re = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'g');
  for (const m of block.matchAll(re)) {
    const v = m[1].match(new RegExp(`${prop}\\s*:\\s*(?:calc\\()?\\s*(\\d+(?:\\.\\d+)?)px`));
    if (v) return Number(v[1]);
  }
  return null;
}

/** 基准值 —— 顶层(非容器查询内)的那一份 */
function baseValue(selector: string, prop: string): number | null {
  const stripped = CSS.replace(/@container[\s\S]*?\n\}/g, '');
  return pxOf(stripped, selector, prop);
}

describe('首屏头部随面板宽度自适应', () => {
  it('自检: 两个容器查询断点都读到了', () => {
    /* 对照组 —— 正则或断点值改了的话先红, 免得下面在空串上平凡通过 */
    expect(containerBlock(520).length).toBeGreaterThan(20);
    expect(containerBlock(380).length).toBeGreaterThan(20);
  });

  it('用容器查询, 不是视口单位 —— 可用宽度是 panel 宽不是视口宽', () => {
    expect(CSS).toMatch(/\.atl-empty-stage\s*\{[^}]*container-type:\s*inline-size/);
    expect(CSS).toMatch(/container-name:\s*atl-empty/);
    /* 反向: 头部这几个尺寸不许用 vw —— 栏一开就失准 */
    const stripped = CSS.replace(/@container[\s\S]*?\n\}/g, '');
    for (const sel of ['.atl-empty-stage__logo', '.atl-empty-stage__title']) {
      const m = stripped.match(new RegExp(`${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
      if (m) expect(m[1]).not.toMatch(/\dvw/);
    }
  });

  it('每退一档, logo 和标题都要真的变小', () => {
    const baseLogo = baseValue('.atl-empty-stage__logo', 'width');
    const baseTitle = baseValue('.atl-empty-stage__title', 'font-size');
    expect(baseLogo).not.toBeNull();
    expect(baseTitle).not.toBeNull();

    const logo520 = pxOf(containerBlock(520), '.atl-empty-stage__logo', 'width');
    const logo380 = pxOf(containerBlock(380), '.atl-empty-stage__logo', 'width');
    const title520 = pxOf(containerBlock(520), '.atl-empty-stage__title', 'font-size');
    const title380 = pxOf(containerBlock(380), '.atl-empty-stage__title', 'font-size');

    expect(logo520!).toBeLessThan(baseLogo!);
    expect(logo380!).toBeLessThan(logo520!);
    expect(title520!).toBeLessThan(baseTitle!);
    expect(title380!).toBeLessThan(title520!);
  });

  it('长串标题不许撑破容器 —— 缩字号治不了不可断的词', () => {
    const stripped = CSS.replace(/@container[\s\S]*?\n\}/g, '');
    const m = stripped.match(/\.atl-empty-stage__title\s*\{([^}]*)\}/g) ?? [];
    expect(m.join('\n')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
