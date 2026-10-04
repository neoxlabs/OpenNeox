/**
 * 压缩挤掉读内容 → 找出该作废读证据的文件 — 行为锁
 *
 * 修的洞: 读账本记的是"我们给模型发过什么", 而压缩会把 readfile 结果清掉/截断/折进摘要。
 * 此后账本仍说 fresh, edit 的一致性诊断就给出**错误的指引** ——
 *   真相: "你手里已经没有那份内容了" (该重读)
 *   诊断: "你读过且文件没变, 是你自己抄错了, 照实际内容重发" (而它看不到实际内容)
 *
 * 不变量: **账本必须镜像上下文, 而不是镜像磁盘。**
 * (对照 Claude Code runAgent.ts:375 子 agent 按上下文 fork 决定克隆/清空账本 —— 同一不变量的两面)
 */
import { describe, it, expect } from 'vitest';
import { findEvictedReadPaths } from '../runnerCompressionUtils.js';

const readCall = (id: string, filePath: string) => ({
  role: 'assistant' as const,
  content: '',
  tool_calls: [{
    id,
    type: 'function' as const,
    function: { name: 'readfile', arguments: JSON.stringify({ file_path: filePath }) },
  }],
});
const readResult = (id: string, content: string) => ({
  role: 'tool' as const,
  content,
  tool_call_id: id,
} as any);

describe('findEvictedReadPaths', () => {
  it('内容被清空 (microCompact 去重) → 该文件要作废', () => {
    const before = [readCall('c1', '/w/a.ts'), readResult('c1', 'full content here')];
    const after = [readCall('c1', '/w/a.ts'), readResult('c1', '[Previous tool result cleared]')];
    expect(findEvictedReadPaths(before, after)).toEqual(['/w/a.ts']);
  });

  it('整条消息被丢掉 (LLM 摘要/折叠) → 该文件要作废', () => {
    const before = [readCall('c1', '/w/a.ts'), readResult('c1', 'full content')];
    expect(findEvictedReadPaths(before, [])).toEqual(['/w/a.ts']);
  });

  it('被截断 (snip) 也算挤掉 —— 模型看不到全文了', () => {
    const before = [readCall('c1', '/w/a.ts'), readResult('c1', 'A'.repeat(100))];
    const after = [readCall('c1', '/w/a.ts'), readResult('c1', 'A'.repeat(20) + '[... snipped ...]')];
    expect(findEvictedReadPaths(before, after)).toEqual(['/w/a.ts']);
  });

  it('内容原样保留 → 不作废 (别白让模型重读)', () => {
    const msgs = [readCall('c1', '/w/a.ts'), readResult('c1', 'unchanged')];
    expect(findEvictedReadPaths(msgs, [...msgs])).toEqual([]);
  });

  it('只动了别的文件 → 只作废被动的那个', () => {
    const before = [
      readCall('c1', '/w/a.ts'), readResult('c1', 'AAA'),
      readCall('c2', '/w/b.ts'), readResult('c2', 'BBB'),
    ];
    const after = [
      readCall('c1', '/w/a.ts'), readResult('c1', 'AAA'),
      readCall('c2', '/w/b.ts'), readResult('c2', '[cleared]'),
    ];
    expect(findEvictedReadPaths(before, after)).toEqual(['/w/b.ts']);
  });

  it('同一文件多次读, 任一次被挤掉就作废 (去重后只报一次)', () => {
    const before = [
      readCall('c1', '/w/a.ts'), readResult('c1', 'v1'),
      readCall('c2', '/w/a.ts'), readResult('c2', 'v2'),
    ];
    const after = [
      readCall('c1', '/w/a.ts'), readResult('c1', '[cleared]'),
      readCall('c2', '/w/a.ts'), readResult('c2', 'v2'),
    ];
    expect(findEvictedReadPaths(before, after)).toEqual(['/w/a.ts']);
  });

  it('非读工具的结果被压缩 → 不关账本的事', () => {
    const shellCall = {
      role: 'assistant' as const, content: '',
      tool_calls: [{ id: 's1', type: 'function' as const,
        function: { name: 'execute_shell', arguments: JSON.stringify({ command: 'ls' }) } }],
    };
    const before = [shellCall, readResult('s1', 'lots of output')];
    const after = [shellCall, readResult('s1', '[cleared]')];
    expect(findEvictedReadPaths(before, after)).toEqual([]);
  });

  it('压根没有读记录 → 空数组 (快路径, 不白算)', () => {
    expect(findEvictedReadPaths([], [])).toEqual([]);
  });
});
