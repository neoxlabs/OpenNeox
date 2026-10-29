import { describe, it, expect } from 'vitest';
import { runPreHookStage } from '@neoxlabs/kernel/core/toolOrchestration/stages/preHook.js';
import { makeCtx, allowHook, denyHook, throwingHook } from './fixtures.js';

describe('Stage 2 · preHook', () => {
  it('ok when no hooks configured', async () => {
    const ctx = makeCtx();
    const r = await runPreHookStage('readfile', {}, ctx);
    expect(r.kind).toBe('ok');
  });

  it('ok when all hooks allow', async () => {
    const ctx = makeCtx({ preHooks: [allowHook('a'), allowHook('b')] });
    const r = await runPreHookStage('readfile', {}, ctx);
    expect(r.kind).toBe('ok');
  });

  it('block pre_hook when any hook denies, preserves its reason', async () => {
    const ctx = makeCtx({ preHooks: [allowHook(), denyHook('policy-x', 'no access')] });
    const r = await runPreHookStage('readfile', {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.blockedBy).toBe('pre_hook');
      expect(r.reason).toBe('no access');
    }
  });

  it('short-circuits on first deny (later hooks not run)', async () => {
    let laterRan = false;
    const ctx = makeCtx({
      preHooks: [
        denyHook('first'),
        { name: 'later', async run() { laterRan = true; return { allow: true }; } },
      ],
    });
    await runPreHookStage('readfile', {}, ctx);
    expect(laterRan).toBe(false);
  });

  it('fail-closed: throwing hook is treated as denial', async () => {
    const ctx = makeCtx({ preHooks: [throwingHook('bad')] });
    const r = await runPreHookStage('readfile', {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.blockedBy).toBe('pre_hook');
      expect(r.reason).toMatch(/threw/);
    }
  });

  it('uses hook.name as fallback reason when hook returns no reason', async () => {
    const ctx = makeCtx({
      preHooks: [{ name: 'silent-denier', async run() { return { allow: false }; } }],
    });
    const r = await runPreHookStage('readfile', {}, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.reason).toContain('silent-denier');
    }
  });
});
