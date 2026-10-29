import { describe, it, expect } from 'vitest';
import { runValidateStage } from '@neoxlabs/kernel/core/toolOrchestration/stages/validate.js';
import { makeCtx, makeTool, makeToolCall } from './fixtures.js';

describe('Stage 1 · validate', () => {
  it('ok: resolves direct name and parses object args', () => {
    const ctx = makeCtx();
    const tc = makeToolCall('readfile', { file_path: '/a.ts' });
    const r = runValidateStage(tc, ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.data.tool.name).toBe('readfile');
      expect(r.data.resolvedName).toBe('readfile');
      expect(r.data.args).toEqual({ file_path: '/a.ts' });
    }
  });

  it('ok: resolves via alias when direct name not found', () => {
    const ctx = makeCtx({
      tools: [makeTool('execute_shell')],
      aliases: { bash: 'execute_shell' },
    });
    const tc = makeToolCall('bash', { command: 'ls' });
    const r = runValidateStage(tc, ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.data.resolvedName).toBe('execute_shell');
    }
  });

  it('block unknown_tool: no match and no alias', () => {
    const ctx = makeCtx();
    const tc = makeToolCall('totally_not_a_tool');
    const r = runValidateStage(tc, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.blockedBy).toBe('unknown_tool');
      expect(r.reason).toMatch(/Tool not found/);
    }
  });

  it('block unknown_tool: empty function.name', () => {
    const ctx = makeCtx();
    const tc = makeToolCall('', {});
    const r = runValidateStage(tc, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') expect(r.blockedBy).toBe('unknown_tool');
  });

  it('block invalid_args: malformed JSON string', () => {
    const ctx = makeCtx();
    const tc = makeToolCall('readfile', '{not json');
    const r = runValidateStage(tc, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') {
      expect(r.blockedBy).toBe('invalid_args');
      expect(r.reason).toMatch(/Invalid JSON/);
    }
  });

  it('block invalid_args: args is an array (should be object)', () => {
    const ctx = makeCtx();
    const tc = makeToolCall('readfile', [1, 2, 3]);
    const r = runValidateStage(tc, ctx);
    expect(r.kind).toBe('block');
    if (r.kind === 'block') expect(r.blockedBy).toBe('invalid_args');
  });

  it('ok: empty arguments string → empty object', () => {
    const ctx = makeCtx();
    const tc = makeToolCall('readfile', '');
    const r = runValidateStage(tc, ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.data.args).toEqual({});
  });

  it('ok: arguments given as object (non-string) — tolerant', () => {
    const ctx = makeCtx();
    const tc = {
      id: 'call-x',
      type: 'function' as const,
      function: { name: 'readfile', arguments: { file_path: '/a.ts' } as any },
    } as any;
    const r = runValidateStage(tc, ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.data.args.file_path).toBe('/a.ts');
  });
});
