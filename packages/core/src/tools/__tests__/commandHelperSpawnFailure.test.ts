/**
 * 子进程启动失败必须转换为正常的失败结果，不能产生未处理的 Promise rejection 或终止宿主进程。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { runCommandViaHelper } from '../commandHelperClient.js';

describe('spawn 失败', () => {
  let unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  /** 让 rejection 有机会冒出来 —— unhandledRejection 是在微任务队列排空后才判定的 */
  const settle = () => new Promise((r) => setTimeout(r, 300));

  it('cwd 指向一个文件 (ENOTDIR): 返回失败结果, 且不产生 unhandledRejection', async () => {
    const r = await runCommandViaHelper('git', ['rev-parse', '--show-toplevel'], '/etc/hosts/not-a-dir');
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toMatch(/ENOTDIR|spawn|error/i);
    await settle();
    expect(unhandled, `不该有 unhandledRejection, 实际: ${unhandled.map(String).join(' | ')}`).toHaveLength(0);
  });

  it('cwd 根本不存在 (ENOENT): 同样是失败结果而不是进程自杀', async () => {
    const r = await runCommandViaHelper('git', ['status'], '/definitely/not/here/at/all');
    expect(r.exitCode).toBe(-1);
    await settle();
    expect(unhandled).toHaveLength(0);
  });

  it('命令本身不存在: 也走失败返回', async () => {
    const r = await runCommandViaHelper('neox-no-such-binary-xyz', ['--version'], process.cwd());
    expect(r.exitCode).toBe(-1);
    await settle();
    expect(unhandled).toHaveLength(0);
  });

  it('正常命令照旧能拿到 stdout', async () => {
    const r = await runCommandViaHelper('echo', ['hello-neox'], process.cwd());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hello-neox');
    await settle();
    expect(unhandled).toHaveLength(0);
  });

  it('超时被 kill: exitCode 是 124 而不是 0, stderr 留痕 (2026-09-02 rg 超时被当零匹配)', async () => {
    const r = await runCommandViaHelper('sleep', ['5'], process.cwd(), { timeoutMs: 200 });
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toContain('[timeout]');
    await settle();
    expect(unhandled).toHaveLength(0);
  });
});
