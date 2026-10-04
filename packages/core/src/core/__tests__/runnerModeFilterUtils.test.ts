import { describe, expect, it } from 'vitest';
import { filterToolCallsByMode } from '@neoxlabs/kernel/core/runnerModeFilterUtils.js';

describe('runnerModeFilterUtils', () => {
  it('allows call-like polluted tool names when base tool is allowed', () => {
    const result = filterToolCallsByMode({
      toolCalls: [
        {
          id: 'tool-1',
          function: {
            name: 'update_plan({"plan":[{"step":"x","status":"in_progress"}]})',
            arguments: '{"plan":[{"step":"x","status":"in_progress"}]}',
          },
        },
      ],
      allowedToolNames: new Set(['update_plan']),
      currentMode: 'agent',
    });

    expect(result.executableToolCalls).toHaveLength(1);
    expect(result.blockedToolCalls).toHaveLength(0);
  });

  it('blocks unknown tools', () => {
    const result = filterToolCallsByMode({
      toolCalls: [
        {
          id: 'tool-2',
          function: {
            name: 'not_a_real_tool',
            arguments: '{}',
          },
        },
      ],
      allowedToolNames: new Set(['update_plan']),
      currentMode: 'agent',
    });

    expect(result.executableToolCalls).toHaveLength(0);
    expect(result.blockedToolCalls).toHaveLength(1);
  });
});
