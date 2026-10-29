import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC_PATH = join(__dirname, '..', 'SessionSearchPalette.tsx');
const SRC = readFileSync(SRC_PATH, 'utf8');
const CODE = SRC
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/^\s*\/\/.*$/gm, '');

describe('会话搜索的空态', () => {
  it('测试指着的确实是那个组件 (路径自检)', () => {
    expect(SRC).toContain('SharedMatchHit');
    expect(SRC).toContain('searchSessions');
  });

  it('有在途标志, 且 IPC 的每条出口都会把它落下', () => {
    expect(SRC).toMatch(/const \[searching, setSearching\]/);
    /* 起点 + then + catch + 早退分支都要有, 少一条就会卡在"搜索中"下不来 */
    expect((SRC.match(/setSearching\(false\)/g) ?? []).length,
      'setSearching(false) 至少要覆盖 then / catch / 未打开 / 空查询 / 无 IPC 五个出口').toBeGreaterThanOrEqual(5);
    expect(SRC).toMatch(/setSearching\(true\)/);
  });

  it('「未找到」这一支被在途条件挡住', () => {
    const at = CODE.indexOf('未找到包含');
    expect(at, '找不到那条空态文案, 闸失效了').toBeGreaterThan(0);
    /* 往前取一段, 那就是它的渲染条件 */
    const cond = CODE.slice(Math.max(0, at - 600), at);
    expect(cond,
      '「未找到」必须等搜索真的结束再说 —— 条件里要有 !searching').toMatch(/!searching/);
    expect(cond,
      'useDeferredValue 有滞后期: 用户敲了新字但 effect 还没跑, 那一小段 searching 仍是 false, '
      + '光靠它还会闪一下 —— 条件里要比较 query 和 deferredQuery').toMatch(/deferredQuery/);
  });

  it('在途时给的是"搜索中"而不是空白', () => {
    expect(SRC).toMatch(/搜索中…/);
    expect(SRC).toMatch(/Searching…/);
  });
});
