import { describe, it, expect } from 'vitest';
import { runExecuteStage } from '@neoxlabs/kernel/core/toolOrchestration/stages/execute.js';
import { makeCtx, makeTool } from './fixtures.js';

describe('Stage 4 · execute', () => {
  const tool = makeTool('readfile');

  it('ok: invokes tool and returns output/success', async () => {
    const ctx = makeCtx({
      invokeTool: async () => ({ output: 'file contents', success: true }),
    });
    const r = await runExecuteStage(tool, { file_path: '/a.ts' }, ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.data.output).toBe('file contents');
      expect(r.data.success).toBe(true);
      expect(r.data.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('ok: tool returns success=false keeps going (only signals caller)', async () => {
    const ctx = makeCtx({
      invokeTool: async () => ({ output: 'ENOENT', success: false }),
    });
    const r = await runExecuteStage(tool, {}, ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.data.success).toBe(false);
      expect(r.data.output).toBe('ENOENT');
    }
  });

  it('block aborted: pre-check fires when signal already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({
      signal: ac.signal,
      invokeTool: async () => ({ output: 'should not run', success: true }),
    });
    const r = await runExecuteStage(tool, {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.blockedBy).toBe('aborted');
      expect(r.reason).toMatch(/before tool execution/);
    }
  });

  it('block aborted: in-flight abort classified correctly', async () => {
    const ac = new AbortController();
    const ctx = makeCtx({
      signal: ac.signal,
      invokeTool: async (_tool, _args, signal) => {
        ac.abort();
        throw new Error('something blew up');
      },
    });
    const r = await runExecuteStage(tool, {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.blockedBy).toBe('aborted');
    }
  });

  it('block execution_error: invokeTool throws (no abort)', async () => {
    const ctx = makeCtx({
      invokeTool: async () => { throw new Error('bang'); },
    });
    const r = await runExecuteStage(tool, {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.blockedBy).toBe('execution_error');
      expect(r.reason).toMatch(/bang/);
    }
  });

  it('AbortRace: signal aborted mid-flight → immediate reject even if tool keeps running', async () => {
    const ac = new AbortController();
    let invokeStillRunning = true;

    const ctx = makeCtx({
      signal: ac.signal,
      invokeTool: async () => {
        // tool 内部不检查 signal, 故意跑很久
        await new Promise((r) => setTimeout(r, 500));
        invokeStillRunning = false;
        return { output: 'should not be observed', success: true };
      },
    });

    // 10ms 后 abort, 观察 stage 是否立即返回(不等 500ms)
    setTimeout(() => ac.abort(), 10);
    const start = Date.now();
    const r = await runExecuteStage(tool, {}, ctx);
    const elapsed = Date.now() - start;

    expect(r.kind).toBe('block');
    if (r.kind === 'block') expect(r.blockedBy).toBe('aborted');
    // 远快于 500ms (tool 内部仍在 race 胜利后异步跑)
    expect(elapsed).toBeLessThan(200);
    // tool invokeTool 可能还在跑(由 JS 事件循环决定), 但我们不等它
    expect(invokeStillRunning).toBe(true);
  });

  it('AbortRace: tool throws AbortError → classified as aborted', async () => {
    const ac = new AbortController();
    const ctx = makeCtx({
      signal: ac.signal,
      invokeTool: async () => {
        const err = new Error('aborted internally');
        err.name = 'AbortError';
        throw err;
      },
    });
    const r = await runExecuteStage(tool, {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') expect(r.blockedBy).toBe('aborted');
  });
});
