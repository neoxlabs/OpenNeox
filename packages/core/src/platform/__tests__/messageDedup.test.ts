import { describe, expect, it } from 'vitest';
import {
  messageDedupFingerprint,
  turnIdsCompatible,
} from '@neoxlabs/platform/platform/sessionContext.js';

describe('messageDedupFingerprint', () => {
  it('thinking 与 tool_call 都是空 content 但指纹必须不同 (seq 复用真因)', () => {
    const thinkingFp = messageDedupFingerprint('assistant', '', {
      role: 'assistant', content: '', thinking: '让我看看目录结构',
    });
    const toolCallFp = messageDedupFingerprint('assistant', '', {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
    });
    expect(thinkingFp).not.toBe(toolCallFp);
  });

  it('两段不同 thinking 指纹不同', () => {
    const a = messageDedupFingerprint('assistant', '', { thinking: '第一段思考' });
    const b = messageDedupFingerprint('assistant', '', { thinking: '第二段思考' });
    expect(a).not.toBe(b);
  });

  it('tool 结果按 tool_call_id 认身份 — runtime ⏱️ 装饰版与原版同指纹', () => {
    const forwarder = messageDedupFingerprint('tool', '/Users/x/cece\ntotal 280', {
      role: 'tool', tool_call_id: 'call-d58',
    });
    const runtime = messageDedupFingerprint('tool', '⏱️ [execute_shell took 3.2s]\n\n/Users/x/cece\ntotal 280', {
      role: 'tool', tool_call_id: 'call-d58',
    });
    expect(forwarder).toBe(runtime);
  });

  it('不同 tool_call_id 的结果指纹不同', () => {
    const a = messageDedupFingerprint('tool', 'same output', { tool_call_id: 'c1' });
    const b = messageDedupFingerprint('tool', 'same output', { tool_call_id: 'c2' });
    expect(a).not.toBe(b);
  });

  it('assistant 正文只差空白 → 同指纹 (forwarder strip vs runtime 原文)', () => {
    const a = messageDedupFingerprint('assistant', '这是一个 Node.js 项目（分支）', {});
    const b = messageDedupFingerprint('assistant', '这是一个 Node.js项目（分支）', {});
    expect(a).toBe(b);
  });

  it('tool_calls 双写 (同 callId) 同指纹', () => {
    const a = messageDedupFingerprint('assistant', '[tool: shell]', {
      tool_calls: [{ id: 'call-d58' }],
    });
    const b = messageDedupFingerprint('assistant', '', {
      tool_calls: [{ id: 'call-d58', type: 'function', function: { name: 'execute_shell', arguments: '{"command":"pwd"}' } }],
    });
    expect(a).toBe(b);
  });
});

describe('turnIdsCompatible', () => {
  it('flushPersist 空 turnId 与 forwarder 真 turnId 兼容', () => {
    expect(turnIdsCompatible('', 'chat-1784614105402')).toBe(true);
    expect(turnIdsCompatible('chat-1784614105402', '')).toBe(true);
  });
  it('两个不同真 turnId 不兼容 (跨轮不去重)', () => {
    expect(turnIdsCompatible('chat-1', 'chat-2')).toBe(false);
  });
  it('同 turnId 兼容', () => {
    expect(turnIdsCompatible('chat-1', 'chat-1')).toBe(true);
  });
});
