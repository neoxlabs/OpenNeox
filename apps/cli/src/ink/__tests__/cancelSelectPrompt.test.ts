import { describe, it, expect } from 'vitest';
import { InkUIAdapter } from '../InkUIAdapter.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeAdapter(): InkUIAdapter {
  return new InkUIAdapter({
    version: 'test',
    provider: 'test',
    model: 'test-model',
    workDir: process.cwd(),
  });
}

function menuActive(adapter: InkUIAdapter): boolean {
  return (adapter as any).runtime.isSelectMenuActive() as boolean;
}

describe('cancelActiveSelectPrompt', () => {
  it('收起正在等键盘的选择框, 并让 promptSelect 返回 null', async () => {
    const ui = makeAdapter();
    const pending = ui.promptSelect({
      message: '要不要保留兼容',
      choices: [{ title: '保留', value: '保留' }],
    });

    /* promptSelect 有 100ms 的防残影延时, 等它真正弹出来再撤 */
    await sleep(150);
    expect(menuActive(ui)).toBe(true);

    expect(ui.cancelActiveSelectPrompt()).toBe(true);
    await expect(pending).resolves.toBeNull();
    expect(menuActive(ui)).toBe(false);
    /* 已经收掉了, 再撤一次不能假装收了 */
    expect(ui.cancelActiveSelectPrompt()).toBe(false);
  });

  it('还没弹出来就被撤销: 之后也不会再画出来', async () => {
    const ui = makeAdapter();
    const pending = ui.promptSelect({
      message: '要不要保留兼容',
      choices: [{ title: '保留', value: '保留' }],
    });

    /* 立刻撤 (100ms 延时还没到) */
    expect(ui.cancelActiveSelectPrompt()).toBe(true);
    await expect(pending).resolves.toBeNull();

    await sleep(150);
    expect(menuActive(ui)).toBe(false);
  });
});
