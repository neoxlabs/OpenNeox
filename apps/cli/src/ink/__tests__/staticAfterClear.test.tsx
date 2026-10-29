import React from 'react';
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { render, Text } from '../../../vendor/ink/src/index.js';
import Static from '../../../vendor/ink/src/components/Static.js';
import { InkRuntime } from '../InkRuntime.js';

function createFakeStdout(cols = 100) {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 复刻 InkRuntime 的受控用法: 已打印条数在外面维护 */
function makeTree(items: string[], getCount: () => number, setCount: (n: number) => void) {
  return (
    <Static items={items} getRenderedCount={getCount} onRendered={setCount}>
      {(item) => <Text key={item}>{item}</Text>}
    </Static>
  );
}

describe('<Static> 清空后重新追加', () => {
  it('清空并归位计数后, 新条目照常打印', async () => {
    const { stream, frames } = createFakeStdout();
    const stdin = createFakeStdin();

    let printed = 0;
    let items = ['A', 'B', 'C'];
    const getCount = () => printed;
    const setCount = (n: number) => { printed = n; };

    const app = render(makeTree(items, getCount, setCount), { stdout: stream, stdin, debug: true });
    await sleep(30);
    expect(printed).toBe(3);

    // addEntry 撞上 MAX_QUEUED_STATIC 后 setImmediate 里的 clearStaticEntries():
    // 数组置空 + 已打印计数归位 (这里没有 header, 归位到 0)
    items = [];
    printed = 0;
    app.rerender(makeTree(items, getCount, setCount));
    await sleep(30);

    items = ['D'];
    app.rerender(makeTree(items, getCount, setCount));
    await sleep(30);

    items = ['D', 'E'];
    app.rerender(makeTree(items, getCount, setCount));
    await sleep(30);

    const all = frames.join('');
    app.unmount();

    expect(all).toContain('A');
    expect(all).toContain('B');
    expect(all).toContain('C');
    expect(all).toContain('D'); // 修复前丢的就是这一条
    expect(all).toContain('E');
  });

  it('父组件自身重渲染 (props 没重新给) 不会把已打印的条目再打一遍', async () => {
    const { stream, frames } = createFakeStdout();
    const stdin = createFakeStdin();

    let printed = 0;
    const getCount = () => printed;
    const setCount = (n: number) => { printed = n; };
    let bump: () => void = () => {};
    /* 复刻 App: 额度/会话信息到了会自己 setState 重渲染, 而 InkRuntime 给的 props 不变 */
    const Parent = () => {
      const [, setTick] = React.useState(0);
      bump = () => setTick(t => t + 1);
      return makeTree(['HEADER'], getCount, setCount);
    };

    const app = render(<Parent />, { stdout: stream, stdin, debug: true });
    await sleep(30);
    bump(); await sleep(30);
    bump(); await sleep(30);

    const all = frames.join('');
    app.unmount();
    expect(all.split('HEADER').length - 1).toBe(1);
  });

  it('clearStaticEntries 把已打印计数归位到 header 条数', () => {
    const rt = new InkRuntime({ onSubmit() {}, onInterrupt() {}, onExit() {} });
    const anyRt = rt as any;
    anyRt.staticEntries = [{ id: 1, type: 'assistant', text: 'a', timestamp: new Date() }];
    anyRt.staticRenderedCount = 50;

    anyRt.clearStaticEntries();

    expect(anyRt.staticEntries.length).toBe(0);
    expect(anyRt.staticRenderedCount).toBe(anyRt.staticHeaderItemCount());
  });
});
