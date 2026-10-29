import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..');   /* → renderer */

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 三元里一边是人民币符号、另一边是美元符号 —— 就是"货币跟语言走"。 */
const CURRENCY_BY_LANG = /['"`]¥['"`]\s*:\s*['"`]\$['"`]|['"`]\$['"`]\s*:\s*['"`]¥['"`]/;

describe('货币不跟语言走', () => {
  it('渲染层里没有「中文显示 ¥ / 英文显示 $」这种三元', () => {
    const offenders: string[] = [];
    for (const f of walk(ROOT)) {
      const src = stripComments(readFileSync(f, 'utf8'));
      if (CURRENCY_BY_LANG.test(src)) offenders.push(f.replace(ROOT, ''));
    }
    expect(
      offenders,
      `这些文件让货币符号跟界面语言走 —— 切个语言价格就差 7 倍: ${offenders.join(' / ')}`,
    ).toEqual([]);
  });

  /* 订阅页是发行版文件 (edition/), 没有账号体系的构建里不存在 */
  const SUBSCRIPTION_TAB = join(ROOT, 'modules/shell/edition/SubscriptionTab.tsx');
  it.runIf(existsSync(SUBSCRIPTION_TAB))('订阅页的价格恒用 $ —— 它是用户决定付钱的那一屏', () => {
    const src = stripComments(readFileSync(SUBSCRIPTION_TAB, 'utf8'));
    expect(src).toMatch(/const priceLabel[\s\S]{0,240}?\$\$\{\(priceCents \/ 100\)/);
    /* 语言仍可决定"/月" vs "/mo" —— 那是语言, 不是货币 */
    expect(src).toMatch(/zh \? '\/月' : '\/mo'/);
  });
});
