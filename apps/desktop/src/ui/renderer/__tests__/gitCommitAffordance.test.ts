import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(HERE, '../modules/ide-workspace/GitCard.tsx'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

describe('Commit 按钮的可供性', () => {
  it('禁用条件仍是三条: 没写说明 / 没暂存 / 正忙', () => {
    /* 判断可以叫 canCommit 也可以内联, 但三个条件一个都不能少 */
    const m = /const canCommit = ([^\n]+)/.exec(src);
    expect(m, '找不到 canCommit —— 若改成内联表达式, 请把这条一起改').toBeTruthy();
    expect(m![1], '没判"写了说明没"').toMatch(/commitMsg\.trim\(\)/);
    expect(m![1], '没判"有没有暂存"').toMatch(/staged\.length/);
    expect(m![1], '没判"是不是正忙"').toMatch(/busy/);
    /* 按钮必须真的用上它 */
    expect(src).toMatch(/disabled=\{!canCommit\}/);
  });

  it('title 要分情况说清缺什么, 不是一律 "Commit"', () => {
    expect(src).toMatch(/先写一句提交说明/);
    expect(src).toMatch(/先把要提交的文件暂存/);
    expect(src).toMatch(/正在执行 git 操作/);
  });

  it('三句话在同一段 title 里, 不是散落各处的死文案', () => {
    /* 分开出现不算数 —— 三句话必须是同一个三元链的三个分支, 否则可能有两句
     * 是别处剩下的孤儿, 用户实际只会看到其中一句。 */
    const m = /title=\{busy[\s\S]{0,600}?\}\n/.exec(src);
    expect(m, '找不到按 busy 起头的分情况 title').toBeTruthy();
    expect(m![0]).toMatch(/正在执行 git 操作/);
    expect(m![0]).toMatch(/先写一句提交说明/);
    expect(m![0]).toMatch(/先把要提交的文件暂存/);
  });
});
