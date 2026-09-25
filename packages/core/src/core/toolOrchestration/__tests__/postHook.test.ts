import { describe, it, expect } from 'vitest';
import { runPostHookStage } from '@neoxlabs/kernel/core/toolOrchestration/stages/postHook.js';
import { makeCtx } from './fixtures.js';
import type { PostToolSuccessHook, PostToolFailureHook } from '@neoxlabs/kernel/core/toolOrchestration/types.js';

describe('Stage 5 · postHook (对称 success/failure)', () => {
  it('success path fires postSuccessHooks only', async () => {
    const successCalls: string[] = [];
    const failureCalls: string[] = [];
    const successHook: PostToolSuccessHook = {
      name: 'succ-1',
      async run(_n, _a, out) { successCalls.push(out); },
    };
    const failureHook: PostToolFailureHook = {
      name: 'fail-1',
      async run(_n, _a, err) { failureCalls.push(String(err)); },
    };
    const ctx = makeCtx({
      postSuccessHooks: [successHook],
      postFailureHooks: [failureHook],
    });

    await runPostHookStage(
      { toolName: 'readfile', args: {}, output: 'hello', success: true },
      ctx,
    );

    expect(successCalls).toEqual(['hello']);
    expect(failureCalls).toEqual([]);
  });

  it('failure path fires postFailureHooks only', async () => {
    const successCalls: string[] = [];
    const failureCalls: string[] = [];
    const ctx = makeCtx({
      postSuccessHooks: [{
        name: 's',
        async run(_n, _a, out) { successCalls.push(out); },
      }],
      postFailureHooks: [{
        name: 'f',
        async run(_n, _a, errStr) { failureCalls.push(errStr); },
      }],
    });

    await runPostHookStage(
      { toolName: 'readfile', args: {}, output: 'ENOENT', success: false },
      ctx,
    );

    expect(successCalls).toEqual([]);
    expect(failureCalls).toEqual(['ENOENT']);
  });

  it('never short-circuits on hook throw (stage 5 must not swallow tool result)', async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      postSuccessHooks: [
        { name: 'first-bad', async run() { throw new Error('boom'); } },
        { name: 'second-good', async run() { calls.push('second ran'); } },
      ],
    });
    const r = await runPostHookStage(
      { toolName: 'readfile', args: {}, output: 'ok', success: true },
      ctx,
    );
    expect(r.kind).toBe('ok');
    expect(calls).toEqual(['second ran']); // 后续 hook 仍然执行
    if (r.kind === 'ok') {
      expect(r.data.failedHooks).toHaveLength(1);
      expect(r.data.failedHooks[0].name).toBe('first-bad');
    }
  });

  it('passes Error object to failure hook', async () => {
    let received: Error | undefined;
    const ctx = makeCtx({
      postFailureHooks: [{
        name: 'f',
        async run(_n, _a, _errStr, err) { received = err; },
      }],
    });
    await runPostHookStage(
      {
        toolName: 'readfile',
        args: {},
        output: 'err',
        success: false,
        error: new Error('boom'),
      },
      ctx,
    );
    expect(received?.message).toBe('boom');
  });
});
