import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'TimelineComposer.tsx'), 'utf8');
/* 注释里出现的同名词不算数 —— 只看真代码 (行数保持不变, 便于对照). */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/^\s*\/\/.*$/gm, '');

describe('两段式回车的接线', () => {
  it('自检: 读到的是 composer 源码', () => {
    expect(CODE).toContain('draftQueue');
    expect(CODE).toContain('flushDrafts');
  });

  it('空输入的回车必须先处理待发送, 不能直接 return 去滚动', () => {
    const i = CODE.indexOf("if (e.key === 'Enter' && !e.shiftKey");
    expect(i, '找不到回车发送分支').toBeGreaterThan(-1);
    /* 从回车分支到"滚到底"那句之间, 必须先出现 draftQueue 的判定 */
    const scrollAt = CODE.indexOf('scrollHeight', i);
    expect(scrollAt).toBeGreaterThan(i);
    expect(
      CODE.slice(i, scrollAt),
      '空输入回车在处理待发送之前就 return 了 —— 第二次回车永远不生效',
    ).toContain('draftQueue.length > 0');
  });

  it('submit 的依赖数组带上 draftQueue 和 flushDrafts', () => {
    const m = CODE.match(/\}, \[value, streaming, onInject[^\]]*\]\);/);
    expect(m, '找不到 submit 的依赖数组').not.toBeNull();
    const depList = m![0];
    expect(depList, 'submit 闭包会拿到旧的 draftQueue').toContain('draftQueue');
    expect(depList, 'submit 闭包会拿到旧的 flushDrafts').toContain('flushDrafts');
  });

  it('回车一次就交给引擎, 排在本轮结束之后', () => {
    const i = CODE.indexOf('setDraftQueue((d) => [...d,');
    expect(i, '找不到运行中回车那一支').toBeGreaterThan(-1);
    expect(CODE.slice(i, i + 300)).toMatch(/onInject\([^)]*\{\s*when:\s*'turn-end'\s*\}\)/);
  });

  it('没有任何 effect 在 streaming 结束时把药丸倒回输入框', () => {
    expect(CODE).not.toMatch(/const drafts = takeDrafts\(\);[\s\S]{0,200}setValue/);
  });

  it('待发送药丸挂在 __box 外面 (boxwrap), 不许塞进 input-wrap', () => {
    const pill = CODE.indexOf('atl-composer__queued--draft');
    const boxwrap = CODE.indexOf('atl-composer__boxwrap');
    const box = CODE.indexOf('className={`atl-composer__box$');
    expect(pill).toBeGreaterThan(-1);
    expect(boxwrap).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(-1);
    /* 顺序即层级: boxwrap 开标签 → 药丸 → box 开标签。
     * 药丸跑到 box 之后就说明它被塞进输入框内部了 (input-wrap 是 flex-row, 会把
     * 输入框挤窄, 提示行直接消失)。 */
    expect(pill).toBeGreaterThan(boxwrap);
    expect(pill, '药丸被塞进了 __box 内部 —— 那一层是 flex-row, 会挤扁输入框').toBeLessThan(box);
  });
});
