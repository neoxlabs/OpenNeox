import { describe, it, expect, vi } from 'vitest';
import {
  createPermissionAdapter,
  createRiskAdapter,
  createGuardrailsAdapter,
  createLoopAdapter,
  createErrorPatternSuccessHook,
  createErrorPatternFailureHook,
} from '@neoxlabs/kernel/core/toolOrchestration/adapters/index.js';
import { LoopDetector, LoopLevel } from '@neoxlabs/kernel/core/loopDetector.js';
import { ErrorPatternMemory } from '@neoxlabs/kernel/core/reasoning/errorPatternMemory.js';
import { makeTool } from './fixtures.js';

describe('adapters / permissionAdapter', () => {
  it('forwards checkPermission result', async () => {
    const pm = {
      checkPermission: vi.fn(async () => ({ allowed: true })),
    };
    const adapter = createPermissionAdapter({ permissionManager: pm });
    const r = await adapter.check(makeTool('readfile'), { file_path: '/a' });
    expect(r.allowed).toBe(true);
    expect(pm.checkPermission).toHaveBeenCalledOnce();
  });

  it('forwards deny with reason', async () => {
    const pm = {
      checkPermission: async () => ({ allowed: false, reason: 'denied by user' }),
    };
    const r = await createPermissionAdapter({ permissionManager: pm }).check(
      makeTool('write_file'),
      {},
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('denied by user');
  });

  it('passes scopeKey / agentName to checkPermission context', async () => {
    const pm = { checkPermission: vi.fn(async () => ({ allowed: true })) };
    await createPermissionAdapter({
      permissionManager: pm,
      scopeKey: 'scope-x',
      agentName: 'worker-1',
    }).check(makeTool('readfile'), {});
    expect(pm.checkPermission).toHaveBeenCalledWith(
      expect.anything(),
      {},
      { scopeKey: 'scope-x', agentName: 'worker-1' },
    );
  });
});

describe('adapters / riskAdapter', () => {
  it('passes workspacePath and tool category through', () => {
    const spy = vi.fn(() => ({ level: 'low' as const, summary: 'ok' }));
    const adapter = createRiskAdapter({
      evaluateToolRisk: spy,
      workspacePath: '/ws',
      getToolCategory: () => 'read',
    });
    const r = adapter.evaluate('readfile', { file_path: '/a' });
    expect(r.level).toBe('low');
    expect(spy).toHaveBeenCalledWith({
      toolName: 'readfile',
      args: { file_path: '/a' },
      workspacePath: '/ws',
      category: 'read',
    });
  });

  it('returns critical with summary for dangerous input', () => {
    const adapter = createRiskAdapter({
      evaluateToolRisk: () => ({ level: 'critical', summary: 'sudo rm -rf /' }),
    });
    const r = adapter.evaluate('execute_shell', { command: 'sudo rm -rf /' });
    expect(r.level).toBe('critical');
    expect(r.summary).toBe('sudo rm -rf /');
  });
});

describe('adapters / guardrailsAdapter', () => {
  it('allows when no guardrails configured', async () => {
    const adapter = createGuardrailsAdapter({
      guardrails: [],
      getTool: () => makeTool('readfile'),
    });
    expect(await adapter.run('readfile', {})).toEqual({ allow: true });
  });

  it('reject_content → allow=false + guardrailName', async () => {
    const adapter = createGuardrailsAdapter({
      guardrails: [
        {
          name: 'g1',
          guardrail_function: async () => ({
            behavior: { type: 'reject_content', message: 'too dangerous' },
          }),
        },
      ],
      getTool: () => makeTool('execute_shell'),
    });
    const r = await adapter.run('execute_shell', { command: 'x' });
    expect(r.allow).toBe(false);
    expect(r.guardrailName).toBe('g1');
    expect(r.reason).toBe('too dangerous');
  });

  it('short-circuits on first deny (second guardrail not called)', async () => {
    let secondRan = false;
    const adapter = createGuardrailsAdapter({
      guardrails: [
        {
          name: 'first-deny',
          guardrail_function: async () => ({
            behavior: { type: 'reject_content', message: 'no' },
          }),
        },
        {
          name: 'second',
          guardrail_function: async () => {
            secondRan = true;
            return { behavior: { type: 'allow' } };
          },
        },
      ],
      getTool: () => makeTool('execute_shell'),
    });
    await adapter.run('execute_shell', {});
    expect(secondRan).toBe(false);
  });

  it('raise_exception is still treated as deny (no uncaught throw)', async () => {
    const adapter = createGuardrailsAdapter({
      guardrails: [
        {
          name: 'boom',
          guardrail_function: async () => ({
            output_info: { description: 'critical danger' },
            behavior: { type: 'raise_exception' },
          }),
        },
      ],
      getTool: () => makeTool('execute_shell'),
    });
    const r = await adapter.run('execute_shell', {});
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('critical danger');
  });

  it('guardrail throw is fail-closed (denied)', async () => {
    const adapter = createGuardrailsAdapter({
      guardrails: [
        {
          name: 'crash',
          guardrail_function: async () => {
            throw new Error('guardrail broken');
          },
        },
      ],
      getTool: () => makeTool('execute_shell'),
    });
    const r = await adapter.run('execute_shell', {});
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/threw|broken/);
  });

  it('falls back to allow when tool not found (validate stage will reject it)', async () => {
    const adapter = createGuardrailsAdapter({
      guardrails: [
        {
          name: 'g',
          guardrail_function: async () => ({
            behavior: { type: 'reject_content', message: 'never' },
          }),
        },
      ],
      getTool: () => undefined,
    });
    expect(await adapter.run('ghost', {})).toEqual({ allow: true });
  });
});

describe('adapters / loopAdapter', () => {
  it('maps NONE → none', () => {
    const detector = new LoopDetector();
    const adapter = createLoopAdapter(detector);
    expect(adapter.check('readfile', { file_path: '/a' }).level).toBe('none');
  });

  it('maps HARD → hard with message', () => {
    const detector = new LoopDetector();
    // 推满 3 次写操作 → HARD(write_file 阈值更低, 2 次已 SOFT, 3 次 MEDIUM, 4 次 HARD)
    const args = { file_path: '/a' };
    for (let i = 0; i < 4; i += 1) detector.record('write_file', args);
    const adapter = createLoopAdapter(detector);
    const r = adapter.check('write_file', args);
    expect(r.level).toBe('hard');
    expect(r.message).toBeTruthy();
  });

  it('suppresses SOFT/MEDIUM for read tools (preserves agentLoop behavior)', () => {
    const detector = new LoopDetector();
    const args = { file_path: '/a' };
    detector.record('readfile', args);
    detector.record('readfile', args);
    // 此时 readfile 对应 SOFT, 但 loopAdapter 应该把 read tool 的 soft/medium 抑制为 none
    const adapter = createLoopAdapter(detector);
    expect(adapter.check('readfile', args).level).toBe('none');
  });

  it('record delegates with computed outputSignature', () => {
    const detector = new LoopDetector();
    const spy = vi.spyOn(detector, 'record');
    const adapter = createLoopAdapter(detector);
    adapter.record('execute_shell', { command: 'ls' }, 'success', 'hello');
    expect(spy).toHaveBeenCalledOnce();
    const [, , status, sig] = spy.mock.calls[0];
    expect(status).toBe('success');
    expect(typeof sig).toBe('string');
    expect((sig as string).length).toBeGreaterThan(0);
  });
});

describe('adapters / errorPatternHooks', () => {
  it('success hook resets consecutive failure counter', async () => {
    const mem = new ErrorPatternMemory();
    mem.recordFailure('edit_file', 'match failed', { path: '/a' }, 1);
    mem.recordFailure('edit_file', 'match failed', { path: '/a' }, 2);
    expect(mem.getConsecutiveFailures('edit_file')).toBe(2);

    const hook = createErrorPatternSuccessHook(mem);
    await hook.run('edit_file', {}, 'done');
    expect(mem.getConsecutiveFailures('edit_file')).toBe(0);
  });

  it('failure hook records with current iteration', async () => {
    const mem = new ErrorPatternMemory();
    let iter = 42;
    const hook = createErrorPatternFailureHook({
      memory: mem,
      getIteration: () => iter,
    });
    await hook.run('edit_file', { path: '/a' }, 'boom');
    iter = 99;
    await hook.run('edit_file', { path: '/a' }, 'boom again');
    expect(mem.getConsecutiveFailures('edit_file')).toBe(2);
    const patterns = mem.getRecentPatterns();
    expect(patterns.some((p) => p.tool === 'edit_file')).toBe(true);
  });
});
