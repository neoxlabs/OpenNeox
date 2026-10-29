
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'SettingsPage.tsx'), 'utf8');

/** 从源码里把 SETTINGS_SEARCH_INDEX 的条目抠出来 (只要 tab 和有没有 anchor 两件事)。 */
function indexEntries(): Array<{ tab: string; zh: string; hasAnchor: boolean }> {
  const start = SRC.indexOf('SETTINGS_SEARCH_INDEX');
  expect(start, 'SETTINGS_SEARCH_INDEX 不在了 —— 这条闸指着的东西改名了, 先修闸').toBeGreaterThan(-1);
  const end = SRC.indexOf('\n];', start);
  const block = SRC.slice(start, end);
  const out: Array<{ tab: string; zh: string; hasAnchor: boolean }> = [];
  for (const line of block.split('\n')) {
    const m = /\{\s*tab:\s*'([^']+)'.*?zh:\s*'([^']*)'/.exec(line);
    if (!m) continue;
    out.push({ tab: m[1], zh: m[2], hasAnchor: /\banchor:\s*'/.test(line) });
  }
  return out;
}

describe('SETTINGS_SEARCH_INDEX', () => {
  it('抠得出条目 (对照组 —— 解析失败时其余断言会假绿)', () => {
    const all = indexEntries();
    expect(all.length).toBeGreaterThan(20);
    expect(all.some((e) => e.tab === 'about')).toBe(true);
  });

  it('每个 tab 最多只有一条不带 anchor 的 —— 那条才是"这一页叫什么"', () => {
    const byTab = new Map<string, string[]>();
    for (const e of indexEntries()) {
      if (e.hasAnchor) continue;
      byTab.set(e.tab, [...(byTab.get(e.tab) ?? []), e.zh]);
    }
    const offenders = [...byTab.entries()].filter(([, names]) => names.length > 1);
    expect(
      offenders.map(([tab, names]) => `${tab}: ${names.join(' / ')}`),
      '这些 tab 有多条无 anchor 条目。页内条目要补 anchor, 否则 tabLabel() 会取错名字, '
      + '设置页组副标题等处会显示成另一个功能的名字。',
    ).toEqual([]);
  });

  it('带 anchor 的条目, 其 anchor id 必须真的存在于某个 tab 组件里', () => {
    /* 光有 anchor 不够 —— 指向一个不存在的 id, 搜到了也跳不过去。 */
    const tabsDir = join(__dirname, '..', 'tabs');
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const all = readdirSync(tabsDir)
      .filter((f: string) => f.endsWith('.tsx'))
      .map((f: string) => readFileSync(join(tabsDir, f), 'utf8'))
      .join('\n');
    const anchors = [...SRC.matchAll(/anchor:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(0);
    /* 落点可以是写死的 id="…", 也可以是卡片表里的 anchor: '…' (渲染成 id={c.anchor}, 实验页那样) */
    const dangling = anchors.filter((a) => !all.includes(`id="${a}"`) && !all.includes(`anchor: '${a}'`));
    expect(dangling, '这些 anchor 没有对应的 id=... 落点').toEqual([]);
  });
});
