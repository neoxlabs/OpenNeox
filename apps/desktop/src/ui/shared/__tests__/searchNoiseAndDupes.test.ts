import { describe, it, expect } from 'vitest';
import { hitFromMessage, dedupeHits, searchSessions } from '../sessionSearch';

const S = { id: 's1', name: '益生菌缓解肠道痉挛方法', updatedAt: 1 };
const msg = (id: string, role: string, text: string) => ({ id, role, text, timestamp: 1 });

describe('搜索结果的角色过滤', () => {
  it('system 消息不进结果 —— 那是脚手架不是对话', () => {
    const sys = msg('m1', 'system',
      '…26112 上次任务摘要 [2026-09-04 08:59] User: 这个益生菌如何 -> Completed in 3977ms, tokens 22320');
    expect(hitFromMessage(S, sys, '益生菌')).toBeNull();
  });

  it('user / assistant 照常进结果', () => {
    expect(hitFromMessage(S, msg('m2', 'user', '如何益生菌 能肠道痉挛'), '益生菌')).toBeTruthy();
    expect(hitFromMessage(S, msg('m3', 'assistant', '益生菌确实可能引起肠道痉挛'), '益生菌')).toBeTruthy();
  });

  it('大小写和空角色都挡住 —— 库里存什么就是什么, 不能只认小写', () => {
    expect(hitFromMessage(S, msg('m4', 'System', '益生菌'), '益生菌')).toBeNull();
    expect(hitFromMessage(S, msg('m5', 'tool', '益生菌'), '益生菌')).toBeNull();
    expect(hitFromMessage(S, msg('m6', '', '益生菌'), '益生菌')).toBeNull();
  });
});

describe('搜索结果去重', () => {
  it('同一会话 + 同角色 + 同片段 只留一条', () => {
    const hits = [
      hitFromMessage(S, msg('m1', 'user', '如何益生菌 能肠道痉挛'), '益生菌')!,
      hitFromMessage(S, msg('m2', 'user', '如何益生菌 能肠道痉挛'), '益生菌')!,
    ];
    expect(hits.length).toBe(2);            /* 造出来确实是两条 */
    expect(dedupeHits(hits).length).toBe(1); /* 到用户眼前只该有一条 */
  });

  it('不同会话的同一句话各留各的 —— 那是两次真实的对话', () => {
    const a = hitFromMessage(S, msg('m1', 'user', '这个益生菌如何'), '益生菌')!;
    const b = hitFromMessage({ id: 's2', name: '益生菌效果如何', updatedAt: 2 },
      msg('m2', 'user', '这个益生菌如何'), '益生菌')!;
    expect(dedupeHits([a, b]).length).toBe(2);
  });

  it('同一句话但角色不同要各留各的 (你问的和 AI 复述的不是一回事)', () => {
    const a = hitFromMessage(S, msg('m1', 'user', '这个益生菌如何'), '益生菌')!;
    const b = hitFromMessage(S, msg('m2', 'assistant', '这个益生菌如何'), '益生菌')!;
    expect(dedupeHits([a, b]).length).toBe(2);
  });

  it('searchSessions 出去之前就已经去过重了', () => {
    const sessions = [{
      ...S,
      messages: [
        msg('m1', 'user', '如何益生菌 能肠道痉挛'),
        msg('m2', 'user', '如何益生菌 能肠道痉挛'),
        msg('m3', 'system', '上次任务摘要 益生菌 tokens 22320'),
      ],
    }] as never;
    const hits = searchSessions(sessions, '益生菌');
    expect(hits.length).toBe(1);
    expect(hits[0].messageRole).toBe('user');
  });
});
