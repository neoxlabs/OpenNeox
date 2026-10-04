/**
 * 输入框锚点稳定性回归测试
 *
 * 背景 : Ink 的 live region 是**顶锚定**的 —— log-update 把上一帧的 N 行擦掉,
 * 从同一个锚点重写。所以输入框的屏幕行号 = 锚点 + 它上方所有 live 内容的高度。一个 turn 里
 * 流式条目 commit 进 static 会让动态区一次塌十几行, 输入框就在"贴屏底"和"屏幕中下部"之间来回跳。
 *
 * 这里不测像素也不测截图, 直接量**帧内输入框所在行号**: 一个 turn 之内它只许往下走, 不许往上跳。
 * 这是 useHeightLock 唯一要保证的性质, 也是用户唯一能感知的性质。
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { render } from '../../../vendor/ink/src/index.js';
import { App } from '../App.js';
import type { TimelineEntry } from '../InkRuntime.js';

const COLUMNS = 80;
const ROWS = 40;

/** 收集 Ink 写出的每一帧 (debug:true → 不走 ANSI 擦除, 每帧原样 write 一次) */
function createFakeStdout() {
  const frames: string[] = [];
  const stream: any = new EventEmitter();
  stream.columns = COLUMNS;
  stream.rows = ROWS;
  stream.isTTY = true;
  stream.write = (chunk: string) => {
    frames.push(String(chunk));
    return true;
  };
  stream.end = () => {};
  return { stream, frames };
}

function createFakeStdin() {
  const stream: any = new EventEmitter();
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.setEncoding = () => stream;
  stream.resume = () => stream;
  stream.pause = () => stream;
  stream.read = () => null;
  stream.ref = () => stream;
  stream.unref = () => stream;
  return stream;
}

/**
 * 输入框在帧内的行号。
 * BottomBar 把 InputLine 夹在两条整行 '─' 之间 (见 BottomBar.tsx), 取第一条分隔线的下一行。
 * 返回 -1 表示这一帧里没有输入框 (菜单态等), 调用方跳过。
 */
function inputRowOf(frame: string): number {
  // eslint-disable-next-line no-control-regex
  const lines = frame.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const border = lines.findIndex(l => l.trim().length > 10 && /^─+$/.test(l.trim()));
  return border < 0 ? -1 : border + 1;
}

/* 组件抛异常时 Ink 会渲一屏 ERROR 面板 —— 它没有输入框, 行号断言会静默跳过整步,
 * 于是"测试全绿"其实是"什么都没测到"(本次开发中就被骗过一次)。这里显式拦下来。 */
function assertNoRenderError(frames: string[]) {
  const bad = frames.find(f => /ERROR|Cannot read properties|is not a function/.test(f));
  if (bad) {
    throw new Error(`Ink 渲染报错, 帧内容:\n${bad.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 800)}`);
  }
}

function makeEntry(id: number, text: string, type = 'assistant'): TimelineEntry {
  return { id, type, text, timestamp: new Date() } as unknown as TimelineEntry;
}

/** 一条会换行的长中文文本 (专门打之前那个"数 \n 当行数"的估算) */
const LONG_ZH = '这是一段会在终端里折行的中文正文内容用来验证高度计算是否把换行算进去了'.repeat(2);

describe('输入框锚点稳定性 (useHeightLock)', () => {
  function renderTurn(steps: Array<{ pending: TimelineEntry[]; static_: TimelineEntry[] }>) {
    const { stream, frames } = createFakeStdout();
    const stdin = createFakeStdin();

    const view = (pending: TimelineEntry[], static_: TimelineEntry[]) => (
      <App
        zone="all"
        isRunning
        showHeader={false}
        provider="test"
        model="test-model"
        staticEntries={static_}
        pendingEntries={pending}
        onSubmit={() => {}}
        onInterrupt={() => {}}
        onExit={() => {}}
      />
    );

    const instance = render(view(steps[0].pending, steps[0].static_), {
      stdout: stream,
      stdin,
      debug: true,           // 同步渲染 + 每帧原样输出, 便于逐帧断言
      patchConsole: false,
      exitOnCtrlC: false,
      incrementalRendering: false,
    });

    const lineCount = (f: string) => f.replace(/\n$/, '').split('\n').length;
    const rows: number[] = [];
    for (const step of steps) {
      instance.rerender(view(step.pending, step.static_));
      /* debug 模式下 static 与 live 分开 write, 且内容没变时不 write。
       * 不含输入框的帧 = static 写出; 最近一帧含输入框的 = 这一步之后的 live 画面。 */
      let staticLines = 0;
      let liveRow = -1;
      for (const f of frames) {
        const row = inputRowOf(f);
        if (row < 0) staticLines += lineCount(f);
        else liveRow = row;
      }
      if (liveRow >= 0) rows.push(staticLines + liveRow);
    }

    assertNoRenderError(frames);
    instance.unmount();
    instance.cleanup();
    return rows;
  }

  it('条目 commit 进 static 导致动态区塌掉时, 输入框不许往上跳', () => {
    // 模拟真实 turn: 流式长出 3 条 → 其中 2 条 commit 进 static (动态区骤减) → 又长出新的
    const a = makeEntry(1, LONG_ZH);
    const b = makeEntry(2, LONG_ZH);
    const c = makeEntry(3, LONG_ZH);
    const d = makeEntry(4, LONG_ZH);

    const rows = renderTurn([
      { pending: [a], static_: [] },
      { pending: [a, b], static_: [] },
      { pending: [a, b, c], static_: [] },
      { pending: [c], static_: [a, b] },     // ← 旧实现在这里塌掉十几行
      { pending: [], static_: [a, b, c] },   // ← 动态区彻底空掉
      { pending: [d], static_: [a, b, c] },
    ]);

    expect(rows.length).toBeGreaterThan(3);
    /* 容差 1 行: 本夹具不画 header, 第一条进 static 的条目没有上边距 (pending 时有) —— 生产里 header 恒为第 0 项,
     * 不会出现; 这里只要求没有"塌一大截"那种跳 */
    for (let i = 1; i < rows.length; i++) {
      expect(
        rows[i],
        `第 ${i} 帧输入框从第 ${rows[i - 1]} 行跳到第 ${rows[i]} 行 (往上跳了 ${rows[i - 1] - rows[i]} 行)`,
      ).toBeGreaterThanOrEqual(rows[i - 1] - 1);
    }
  });

  it('多容器路径 (生产实际走的 dynamic + bottom 双容器): 同样不许往上跳', () => {
    const { stream, frames } = createFakeStdout();
    const stdin = createFakeStdin();

    const common = {
      showHeader: false,
      provider: 'test',
      model: 'test-model',
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
    } as const;

    const instance = render(
      <App zone="static" isRunning={false} staticEntries={[]} pendingEntries={[]} {...common} />,
      { stdout: stream, stdin, debug: true, patchConsole: false, exitOnCtrlC: false, incrementalRendering: false },
    );

    /** worker 行在 StatusLine 里, StatusLine 在输入框**上方** —— 进出会直接推动输入框 */
    const workers = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        agentId: `worker-${i}`, agentLabel: `worker-${i}`, status: 'running',
        currentTask: '干活中', input: 1, output: 1,
        pressure: 0.1, tokensUsedForContext: 10, contextWindow: 1000,
      })) as any[];

    const paint = (pending: TimelineEntry[], nWorkers: number) => {
      instance.rerenderDynamic(
        <App zone="dynamic" isRunning staticEntries={[]} pendingEntries={pending} {...common} />,
      );
      instance.rerenderBottom(
        <App
          zone="bottom" isRunning staticEntries={[]} pendingEntries={[]}
          agentContextStats={workers(nWorkers)} runMode="agentic" {...common}
        />,
      );
      for (let i = frames.length - 1; i >= 0; i--) {
        const row = inputRowOf(frames[i]);
        if (row >= 0) return row;
      }
      return -1;
    };

    const a = makeEntry(1, LONG_ZH);
    const b = makeEntry(2, LONG_ZH);
    const rows = [
      paint([a], 0),
      paint([a, b], 2),      // 动态区涨 + 两条 worker 行冒出来
      paint([a, b], 0),      // worker 行消失 (旧实现: 输入框往上蹦 2 行)
      /* "全部 commit 进 static" 这一步不在这里测: 这个多容器夹具里 static 容器不更新, 条目等于凭空消失,
       * 真实运行中不会发生。commit 的高度守恒由上一个用例 (计入 static 行数) 覆盖。 */
    ];

    assertNoRenderError(frames);
    instance.unmount();
    instance.cleanup();

    expect(rows.every(r => r > 0)).toBe(true);
    for (let i = 1; i < rows.length; i++) {
      expect(
        rows[i],
        `第 ${i} 步输入框从第 ${rows[i - 1]} 行跳到第 ${rows[i]} 行`,
      ).toBeGreaterThanOrEqual(rows[i - 1]);
    }
  });

  it('turn 结束 (isRunning=false) 时释放锁, 不留永久空白', () => {
    const { stream, frames } = createFakeStdout();
    const stdin = createFakeStdin();
    const entries = [makeEntry(1, LONG_ZH), makeEntry(2, LONG_ZH)];

    const view = (running: boolean, pending: TimelineEntry[]) => (
      <App
        zone="all"
        isRunning={running}
        showHeader={false}
        provider="test"
        model="test-model"
        staticEntries={[]}
        pendingEntries={pending}
        onSubmit={() => {}}
        onInterrupt={() => {}}
        onExit={() => {}}
      />
    );

    const instance = render(view(true, entries), {
      stdout: stream, stdin, debug: true, patchConsole: false,
      exitOnCtrlC: false, incrementalRendering: false,
    });

    const latestInputRow = () => {
      for (let i = frames.length - 1; i >= 0; i--) {
        const row = inputRowOf(frames[i]);
        if (row >= 0) return row;
      }
      return -1;
    };

    instance.rerender(view(true, entries));
    const runningRow = latestInputRow();

    instance.rerender(view(false, []));  // turn 结束: 全部 commit, 锁释放
    const idleRow = latestInputRow();

    assertNoRenderError(frames);
    instance.unmount();
    instance.cleanup();

    expect(runningRow).toBeGreaterThan(0);
    // 释放后必须真的收回去 —— 否则空闲时会永远悬着一大块空白
    expect(idleRow).toBeLessThan(runningRow);
  });
});
