import { describe, it, expect } from 'vitest';
import { orchestrateToolUse } from '@neoxlabs/kernel/core/toolOrchestration/orchestrate.js';
import {
  makeCtx,
  makeTool,
  makeToolCall,
  allowHook,
  denyHook,
  allowPermission,
  denyPermission,
  riskLow,
  riskHigh,
  riskCritical,
  allowGuardrails,
  denyGuardrails,
  loopNone,
  loopHard,
  recordingSink,
} from './fixtures.js';

describe('orchestrateToolUse · 集成', () => {
  it('happy path: walks all 6 stages and ends at telemetry', async () => {
    const sink = recordingSink();
    const ctx = makeCtx({
      risk: riskLow(),
      inputGuardrails: allowGuardrails(),
      permission: allowPermission(),
      loopDetector: loopNone(),
      preHooks: [allowHook()],
      postSuccessHooks: [{ name: 'post-s', async run() { /* noop */ } }],
      telemetry: sink,
      invokeTool: async () => ({ output: 'file contents', success: true }),
    });

    const outcome = await orchestrateToolUse(
      makeToolCall('readfile', { file_path: '/a.ts' }),
      ctx,
    );

    expect(outcome.success).toBe(true);
    expect(outcome.stage).toBe('telemetry');
    expect(outcome.output).toBe('file contents');
    expect(outcome.blockedBy).toBeUndefined();
    expect(outcome.resolvedToolName).toBe('readfile');

    // 每个 stage 都应该有计时
    expect(Object.keys(outcome.stageTimings)).toEqual(
      expect.arrayContaining(['validate', 'preHook', 'gate', 'execute', 'postHook', 'telemetry']),
    );

    // telemetry 事件序列对: enter/exit 配对
    const enters = sink.events.filter((e) => e[0].startsWith('enter:'));
    const exits = sink.events.filter((e) => e[0].startsWith('exit:'));
    expect(enters.length).toBe(6);
    expect(exits.length).toBe(6);
    expect(sink.events.some((e) => e[0] === 'complete')).toBe(true);
  });

  it('short-circuits at validate (unknown_tool)', async () => {
    const sink = recordingSink();
    const ctx = makeCtx({ telemetry: sink });
    const outcome = await orchestrateToolUse(
      makeToolCall('no_such_tool'),
      ctx,
    );
    expect(outcome.stage).toBe('validate');
    expect(outcome.blockedBy).toBe('unknown_tool');
    expect(outcome.success).toBe(false);
    // 不应 emit preHook / gate / execute / postHook
    const entered = sink.events
      .filter((e) => e[0].startsWith('enter:'))
      .map((e) => e[0].replace('enter:', ''));
    expect(entered).toEqual(['validate', 'telemetry']);
    // 应当有 complete 事件
    expect(sink.events.some((e) => e[0] === 'complete')).toBe(true);
  });

  it('short-circuits at preHook with denial reason', async () => {
    const ctx = makeCtx({ preHooks: [denyHook('h1', 'not allowed')] });
    const outcome = await orchestrateToolUse(
      makeToolCall('readfile', { file_path: '/a.ts' }),
      ctx,
    );
    expect(outcome.stage).toBe('preHook');
    expect(outcome.blockedBy).toBe('pre_hook');
    expect(outcome.output).toBe('not allowed');
  });

  it('short-circuits at gate (permission denied)', async () => {
    const ctx = makeCtx({
      permission: denyPermission('user declined'),
    });
    const outcome = await orchestrateToolUse(
      makeToolCall('readfile'),
      ctx,
    );
    expect(outcome.stage).toBe('gate');
    expect(outcome.blockedBy).toBe('permission');
  });

  it('critical risk → block + terminateLoop=true', async () => {
    const ctx = makeCtx({ risk: riskCritical('sudo rm -rf /') });
    const outcome = await orchestrateToolUse(
      makeToolCall('execute_shell', { command: 'sudo rm -rf /' }),
      ctx,
    );
    expect(outcome.blockedBy).toBe('risk');
    expect(outcome.terminateLoop).toBe(true);
  });

  it('high risk → block but does not terminate loop', async () => {
    const ctx = makeCtx({ risk: riskHigh() });
    const outcome = await orchestrateToolUse(
      makeToolCall('execute_shell'),
      ctx,
    );
    expect(outcome.blockedBy).toBe('risk');
    expect(outcome.terminateLoop).toBeFalsy();
  });

  it('guardrail denies with guardrail name visible in output', async () => {
    const ctx = makeCtx({
      inputGuardrails: denyGuardrails('suspicious', 'dangerous_command'),
    });
    const outcome = await orchestrateToolUse(
      makeToolCall('execute_shell', { command: 'rm -rf --no-preserve-root /' }),
      ctx,
    );
    expect(outcome.blockedBy).toBe('guardrail');
    expect(outcome.output).toMatch(/dangerous_command/);
  });

  it('loop HARD block + terminateLoop', async () => {
    const ctx = makeCtx({ loopDetector: loopHard('stuck') });
    const outcome = await orchestrateToolUse(
      makeToolCall('readfile'),
      ctx,
    );
    expect(outcome.blockedBy).toBe('loop');
    expect(outcome.terminateLoop).toBe(true);
  });

  it('execute throws → failure postHooks fired, outcome reports execution_error', async () => {
    const failures: string[] = [];
    const successes: string[] = [];
    const ctx = makeCtx({
      invokeTool: async () => { throw new Error('tool exploded'); },
      postSuccessHooks: [{ name: 's', async run() { successes.push('s'); } }],
      postFailureHooks: [{ name: 'f', async run(_n, _a, out) { failures.push(out); } }],
    });
    const outcome = await orchestrateToolUse(makeToolCall('readfile'), ctx);
    expect(outcome.blockedBy).toBe('execution_error');
    expect(outcome.stage).toBe('execute');
    expect(successes).toEqual([]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/tool exploded/);
  });

  it('execute returns success=false → failure postHooks fired (对称 hook)', async () => {
    const failures: string[] = [];
    const successes: string[] = [];
    const ctx = makeCtx({
      invokeTool: async () => ({ output: 'ENOENT: file gone', success: false }),
      postSuccessHooks: [{ name: 's', async run() { successes.push('s'); } }],
      postFailureHooks: [{ name: 'f', async run(_n, _a, out) { failures.push(out); } }],
    });
    const outcome = await orchestrateToolUse(makeToolCall('readfile'), ctx);
    expect(outcome.success).toBe(false);
    expect(outcome.stage).toBe('telemetry'); // 仍然完整走完
    expect(successes).toEqual([]);
    expect(failures).toEqual(['ENOENT: file gone']);
  });

  it('loopDetector.record called with final status on happy path', async () => {
    const records: Array<{ status: string; output: string }> = [];
    const ctx = makeCtx({
      loopDetector: {
        check: () => ({ level: 'none' }),
        record: (_n, _a, status, output) => records.push({ status, output }),
      },
      invokeTool: async () => ({ output: 'hello', success: true }),
    });
    await orchestrateToolUse(makeToolCall('readfile'), ctx);
    expect(records).toEqual([{ status: 'success', output: 'hello' }]);
  });

  it('loopDetector.record called with error when execute fails', async () => {
    const records: Array<{ status: string }> = [];
    const ctx = makeCtx({
      loopDetector: {
        check: () => ({ level: 'none' }),
        record: (_n, _a, status) => records.push({ status }),
      },
      invokeTool: async () => { throw new Error('x'); },
    });
    await orchestrateToolUse(makeToolCall('readfile'), ctx);
    expect(records).toEqual([{ status: 'error' }]);
  });

  it('abort before execute: blockedBy aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx({ signal: ac.signal });
    const outcome = await orchestrateToolUse(makeToolCall('readfile'), ctx);
    expect(outcome.blockedBy).toBe('aborted');
    expect(outcome.stage).toBe('execute');
  });

  it('SOFT loop carries advisory message on outcome (non-blocking)', async () => {
    const ctx = makeCtx({
      loopDetector: {
        check: () => ({ level: 'soft', message: 'you repeated this tool' }),
        record: () => {},
      },
      invokeTool: async () => ({ output: 'hello', success: true }),
    });
    const outcome = await orchestrateToolUse(makeToolCall('readfile'), ctx);
    expect(outcome.success).toBe(true);
    expect(outcome.stage).toBe('telemetry');
    expect(outcome.loopAdvisoryMessage).toBe('you repeated this tool');
  });

  it('MEDIUM loop carries advisory message on outcome', async () => {
    const ctx = makeCtx({
      loopDetector: {
        check: () => ({ level: 'medium', message: 'seriously, stop' }),
        record: () => {},
      },
      invokeTool: async () => ({ output: 'ok', success: true }),
    });
    const outcome = await orchestrateToolUse(makeToolCall('readfile'), ctx);
    expect(outcome.loopAdvisoryMessage).toBe('seriously, stop');
  });

  it('HARD loop blocks at gate (no advisory, normal block semantics)', async () => {
    const ctx = makeCtx({ loopDetector: loopHard('hard stop') });
    const outcome = await orchestrateToolUse(makeToolCall('readfile'), ctx);
    expect(outcome.blockedBy).toBe('loop');
    expect(outcome.loopAdvisoryMessage).toBeUndefined();
  });

  it('outcome carries resolvedToolName and args for audit', async () => {
    const ctx = makeCtx({
      tools: [makeTool('execute_shell')],
      aliases: { bash: 'execute_shell' },
      invokeTool: async () => ({ output: '', success: true }),
    });
    const outcome = await orchestrateToolUse(
      makeToolCall('bash', { command: 'ls' }, 'id-42'),
      ctx,
    );
    expect(outcome.toolCallId).toBe('id-42');
    expect(outcome.toolName).toBe('bash');
    expect(outcome.resolvedToolName).toBe('execute_shell');
    expect(outcome.args).toEqual({ command: 'ls' });
  });
});
