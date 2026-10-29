/**
 * CLI-04: ctrl+d 全屏看 diff —— 入口行为。
 *
 * 卡片只显示 12 行 (ToolCard), 全屏视图要能看到卡片之外的完整改动, 并且:
 *   · 走备用屏 (alt screen), 暂停 Ink 输出, 退出时恢复;
 *   · 打开期间 isTranscriptOpen() 为真 (App 的快捷键与输入框都不处理按键);
 *   · 没有 diff 时也不炸, 给一行说明。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildDiffViewerLines, openDiffFullscreen } from '../diffViewer.js';
import { isTranscriptOpen, onTranscriptClosed } from '../transcriptViewer.js';
import { collectDiffViewerSections } from '../utils/diffDisplay.js';

const ESC = '\u001b';

function details(count: number): string {
  const lines = ['H:0:--- a/src/big.ts', 'H:0:+++ b/src/big.ts', `H:0:@@ -1,${count} +1,${count} @@`];
  for (let i = 1; i <= count; i++) lines.push(`+:${i}:const line${i} = ${i};`);
  return lines.join('\n');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('diffViewer · buildDiffViewerLines', () => {
  it('没有改动时给一行说明, 不是空视图', () => {
    const lines = buildDiffViewerLines([], { zh: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('还没有改动');
  });

  it('多段之间空一行, 每段先给标题', () => {
    const sections = collectDiffViewerSections([
      { type: 'file_update', text: 'Edited a.ts +1 -0', details: details(2) },
      { type: 'file_update', text: 'Edited b.ts +1 -0', details: details(2) },
    ]);
    const lines = buildDiffViewerLines(sections);
    expect(lines[0]).toContain('Edited a.ts');
    expect(lines).toContain('');
    expect(lines.some(l => l.includes('Edited b.ts'))).toBe(true);
  });

  it('30 行改动整段都在 (不被卡片那 12 行折叠影响)', () => {
    const sections = collectDiffViewerSections([
      { type: 'file_update', text: 'Edited big.ts +30 -0', details: details(30) },
    ]);
    const lines = buildDiffViewerLines(sections);
    expect(lines.join('\n')).toContain('const line30 = 30;');
  });
});

describe('diffViewer · openDiffFullscreen', () => {
  afterEach(async () => {
    // 让 isTranscriptOpen 的 150ms 冷却过去, 不影响后续用例
    await sleep(170);
  });

  it('打开备用屏, 暂停 Ink, 写入完整 diff, q 关闭后恢复', async () => {
    const written: string[] = [];
    const paused: boolean[] = [];
    let closed = 0;
    const off = onTranscriptClosed(() => { closed++; });

    const ok = openDiffFullscreen({
      entries: [{ type: 'file_update', text: 'Edited big.ts +30 -0', details: details(30) }],
      write: s => written.push(s),
      setInkPaused: p => paused.push(p),
      onClosed: () => { /* 由 closeListeners 统一计数 */ },
    });

    expect(ok).toBe(true);
    expect(isTranscriptOpen()).toBe(true);
    expect(paused).toEqual([true]);
    // 进入备用屏 + 隐藏光标
    expect(written[0]).toContain(`${ESC}[?1049h`);
    expect(written[0]).toContain(`${ESC}[?25l`);
    // 全屏里能看到第 30 行 (卡片里只显示 12 行)
    expect(written.join('')).toContain('const line30 = 30;');
    // 标题 (语言跟随 i18n, 测试环境默认英文)
    expect(written.join('')).toMatch(/Changes|改动/);

    // 头 150ms 的按键被忽略 (打开它的那个键可能又投递过来), 过了再收 q
    await sleep(160);
    process.stdin.emit('data', Buffer.from('q'));
    await sleep(20);

    expect(paused).toEqual([true, false]);
    expect(written.join('')).toContain(`${ESC}[?1049l`);
    expect(closed).toBe(1);
    off();
  });

  it('备用屏已经被占着时不再打开 (不叠加两层视图)', () => {
    const first = openDiffFullscreen({
      entries: [{ type: 'file_update', text: 'Edited x.ts +1 -0', details: details(1) }],
      write: () => { /* noop */ },
      setInkPaused: () => { /* noop */ },
    });
    expect(first).toBe(true);

    const second = openDiffFullscreen({
      entries: [{ type: 'file_update', text: 'Edited y.ts +1 -0', details: details(1) }],
      write: () => { /* noop */ },
      setInkPaused: () => { /* noop */ },
    });
    expect(second).toBe(false);

    process.stdin.emit('data', Buffer.from('q'));
  });
});
