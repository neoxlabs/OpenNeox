import { describe, expect, it } from 'vitest';
import { NeoxEventNormalizer } from './NeoxEventNormalizer.js';

describe('NeoxEventNormalizer', () => {
  it('emits plan_update for update_plan tool call', () => {
    const emitted: any[] = [];
    const normalizer = new NeoxEventNormalizer('session-1', 'Main', (_agentId, event) => {
      emitted.push(event);
    });

    normalizer.onToolCallStart('tool-1', 'update_plan', {
      explanation: 'plan explain',
      plan: [{ step: 'Inspect logs', status: 'in_progress' }],
    });
    normalizer.onToolCallComplete('tool-1', 'update_plan', JSON.stringify({ success: true }), true);

    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'plan_update',
      explanation: 'plan explain',
      plan: [{ step: 'Inspect logs', status: 'in_progress' }],
    }));
  });

  it('emits plan_update for call_tool wrapping update_plan', () => {
    const emitted: any[] = [];
    const normalizer = new NeoxEventNormalizer('session-1', 'Main', (_agentId, event) => {
      emitted.push(event);
    });

    normalizer.onToolCallStart('tool-2', 'call_tool', {
      name: 'update_plan',
      args: {
        explanation: 'wrapped',
        plan: [{ step: 'Fix render', status: 'completed' }],
      },
    });
    normalizer.onToolCallComplete('tool-2', 'call_tool', JSON.stringify({ success: true }), true);

    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'plan_update',
      explanation: 'wrapped',
      plan: [{ step: 'Fix render', status: 'completed' }],
    }));
  });

  it('emits plan_update when args is a JSON string (real agentLoop format)', () => {
    const emitted: any[] = [];
    const normalizer = new NeoxEventNormalizer('session-1', 'Main', (_agentId, event) => {
      emitted.push(event);
    });

    //  agentLoop.onToolCallStart 传入的 args 是 tc.function.arguments（JSON 字符串）
    const argsString = JSON.stringify({
      explanation: 'string args test',
      plan: [{ step: 'Step from string', status: 'pending' }],
    });

    normalizer.onToolCallStart('tool-3', 'update_plan', argsString);
    normalizer.onToolCallComplete('tool-3', 'update_plan', JSON.stringify({ success: true }), true);

    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'plan_update',
      explanation: 'string args test',
      plan: [{ step: 'Step from string', status: 'pending' }],
    }));
  });

  it('emits edit_file_stream with toolId for stable UI card merge', () => {
    const emitted: any[] = [];
    const normalizer = new NeoxEventNormalizer('session-1', 'Main', (_agentId, event) => {
      emitted.push(event);
    });

    //  Phase 3: edit_file_stream now uses tool args, not result.metadata.edit_info
    normalizer.onToolCallStart('tool-edit-1', 'edit_file', {
      file_path: 'src/a.ts',
      old_string: 'foo',
      new_string: 'bar',
    });
    normalizer.onToolCallComplete('tool-edit-1', 'edit_file', JSON.stringify({
      status: 'success',
      file_path: 'src/a.ts',
      metadata: {
        start_line: 7,
        replacements: 1,
      },
    }), true);

    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'edit_file_stream',
      toolId: 'tool-edit-1',
      filePath: 'src/a.ts',
      oldString: 'foo',
      newString: 'bar',
      isComplete: true,
    }));
  });

  it('prefers metadata hunk previews for line-range edit_file_stream', () => {
    const emitted: any[] = [];
    const normalizer = new NeoxEventNormalizer('session-1', 'Main', (_agentId, event) => {
      emitted.push(event);
    });

    normalizer.onToolCallStart('tool-edit-2', 'edit_file', {
      file_path: 'src/b.ts',
      start_line: 3,
      end_line: 3,
      new_string: 'const a = 2;',
    });
    normalizer.onToolCallComplete('tool-edit-2', 'edit_file', JSON.stringify({
      status: 'success',
      file_path: 'src/b.ts',
      metadata: {
        start_line: 3,
        hunks: [{
          start_line: 3,
          old_line_count: 1,
          new_line_count: 1,
          old_preview: 'const a = 1;',
          new_preview: 'const a = 2;',
        }],
      },
    }), true);

    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'edit_file_stream',
      toolId: 'tool-edit-2',
      filePath: 'src/b.ts',
      oldString: 'const a = 1;',
      newString: 'const a = 2;',
      isComplete: true,
    }));
  });

  it('does not emit edit_file_stream when tool output status is error', () => {
    const emitted: any[] = [];
    const normalizer = new NeoxEventNormalizer('session-1', 'Main', (_agentId, event) => {
      emitted.push(event);
    });

    normalizer.onToolCallStart('tool-edit-3', 'edit_file', {
      file_path: 'src/missing.ts',
      start_line: 1,
      end_line: 1,
      new_string: 'x',
    });
    normalizer.onToolCallComplete('tool-edit-3', 'edit_file', JSON.stringify({
      status: 'error',
      message: 'File not found',
    }), true);

    expect(emitted.some((event) => event.type === 'edit_file_stream')).toBe(false);
  });
});
