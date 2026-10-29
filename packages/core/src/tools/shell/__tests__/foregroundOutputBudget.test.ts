import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { runForegroundShellCommand } from '../foregroundShellExecution.js';
import { BoundedText, capShellText, SHELL_OUTPUT_HEAD_CHARS, SHELL_OUTPUT_TAIL_CHARS } from '../shellOutputBudget.js';

const LIMIT = SHELL_OUTPUT_HEAD_CHARS + SHELL_OUTPUT_TAIL_CHARS + 512;

describe('BoundedText', () => {
  it('没超限时原样; 超限后只留开头 + 结尾, 并写明省略了多少', () => {
    const b = new BoundedText(10, 5);
    b.append('0123456789');
    expect(b.toString()).toBe('0123456789');
    b.append('abcdefghijKLMNO');
    const s = b.toString();
    expect(s.startsWith('0123456789')).toBe(true);
    expect(s.endsWith('KLMNO')).toBe(true);
    expect(s).toContain('中间省略 10 字符');
    expect(b.totalChars).toBe(25);
  });

  it('capShellText 对超长文本保头保尾', () => {
    const big = 'H' + 'x'.repeat(5_000_000) + 'T';
    const out = capShellText(big);
    expect(out.length).toBeLessThan(LIMIT);
    expect(out.startsWith('H')).toBe(true);
    expect(out.endsWith('T')).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('前台大输出: 推流与返回都有上限', () => {
  const makeServices = () => {
    const pm = new EventEmitter() as any;
    const killed: number[] = [];
    pm.register = () => {}; pm.appendOutput = () => {}; pm.markCompleted = () => {};
    pm.killProcessGroup = (pid: number) => { killed.push(pid); try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };
    return { services: { processManager: pm, shellEnv: { getShellEnv: () => process.env } } as any, killed };
  };

  it('超过硬上限 (40MB) → 杀掉命令, 推流与返回仍然有界', async () => {
    const { services, killed } = makeServices();
    let maxEmit = 0;
    let totalEmitted = 0;
    const out = await runForegroundShellCommand({
      command: `echo BEGIN; head -c 40000000 /dev/zero | tr '\\0' 'a'; echo; echo END`,
      workspaceRoot: process.cwd(), shellOption: true, services,
      emitShellStream: (p) => {
        const n = (p.output?.length ?? 0) + (p.outputDelta?.length ?? 0);
        maxEmit = Math.max(maxEmit, n);
        totalEmitted += n;
      },
      timeoutMs: 60_000,
    });
    expect(killed.length).toBeGreaterThan(0);
    expect(maxEmit).toBeLessThan(LIMIT * 2);
    expect(totalEmitted).toBeLessThan(200 * 1024 * 1024);
    expect(out.length).toBeLessThan(LIMIT * 2);
    expect(out).toContain('BEGIN');
  }, 60_000);

  it('12MB 输出 → 单次推流 ≤ 头+尾, 总推流量远小于输出量, 返回保留首尾', async () => {
    const { services } = makeServices();
    let maxEmit = 0;
    let totalEmitted = 0;
    let emits = 0;
    const out = await runForegroundShellCommand({
      command: `echo BEGIN; head -c 12000000 /dev/zero | tr '\\0' 'a'; echo; echo END`,
      workspaceRoot: process.cwd(), shellOption: true, services,
      emitShellStream: (p) => {
        emits++;
        const n = (p.output?.length ?? 0) + (p.outputDelta?.length ?? 0);
        maxEmit = Math.max(maxEmit, n);
        totalEmitted += n;
      },
      timeoutMs: 60_000,
    });

    expect(maxEmit).toBeLessThan(LIMIT * 2);
    /* 旧实现: 每块推累计全文, 40MB 输出会推出几个 GB */
    expect(totalEmitted).toBeLessThan(200 * 1024 * 1024);
    expect(out.length).toBeLessThan(LIMIT * 2);
    expect(out).toContain('BEGIN');
    expect(out).toContain('END');
    expect(out).toContain('中间省略');
    expect(emits).toBeGreaterThan(0);
  }, 60_000);
});
