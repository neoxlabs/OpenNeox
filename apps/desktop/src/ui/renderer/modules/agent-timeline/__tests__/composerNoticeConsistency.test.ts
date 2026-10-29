import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS_TL = readFileSync(join(__dirname, '..', 'agent-timeline.css'), 'utf8');
const CSS_QUOTA = readFileSync(
  join(__dirname, '..', '..', '..', 'styles', 'billing-quota.css'), 'utf8');
const COMPOSER = readFileSync(join(__dirname, '..', 'TimelineComposer.tsx'), 'utf8');

/** 抠出一条规则的主体 */
function ruleOf(css: string, selector: string): string {
  const re = new RegExp(`^\\.${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`, 'm');
  return re.exec(css)?.[1] ?? '';
}

describe('输入框区提示条视觉一致', () => {
  it('两个源文件都真的读到了 —— 路径错会让整组闸静悄悄什么都不测', () => {
    expect(CSS_TL.length).toBeGreaterThan(10000);
    expect(CSS_QUOTA.length).toBeGreaterThan(2000);
    expect(COMPOSER.length).toBeGreaterThan(10000);
  });

  it('目标条和额度条确实是相邻渲染的 —— 这是"必须一致"的前提', () => {
    /* 额度条是发行版插槽 (composer.quota.banner → billing/QuotaInlineBanner), 挂载点紧跟目标条 */
    expect(COMPOSER).toMatch(/<TargetInlineBanner[\s\S]{0,120}?<UiSlot name="composer\.quota\.banner"/);
  });

  it('两条都是 999px 胶囊, 跟输入框本体同一套语言', () => {
    for (const [css, sel] of [[CSS_TL, 'target-inline-banner'], [CSS_QUOTA, 'quota-inline-banner']] as const) {
      const body = ruleOf(css, sel);
      expect(body, `找不到 .${sel}`).not.toBe('');
      expect(body, `${sel} 应当是 999px 胶囊`).toMatch(/border-radius:\s*999px/);
    }
  });

  it('两条都无边框 —— 色调只由底色和图标承担', () => {
    const t = ruleOf(CSS_TL, 'target-inline-banner');
    const q = ruleOf(CSS_QUOTA, 'quota-inline-banner');
    /* 目标条本来就没写 border; 额度条是显式 border: 0。两种都算无边框, 只挡"写了实线边框"。 */
    expect(t).not.toMatch(/border:\s*\d+px\s+solid/);
    expect(q).not.toMatch(/border:\s*\d+px\s+solid/);
  });

  it('两条都 hug 内容 —— 父容器是 display:block, width:auto 会填满整宽', () => {
    /* 这是修额度条时量出来的坑: align-self 在块级父容器里是死的, 必须 fit-content。 */
    expect(ruleOf(CSS_TL, 'target-inline-banner')).toMatch(/width:\s*fit-content/);
    expect(ruleOf(CSS_QUOTA, 'quota-inline-banner')).toMatch(/width:\s*fit-content/);
  });
});
