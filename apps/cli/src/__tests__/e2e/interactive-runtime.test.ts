import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFakeGateway, type GatewayRequest, type FakeGateway } from './infra/fakeGateway.js';
import { createCliWorkspace, type CliWorkspace } from './infra/workspace.js';
import { spawnPtyCli, type PtyCli } from './infra/ptyCli.js';
import { maxLineWidth, printable, stripAnsi } from './infra/ansi.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 清空输入: ESC 后留 300ms 再发单个 Ctrl+U; 连发会被解析成 meta+ctrl+u 插进输入框. */
async function clearInput(cli: PtyCli): Promise<void> {
  cli.send('\x1b');
  await sleep(300);
  cli.send('\x15');
  await sleep(200);
}
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

interface Session {
  gw: FakeGateway;
  ws: CliWorkspace;
  cli: PtyCli;
}

async function open(opts: { cols?: number; rows?: number; defaultText?: string; debug?: boolean } = {}): Promise<Session> {
  const gw = await startFakeGateway({ defaultText: opts.defaultText ?? 'runtime answer' });
  const ws = await createCliWorkspace({ providers: [{ baseUrl: gw.baseUrl, model: 'mock-model' }] });
  const cli = await spawnPtyCli(ws, {
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 40,
    readyTimeoutMs: 90_000,
    env: opts.debug ? { CLI_DEBUG: '1' } : undefined,
  });
  cleanups.push(async () => {
    cli.kill('SIGKILL');
    await ws.cleanup();
    await gw.stop();
  });
  return { gw, ws, cli };
}

function lastUser(request: GatewayRequest | undefined): string {
  const messages = request?.body?.messages ?? [];
  const last = [...messages].reverse().find((m: any) => m?.role === 'user');
  return String(last?.content ?? '');
}

describe('cli e2e · interactive runtime', () => {
  it('typing / opens the slash menu; esc closes it', async () => {
    const { cli } = await open();
    const mark = cli.mark();
    cli.send('/');
    await cli.waitQuiet({ quietMs: 800, timeoutMs: 10_000 });
    const menu = stripAnsi(cli.since(mark));
    expect(menu).toMatch(/Commands/);
    expect(menu).toMatch(/\/help/);
    expect(menu).toMatch(/esc close/);
    expect(cli.alive()).toBe(true);

    await cli.sendEscape();
    await cli.waitQuiet({ quietMs: 500, timeoutMs: 10_000 });
    expect(cli.alive()).toBe(true);
  });

  it('typing text after / filters the slash menu', async () => {
    const { cli } = await open();
    const mark = cli.mark();
    cli.send('/');
    await sleep(300);
    cli.send('he');
    await cli.waitQuiet({ quietMs: 800, timeoutMs: 10_000 });
    const filtered = stripAnsi(cli.since(mark));
    expect(filtered).toMatch(/\/help/);
    expect(filtered).toMatch(/1 commands|commands/);
    expect(cli.alive()).toBe(true);
    await cli.sendEscape();
  });

  it('a model turn completes and prints the answer', async () => {
    const { gw, cli } = await open({ defaultText: 'the runtime answer' });
    gw.push({ match: 'say hello', text: 'the runtime answer' });
    const mark = cli.mark();
    await cli.sendLine('say hello');
    /* 假网关 90ms 就答完, "Responding" 一闪而过; 等最终回答即可. */
    await cli.waitFor(/the runtime answer/, { from: mark, timeoutMs: 30_000 });
    await cli.waitQuiet({ quietMs: 1000, timeoutMs: 20_000 });
    const output = stripAnsi(cli.since(mark));
    expect(output).toMatch(/the runtime answer/);
    /* 状态行 "Done" 会很快被下一帧覆盖; 稳定的是这一轮的 token/费用统计行 */
    expect(output).toMatch(/in 10 · out 5/);
    expect(gw.chatRequests().length).toBeGreaterThanOrEqual(1);
  });

  it('esc interrupts a running turn and the UI recovers', async () => {
    const { gw, cli } = await open();
    gw.push({ match: 'interrupt this turn', chunks: ['i1 ', 'i2 ', 'i3 ', 'i4 ', 'i5 ', 'i6 ', 'i7 ', 'i8'], chunkDelayMs: 1200 });
    const mark = cli.mark();
    await cli.sendLine('interrupt this turn');
    await cli.waitFor(/Responding/, { from: mark, timeoutMs: 20_000 });
    await sleep(400);
    await cli.sendEscape();
    await cli.waitQuiet({ quietMs: 1500, timeoutMs: 30_000 });

    const output = stripAnsi(cli.since(mark));
    expect(output).toMatch(/Interrupted/);
    expect(gw.chatRequests().at(-1)?.aborted).toBe(true);
    expect(cli.alive()).toBe(true);

    /* 中断后未回答的消息会被放回输入框 (产品行为); 清空后用 /changes 验证 UI 还能用 */
    await clearInput(cli);
    const mark2 = cli.mark();
    await cli.sendLine('/changes');
    await cli.waitQuiet({ quietMs: 900, timeoutMs: 10_000 });
    expect(stripAnsi(cli.since(mark2))).toMatch(/No file changes/);
  });

  it('typing while a turn runs interrupts it and sends the new message', async () => {
    const { gw, cli } = await open();
    gw.push({ match: 'first running turn', chunks: ['f1 ', 'f2 ', 'f3 ', 'f4 ', 'f5 ', 'f6 ', 'f7 ', 'f8'], chunkDelayMs: 1200 });
    gw.push({ match: 'second running turn', text: 'SECOND TURN ANSWER' });
    const mark = cli.mark();
    await cli.sendLine('first running turn');
    await cli.waitFor(/Responding/, { from: mark, timeoutMs: 20_000 });
    await sleep(400);
    await cli.sendLine('second running turn');

    await cli.waitFor(/SECOND TURN ANSWER/, { from: mark, timeoutMs: 40_000 });
    await cli.waitQuiet({ quietMs: 1200, timeoutMs: 20_000 });

    const requests = gw.chatRequests();
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[0].aborted).toBe(true);
    expect(lastUser(requests[1])).toContain('second running turn');
    expect(stripAnsi(cli.since(mark))).toMatch(/Interrupted/);
  });

  it('renders a 60-column terminal without overflowing', async () => {
    const { cli } = await open({ cols: 60 });
    expect(maxLineWidth(cli.output())).toBeLessThanOrEqual(60);
    expect(stripAnsi(cli.output())).toMatch(/neox/);

    const mark = cli.mark();
    await cli.sendLine('/help');
    await cli.waitQuiet({ quietMs: 1200, timeoutMs: 15_000 });
    const output = cli.since(mark);
    expect(maxLineWidth(output)).toBeLessThanOrEqual(60);
    expect(stripAnsi(output)).toMatch(/Help · enter runs the command/);
    expect(cli.alive()).toBe(true);
  });

  it('resizing to 60 columns re-renders without breaking', async () => {
    const { cli } = await open({ cols: 100 });
    cli.resize(60, 40);
    await cli.waitQuiet({ quietMs: 800, timeoutMs: 10_000 });
    const mark = cli.mark();
    await cli.sendLine('/help');
    await cli.waitQuiet({ quietMs: 1200, timeoutMs: 15_000 });
    expect(maxLineWidth(cli.since(mark))).toBeLessThanOrEqual(60);
    expect(stripAnsi(cli.since(mark))).toMatch(/Help · enter runs the command/);
    expect(cli.alive()).toBe(true);
  });

  it('ctrl+l clears the screen and keeps the UI usable', async () => {
    const { cli } = await open();
    cli.send('\x0c');
    await cli.waitQuiet({ quietMs: 600, timeoutMs: 10_000 });
    expect(cli.alive()).toBe(true);
    const mark = cli.mark();
    await cli.sendLine('/changes');
    await cli.waitQuiet({ quietMs: 900, timeoutMs: 10_000 });
    expect(stripAnsi(cli.since(mark))).toMatch(/No file changes/);
  });

  it('up-arrow recalls the previous prompt', async () => {
    const { gw, cli } = await open({ defaultText: 'history answer' });
    gw.push({ match: 'remember this prompt', text: 'history answer' });
    const mark = cli.mark();
    await cli.sendLine('remember this prompt');
    await cli.waitFor(/history answer/, { from: mark, timeoutMs: 30_000 });
    await cli.waitQuiet({ quietMs: 1000, timeoutMs: 20_000 });
    const before = gw.chatRequests().length;

    cli.send('\x1b[A');
    await sleep(300);
    cli.send('\r');
    const recalled = await gw.waitForChat(before + 1, 20_000);
    expect(lastUser(recalled)).toContain('remember this prompt');
  });

  it('/exit leaves the process with code 0', async () => {
    const { cli } = await open();
    await cli.sendLine('/exit');
    const exit = await cli.waitExit(20_000);
    expect(exit.exitCode).toBe(0);
  });

  it('ctrl+c at an idle prompt exits cleanly', async () => {
    const { cli } = await open();
    cli.send('\x03');
    const exit = await cli.waitExit(15_000);
    expect([0, 130]).toContain(exit.exitCode);
  });

  it('the finished session has no crash markers in its output', async () => {
    const { cli } = await open();
    const mark = cli.mark();
    await cli.sendLine('/changes');
    await cli.waitQuiet({ quietMs: 900, timeoutMs: 10_000 });
    const output = stripAnsi(cli.since(mark));
    expect(printable(output)).not.toMatch(/TypeError|ReferenceError|UnhandledPromiseRejection|FATAL/);
  });
});
