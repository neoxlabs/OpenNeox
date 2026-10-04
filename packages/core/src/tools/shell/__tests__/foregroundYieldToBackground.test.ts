import { EventEmitter } from 'node:events';
import { describe, expect, it, beforeAll } from 'vitest';

process.env.NEOX_FG_BUDGET_MS = '5000';
let runForegroundShellCommand: typeof import('../foregroundShellExecution.js').runForegroundShellCommand;
beforeAll(async () => {
  ({ runForegroundShellCommand } = await import('../foregroundShellExecution.js'));
});

function makeServices() {
  const pm = new EventEmitter() as any;
  const calls = { registered: [] as number[], appended: [] as string[], completed: [] as Array<[number, number]>, killed: [] as number[] };
  pm.register = (p: { pid: number }) => { calls.registered.push(p.pid); };
  pm.appendOutput = (_pid: number, text: string) => { calls.appended.push(text); };
  pm.markCompleted = (pid: number, code: number) => { calls.completed.push([pid, code]); };
  pm.killProcessGroup = (pid: number) => { calls.killed.push(pid); };
  const services = { processManager: pm, shellEnv: { getShellEnv: () => process.env } } as any;
  return { services, calls };
}

const waitFor = async (pred: () => boolean, ms: number) => {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
};

describe.skipIf(process.platform === 'win32')('前台让位: 交给后台而不是杀掉', () => {
  it('跑满前台时限 → 立刻返回「已转后台」, 进程继续跑完并登记退出码', async () => {
    const { services, calls } = makeServices();
    const t0 = Date.now();
    const out = await runForegroundShellCommand({
      command: 'echo started; sleep 8; echo finished',
      workspaceRoot: process.cwd(), shellOption: true, services,
      emitShellStream: () => {}, timeoutMs: 60_000,
    });
    const took = Date.now() - t0;
    expect(took).toBeLessThan(7_000);
    expect(out).toContain('已自动转为后台继续跑');
    expect(out).toContain('started');
    expect(calls.registered.length).toBe(1);
    expect(calls.killed).toEqual([]);
    await waitFor(() => calls.completed.length > 0, 8_000);
    expect(calls.completed[0]?.[1]).toBe(0);
    expect(calls.appended.join('')).toContain('finished');
  }, 20_000);

  it('用户插话 → 也是转后台 (不杀), 文案说明是因为用户发了消息', async () => {
    const { services, calls } = makeServices();
    const t0 = Date.now();
    const out = await runForegroundShellCommand({
      command: 'sleep 3; echo later',
      workspaceRoot: process.cwd(), shellOption: true, services,
      emitShellStream: () => {}, timeoutMs: 60_000,
      shouldYieldToSteering: () => Date.now() - t0 > 800,
    });
    expect(Date.now() - t0).toBeLessThan(2_500);
    expect(out).toContain('用户发来了新消息');
    expect(calls.killed).toEqual([]);
    await waitFor(() => calls.completed.length > 0, 5_000);
    expect(calls.appended.join('')).toContain('later');
  }, 15_000);

  it('快命令照旧前台返回完整输出', async () => {
    const { services, calls } = makeServices();
    const out = await runForegroundShellCommand({
      command: 'echo quick',
      workspaceRoot: process.cwd(), shellOption: true, services,
      emitShellStream: () => {}, timeoutMs: 60_000,
    });
    expect(out).toContain('quick');
    expect(out).not.toContain('后台');
    expect(calls.registered).toEqual([]);
  });
});
