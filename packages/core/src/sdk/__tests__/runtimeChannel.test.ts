
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createChildProcessChannel } from '../runtimeChannel.js';
import { isAbnormalRuntimeExit } from '../runtimeCrashMonitor.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/runtimeExitChild.mjs', import.meta.url));

interface ExitInfo {
  code: number;
  signal: NodeJS.Signals | null;
}

function open(mode: string) {
  const exits: ExitInfo[] = [];
  const ch = createChildProcessChannel({
    entryPath: FIXTURE,
    init: {},
    env: { EXIT_FIXTURE_MODE: mode },
  });
  ch.onExit((code, signal) => { exits.push({ code, signal }); });
  return { ch, exits };
}

/** 等到 exit 回调落进数组 (最多 5s)。 */
async function waitExit(exits: ExitInfo[], deadlineMs = 5_000): Promise<ExitInfo> {
  const started = Date.now();
  while (exits.length === 0) {
    if (Date.now() - started > deadlineMs) throw new Error('子进程没有在超时内退出');
    await new Promise((r) => setTimeout(r, 20));
  }
  return exits[0];
}

describe('createChildProcessChannel 退出语义', () => {
  it('正常退出 code=0 → 不算崩溃', async () => {
    const { ch, exits } = open('ok');
    const exit = await waitExit(exits);
    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
    expect(ch.wasClosedDeliberately()).toBe(false);
    expect(isAbnormalRuntimeExit({ ...exit, deliberateClose: ch.wasClosedDeliberately() })).toBe(false);
  });

  it('非 0 退出码 (134) → 算崩溃', async () => {
    const { ch, exits } = open('code');
    const exit = await waitExit(exits);
    expect(exit.code).toBe(134);
    expect(ch.wasClosedDeliberately()).toBe(false);
    expect(isAbnormalRuntimeExit({ ...exit, deliberateClose: false })).toBe(true);
  });

  it('被信号带走 → onExit 带上 signal, 算崩溃', async () => {
    const { ch, exits } = open('signal');
    const exit = await waitExit(exits);
    /* waitpid 对信号退出的进程给 code=null → channel 归一成 0, 真正的信息在 signal 里 */
    expect(exit.code).toBe(0);
    expect(exit.signal).toBe('SIGKILL');
    expect(ch.wasClosedDeliberately()).toBe(false);
    expect(isAbnormalRuntimeExit({ ...exit, deliberateClose: false })).toBe(true);
  });

  it('terminate() → 置主动关闭标记, 即使退出带信号也不算崩溃', async () => {
    const { ch, exits } = open('sleep');
    await ch.terminate();
    expect(ch.wasClosedDeliberately()).toBe(true);
    const exit = await waitExit(exits);
    expect(exit.signal).not.toBeNull();
    expect(isAbnormalRuntimeExit({ ...exit, deliberateClose: ch.wasClosedDeliberately() })).toBe(false);
  });
});
