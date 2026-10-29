/**
 * 状态行空闲时显示上一轮首字 (code:CLI-02)。
 *
 * TUI 没法截图, 就用仓库现有的离线渲染台 (同 bottomBarFit.test.tsx):
 * 真实 Ink 渲染一帧, 断言“Done in… · 首字 …”真的出现在界面上。
 */
import React from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import chalk from 'chalk';
import { render } from '../../../../vendor/ink/src/index.js';
import { StatusLine } from '../StatusLine.js';
import { recordTurnPerf } from '../../../utils/turnPerf.js';
import { setLanguage } from '../../../i18n/index.js';

function createFakeStdout(cols = 120) {
  const frames: string[] = [];
  const stream: any = new EventEmitter();
  stream.columns = cols;
  stream.rows = 40;
  stream.isTTY = true;
  stream.write = (c: string) => { frames.push(String(c)); return true; };
  stream.end = () => {};
  return { stream, frames };
}

function createFakeStdin() {
  const s: any = new EventEmitter();
  s.isTTY = true;
  s.setRawMode = () => s; s.setEncoding = () => s; s.resume = () => s;
  s.pause = () => s; s.read = () => null; s.ref = () => s; s.unref = () => s;
  return s;
}

const strip = (s: string): string => chalk.reset(s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 取最后一帧含指定片段的画面 —— Ink 还会写控制序列, 不能直接取最后一帧 */
function lastFrameWith(frames: string[], needle: string): string | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = strip(frames[i]);
    if (f.includes(needle)) return f;
  }
  return null;
}

const TOKEN_STATS = { input: 900, output: 120, total: 1020, contextWindow: 200_000, tokensUsedForContext: 5_000, pressure: 0.03 };

describe('状态行: 上一轮首字', () => {
  beforeEach(() => setLanguage('zh'));

  it('空闲一行写“完成 · 1s · 首字 1.2s”', async () => {
    recordTurnPerf([{ iteration: 1, durationMs: 2000, ttftMs: 1234, firstKind: 'text', toolMs: 0, toolCalls: 0, textChars: 10 }]);
    const { stream, frames } = createFakeStdout();
    const stdin = createFakeStdin();
    const realCols = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });

    try {
      const props = { statusText: '', tokenStats: TOKEN_STATS, runMode: 'agentic' as const };
      const instance = render(
        <StatusLine isRunning {...props} />,
        { stdout: stream, stdin, debug: true, patchConsole: false, exitOnCtrlC: false, incrementalRendering: false },
      );
      await sleep(1100); // 让整轮计时 > 0
      instance.rerender(<StatusLine isRunning={false} {...props} />);
      await sleep(80);

      const frame = lastFrameWith(frames, '完成');
      instance.unmount();
      instance.cleanup();

      expect(frame, `没有渲染出空闲行 (共 ${frames.length} 次 write)`).not.toBeNull();
      expect(frame).toContain('首字 1.2s');
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: realCols, configurable: true });
      recordTurnPerf(null);
    }
  }, 10_000);

  it('没有首字数字时只写 Done, 不编 0ms', async () => {
    recordTurnPerf(null);
    const { stream, frames } = createFakeStdout();
    const stdin = createFakeStdin();
    const realCols = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });

    try {
      const props = { statusText: '', tokenStats: TOKEN_STATS, runMode: 'agentic' as const };
      const instance = render(
        <StatusLine isRunning {...props} />,
        { stdout: stream, stdin, debug: true, patchConsole: false, exitOnCtrlC: false, incrementalRendering: false },
      );
      await sleep(1100);
      instance.rerender(<StatusLine isRunning={false} {...props} />);
      await sleep(80);

      const frame = lastFrameWith(frames, '完成');
      instance.unmount();
      instance.cleanup();

      expect(frame).not.toBeNull();
      expect(frame).not.toContain('首字');
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: realCols, configurable: true });
    }
  }, 10_000);
});
