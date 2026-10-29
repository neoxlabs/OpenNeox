/**
 * validate stage — 坏 JSON args 的自修复路径与 runner [SELF_HEAL] 层对齐
 * (P1-3,): 截断/trailing-comma args 先修再 block。
 */
import { describe, expect, it } from 'vitest';
import { runValidateStage } from '../stages/validate.js';
import type { ToolUseContext } from '../types.js';
import type { Tool, ToolCall } from '../../../types/index.js';

const readTool: Tool = {
  name: 'readfile',
  description: 'read a file',
  parameters: { type: 'object', properties: {} },
  function: async () => 'ok',
} as unknown as Tool;

function ctx(): ToolUseContext {
  return {
    tools: [readTool],
    resolveAlias: () => null,
  } as unknown as ToolUseContext;
}

function call(args: string): ToolCall {
  return {
    id: 'call_1',
    type: 'function',
    function: { name: 'readfile', arguments: args },
  } as ToolCall;
}

describe('runValidateStage args self-heal', () => {
  it('parses valid JSON as before', () => {
    const r = runValidateStage(call('{"path":"/a.ts"}'), ctx());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.data.args).toEqual({ path: '/a.ts' });
  });

  it('heals truncated JSON (unclosed string + brace) instead of blocking', () => {
    const r = runValidateStage(call('{"path":"/a.ts'), ctx());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.data.args).toEqual({ path: '/a.ts' });
  });

  it('heals trailing comma', () => {
    const r = runValidateStage(call('{"path":"/a.ts",}'), ctx());
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.data.args).toEqual({ path: '/a.ts' });
  });

  it('still blocks unfixable garbage', () => {
    const r = runValidateStage(call('not json at all {{{'), ctx());
    expect(r.kind).toBe('block');
  });

  it('still blocks non-object JSON (array)', () => {
    const r = runValidateStage(call('[1,2,3]'), ctx());
    expect(r.kind).toBe('block');
  });
});
