import { describe, it, expect } from 'vitest';
import { runGateStage } from '@neoxlabs/kernel/core/toolOrchestration/stages/gate.js';
import {
  makeCtx,
  makeTool,
  allowPermission,
  denyPermission,
  riskLow,
  riskHigh,
  riskCritical,
  allowGuardrails,
  denyGuardrails,
  loopNone,
  loopHard,
} from './fixtures.js';

describe('Stage 3 · gate', () => {
  const tool = makeTool('execute_shell');

  it('ok when no gate components configured', async () => {
    const ctx = makeCtx();
    const r = await runGateStage(tool, {}, ctx);
    expect(r.kind).toBe('ok');
  });

  it('ok when every configured gate passes', async () => {
    const ctx = makeCtx({
      risk: riskLow(),
      inputGuardrails: allowGuardrails(),
      permission: allowPermission(),
      loopDetector: loopNone(),
    });
    const r = await runGateStage(tool, {}, ctx);
    expect(r.kind).toBe('ok');
  });

  it('block risk (critical) → terminateLoop=true', async () => {
    const ctx = makeCtx({ risk: riskCritical('sudo rm -rf /') });
    const r = await runGateStage(tool, {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.blockedBy).toBe('risk');
      expect(r.reason).toMatch(/critical/);
      expect(r.terminateLoop).toBe(true);
    }
  });

  it('block risk (high) → terminateLoop=false', async () => {
    const ctx = makeCtx({ risk: riskHigh('dangerous') });
    const r = await runGateStage(tool, {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.blockedBy).toBe('risk');
      expect(r.terminateLoop).toBeFalsy();
    }
  });

  it('block guardrail with guardrailName in reason', async () => {
    const ctx = makeCtx({
      risk: riskLow(),
      inputGuardrails: denyGuardrails('bad pattern', 'dangerous_command'),
    });
    const r = await runGateStage(tool, {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.blockedBy).toBe('guardrail');
      expect(r.reason).toMatch(/dangerous_command/);
    }
  });

  it('block permission', async () => {
    const ctx = makeCtx({
      risk: riskLow(),
      inputGuardrails: allowGuardrails(),
      permission: denyPermission('user said no'),
    });
    const r = await runGateStage(tool, {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.blockedBy).toBe('permission');
      expect(r.reason).toMatch(/user said no/);
    }
  });

  it('shouldAutoApprove=true does NOT skip permission (f2384ce39: 始终走 PermissionManager)', async () => {
    // 旧契约: shouldAutoApprove 整段跳过 Permission → session 级 manual/dangerous 在
    // AgentMode.AUTO 下失效. f2384ce39 起 Permission 始终运行 (YOLO 由 approvalMode=dangerous
    // → ALLOW 表达, 不再用 shouldAutoApprove 跳过). 故 deny 的 permission 仍会 block.
    const ctx = makeCtx({
      risk: riskLow(),
      inputGuardrails: allowGuardrails(),
      permission: denyPermission('user said no'),
      shouldAutoApprove: true,
    });
    const r = await runGateStage(tool, {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') expect(r.blockedBy).toBe('permission');
  });

  it('shouldAutoApprove does NOT skip guardrail', async () => {
    const ctx = makeCtx({
      inputGuardrails: denyGuardrails(),
      shouldAutoApprove: true,
    });
    const r = await runGateStage(tool, {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') expect(r.blockedBy).toBe('guardrail');
  });

  it('block loop HARD → terminateLoop=true', async () => {
    const ctx = makeCtx({ loopDetector: loopHard('stuck calling shell') });
    const r = await runGateStage(tool, {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.blockedBy).toBe('loop');
      expect(r.terminateLoop).toBe(true);
    }
  });

  it('soft/medium loop does NOT block at gate (orchestrate handles as advisory)', async () => {
    const ctx = makeCtx({
      loopDetector: {
        check: () => ({ level: 'medium', message: 'you should slow down' }),
        record: () => {},
      },
    });
    const r = await runGateStage(tool, {}, ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.data.loopAdvisoryMessage).toBe('you should slow down');
    }
  });

  it('ok with no loop detector → no advisory message', async () => {
    const ctx = makeCtx();
    const r = await runGateStage(tool, {}, ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.data.loopAdvisoryMessage).toBeUndefined();
    }
  });

  it('loop "none" → no advisory', async () => {
    const ctx = makeCtx({ loopDetector: loopNone() });
    const r = await runGateStage(tool, {}, ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.data.loopAdvisoryMessage).toBeUndefined();
    }
  });

  it('fail-closed: throwing permission checker → block permission', async () => {
    const ctx = makeCtx({
      permission: { async check() { throw new Error('boom'); } },
    });
    const r = await runGateStage(tool, {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.blockedBy).toBe('permission');
      expect(r.reason).toMatch(/threw/);
    }
  });

  it('fail-closed: throwing guardrail → block guardrail', async () => {
    const ctx = makeCtx({
      inputGuardrails: { async run() { throw new Error('boom'); } },
    });
    const r = await runGateStage(tool, {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') expect(r.blockedBy).toBe('guardrail');
  });

  it('ordering: risk is evaluated before guardrails', async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      risk: { evaluate: () => { calls.push('risk'); return { level: 'critical' }; } },
      inputGuardrails: { async run() { calls.push('guardrail'); return { allow: true }; } },
    });
    await runGateStage(tool, {}, ctx);
    expect(calls).toEqual(['risk']); // short-circuited before guardrail
  });
});
