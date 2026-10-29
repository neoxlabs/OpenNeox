import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'TeamDashboard.tsx'), 'utf8');
/* 注释先换成等量换行 —— 本文件的注释里正当地引用了 `orchestration !== null`
 * 来说明改的是什么, 不剥掉的话闸会咬到注释上。 */
const CODE = SRC
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/^\s*\/\/.*$/gm, '');

describe('团队页的编排开关行', () => {
  it('测试指着的确实是 TeamDashboard (路径自检)', () => {
    expect(CODE).toContain('team-dash__footer');
    expect(CODE).toContain('getAgentRuntimeConfig');
  });

  it('"还没读到"和"读失败"是两个状态, 不共用 null', () => {
    expect(CODE).toMatch(/const \[orchFailed, setOrchFailed\]/);
    expect((CODE.match(/setOrchFailed\(true\)/g) ?? []).length,
      'cfg 为空和抛异常两条路都要标记失败').toBeGreaterThanOrEqual(2);
  });

  it('开关行的显示条件不是"读到了才显示"', () => {
    const at = CODE.indexOf('team-dash__footer');
    const cond = CODE.slice(Math.max(0, at - 200), at);
    expect(cond,
      '这一行是设置项, 加载期间就该占住位置, 否则垂直居中的整块内容会跳').not.toMatch(/orchestration !== null/);
    expect(cond, '只有真读不到才隐藏').toMatch(/!orchFailed/);
  });

  it('加载期间开关不可点, 也不假装"已关闭"', () => {
    expect(CODE).toMatch(/disabled=\{orchestration === null\}/);
    expect(CODE).toMatch(/is-pending/);
  });
});
