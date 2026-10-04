/**
 * Regression coverage for the bottom bar width invariant. The right column is
 * measured and the left column uses that width, so every rendered row stays
 * within the terminal width across narrow, boundary, common, and wide sizes.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import stringWidth from 'string-width';
import { render } from '../../../vendor/ink/src/index.js';
import { App } from '../App.js';

function createFakeStdout(cols: number, rows = 40) {
  const frames: string[] = [];
  const stream: any = new EventEmitter();
  stream.columns = cols;
  stream.rows = rows;
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

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/* 取最后一帧**真正的 UI 画面**。
 * 坑: Ink 除了画面还会往 stdout 写控制序列 (如开 bracketed-paste 的 \x1b[?2004h),
 * 直接取 frames[last] 很可能拿到那种一行控制码 —— 于是"没有超宽的行"这个断言恒真, 测试全绿
 * 却什么都没测到 (本次开发中就先踩了一次)。判据: 帧里必须有输入框那两条整行 '─'。 */
function lastUiFrame(frames: string[]): string {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = strip(frames[i]);
    if (f.split('\n').some(l => /^─{20,}$/.test(l.trim()))) return f;
  }
  throw new Error(`没有捕获到 UI 帧 (共 ${frames.length} 次 write) —— 断言会变成空跑, 先修取帧`);
}

/** 真实的大数字 token 统计 —— 小数字撑不出问题, 必须用用户实际会遇到的量级 */
const TOKEN_STATS = {
  input: 988,
  output: 932,
  total: 140800,
  contextWindow: 272000,
  tokensUsedForContext: 140800,
  pressure: 0.52,
  cacheCreationTokens: 0,
  cacheReadTokens: 139800,
};

describe('底部栏宽度自适应', () => {
  // 80=窄, 100/110=当年出事的临界档, 120/160=宽
  for (const cols of [80, 100, 110, 120, 160]) {
    it(`${cols} 列: 每一行都不超过终端宽度`, () => {
      const { stream, frames } = createFakeStdout(cols);
      const stdin = createFakeStdin();
      const realCols = process.stdout.columns;
      // BottomBar/StatusLine 直接读 process.stdout.columns (多容器下 context 会 stale), 测试里对齐
      Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });

      try {
        const instance = render(
          <App
            zone="bottom"
            isRunning
            showHeader={false}
            provider="MKGPT"
            model="gpt-5.6-terra (xhigh)"
            statusText="Shell running... 5m 5s"
            tokenStats={TOKEN_STATS}
            workDir="/Users/someone/AI/MK/codex-config-ui"
            runMode="agentic"
            staticEntries={[]}
            pendingEntries={[]}
            backgroundTasks={[
              { id: 1, command: 'npm run cdp:dev', pid: 111, status: 'running', startTime: Date.now() - 5000, output: [] },
              { id: 2, command: 'npm run watch', pid: 112, status: 'running', startTime: Date.now() - 9000, output: [] },
            ]}
            onSubmit={() => {}}
            onInterrupt={() => {}}
            onExit={() => {}}
          />,
          { stdout: stream, stdin, debug: true, patchConsole: false, exitOnCtrlC: false, incrementalRendering: false },
        );

        const frame = lastUiFrame(frames);
        instance.unmount();
        instance.cleanup();

        const over = frame
          .split('\n')
          .map((l, i) => ({ i, w: stringWidth(l), l }))
          .filter(x => x.w > cols);

        expect(
          over.map(x => `第${x.i}行 宽${x.w}>${cols}: ${x.l.slice(0, 90)}`).join('\n'),
        ).toBe('');
      } finally {
        Object.defineProperty(process.stdout, 'columns', { value: realCols, configurable: true });
      }
    });
  }

  it('ctx 百分比在最窄档也必须还在 (它是唯一不许被挤掉的)', () => {
    const cols = 80;
    const { stream, frames } = createFakeStdout(cols);
    const stdin = createFakeStdin();
    const realCols = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
    try {
      const instance = render(
        <App
          zone="bottom" isRunning showHeader={false} provider="MKGPT" model="gpt-5.6-terra"
          statusText="Shell running... 5m 5s" tokenStats={TOKEN_STATS} runMode="agentic"
          staticEntries={[]} pendingEntries={[]}
          onSubmit={() => {}} onInterrupt={() => {}} onExit={() => {}}
        />,
        { stdout: stream, stdin, debug: true, patchConsole: false, exitOnCtrlC: false, incrementalRendering: false },
      );
      const frame = lastUiFrame(frames);
      instance.unmount();
      instance.cleanup();
      expect(frame).toMatch(/52%/);
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: realCols, configurable: true });
    }
  });
});
