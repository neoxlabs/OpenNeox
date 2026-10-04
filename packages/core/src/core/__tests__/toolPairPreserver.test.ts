import { describe, it, expect } from 'vitest';
import {
  widenKeepStartForPairedBlocks,
  validateToolPairIntegrity,
} from '@neoxlabs/kernel/core/toolPairPreserver.js';
import type { Message } from '@neoxlabs/kernel/types/index.js';

function msg(role: Message['role'], content: string, extras?: Partial<Message>): Message {
  return { role, content, ...extras };
}

function assistantWithToolCall(toolCallId: string, name: string): Message {
  return {
    role: 'assistant',
    content: `Calling ${name}`,
    tool_calls: [{
      id: toolCallId,
      type: 'function' as const,
      function: { name, arguments: '{}' },
    }],
  };
}

function toolResult(toolCallId: string, content: string): Message {
  return {
    role: 'tool',
    content,
    tool_call_id: toolCallId,
    name: 'some_tool',
  } as any;
}

describe('widenKeepStartForPairedBlocks', () => {
  it('returns 0 if startIndex is 0', () => {
    const messages = [msg('user', 'hello')];
    expect(widenKeepStartForPairedBlocks(messages, 0)).toBe(0);
  });

  it('does not adjust when pairs are intact', () => {
    const messages = [
      msg('user', 'q1'),
      assistantWithToolCall('tc1', 'read'),
      toolResult('tc1', 'file content'),
      msg('user', 'q2'),
      assistantWithToolCall('tc2', 'write'),
      toolResult('tc2', 'done'),
    ];
    // Keep from index 3 onwards — tc2 pair is intact
    expect(widenKeepStartForPairedBlocks(messages, 3)).toBe(3);
  });

  it('adjusts backwards to include orphaned tool_use', () => {
    const messages = [
      msg('user', 'q1'),
      assistantWithToolCall('tc1', 'read'),   // index 1 — tool_use for tc1
      msg('user', 'q2'),                       // index 2 — original startIndex
      toolResult('tc1', 'file content'),       // index 3 — tool_result for tc1 (KEPT)
    ];
    // startIndex=2 keeps indices 2,3. Index 3 has tool_result(tc1) but tool_use(tc1) is at index 1
    // Should adjust back to include index 1
    const adjusted = widenKeepStartForPairedBlocks(messages, 2);
    expect(adjusted).toBeLessThanOrEqual(1);
  });

  it('handles multiple orphaned pairs', () => {
    const messages = [
      msg('user', 'q1'),
      assistantWithToolCall('tc1', 'read'),   // index 1
      toolResult('tc1', 'content1'),           // index 2
      assistantWithToolCall('tc2', 'write'),   // index 3 — tool_use for tc2
      msg('user', 'q2'),                       // index 4 — original startIndex
      toolResult('tc2', 'content2'),           // index 5 — tool_result for tc2 (KEPT)
    ];
    // startIndex=4 keeps indices 4,5. Index 5 has tool_result(tc2) but tool_use is at index 3
    const adjusted = widenKeepStartForPairedBlocks(messages, 4);
    expect(adjusted).toBeLessThanOrEqual(3);
  });

  it('handles thinking blocks with same message ID', () => {
    const messages = [
      msg('user', 'q1'),
      { ...msg('assistant', 'thinking...'), id: 'msg-1' } as any,   // index 1 — thinking block
      { ...msg('assistant', 'answer'), id: 'msg-1' } as any,        // index 2 — same ID, KEPT
      msg('user', 'q2'),                                              // index 3
    ];
    // startIndex=2 keeps the answer but not the thinking block with same ID
    const adjusted = widenKeepStartForPairedBlocks(messages, 2);
    expect(adjusted).toBeLessThanOrEqual(1);
  });
});

describe('validateToolPairIntegrity', () => {
  it('returns no issues for valid pairs', () => {
    const messages = [
      msg('user', 'q1'),
      assistantWithToolCall('tc1', 'read'),
      toolResult('tc1', 'content'),
    ];
    expect(validateToolPairIntegrity(messages)).toEqual([]);
  });

  it('detects orphaned tool_result', () => {
    const messages = [
      msg('user', 'q1'),
      toolResult('tc1', 'content'),  // No matching tool_use
    ];
    const issues = validateToolPairIntegrity(messages);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain('Orphaned tool_result');
  });

  it('detects orphaned tool_use', () => {
    const messages = [
      msg('user', 'q1'),
      assistantWithToolCall('tc1', 'read'),  // No matching tool_result
    ];
    const issues = validateToolPairIntegrity(messages);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain('Orphaned tool_use');
  });
});
