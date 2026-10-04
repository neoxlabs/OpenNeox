import { describe, expect, it } from 'vitest';
import { prepareToolResultForMemory } from '@neoxlabs/kernel/core/runnerToolResultPreparationUtils.js';

describe('prepareToolResultForMemory', () => {
  it('compacts oversized edit output: trims actual_content and excess hunks', async () => {
    // edit 原始输出可携带 old/new 预览（供 UI diff），
    // 但进入记忆前必须压缩为纯行元数据。
    const hugeActualContent = 'x'.repeat(6000);
    const rawOutput = JSON.stringify({
      type: 'ephemeral',
      status: 'success',
      tool: 'edit',
      summary: 'Edited big file',
      actual_content: hugeActualContent,  // error case: file content for debugging
      metadata: {
        mode: 'fast_line_range',
        replacements: 9,
        start_line: 10,
        hunks: Array.from({ length: 9 }, (_, idx) => ({
          start_line: 10 + idx,
          old_line_count: 1,
          new_line_count: 1,
          old_preview: `old-${idx}`,
          new_preview: `new-${idx}`,
          preview_truncated: false,
        })),
      },
    });

    const prepared = await prepareToolResultForMemory({
      result: {
        id: 'tool-1',
        name: 'edit',
        output: rawOutput,
        success: true,
        executionTime: 0,
      },
      toolCalls: [],
      executableToolCalls: [],
      parsedArgsByToolId: new Map(),
      autoVerifyPipeline: {
        shouldVerify: () => false,
        verify: async () => null,
        formatForToolResult: () => undefined,
      },
      extractVerifyFilePath: () => undefined,
      executionPolicyOrchestrator: {
        applyToolResultPolicy: async ({ truncatedResult }) => ({
          truncatedResult,
          toolInput: {},
          shouldBreak: false,
          encounteredError: false,
        }),
      },
    });

    const parsed = JSON.parse(prepared.truncatedResult);
    // actual_content should be truncated to preview size
    expect(parsed.actual_content.length).toBeLessThanOrEqual(321); // 320 + ellipsis
    expect(parsed.actual_content_truncated).toBe(true);
    // Max 6 hunks retained
    expect(Array.isArray(parsed.metadata?.hunks)).toBe(true);
    expect(parsed.metadata.hunks.length).toBeLessThanOrEqual(6);
    expect(parsed.metadata.hunks_omitted).toBeGreaterThan(0);
    expect(parsed.metadata.hunks[0].old_preview).toBeUndefined();
    expect(parsed.metadata.hunks[0].new_preview).toBeUndefined();
    // Result should be parseable and reasonable size
    expect(prepared.truncatedResult.length).toBeLessThanOrEqual(2000); // much smaller now
  });
});
