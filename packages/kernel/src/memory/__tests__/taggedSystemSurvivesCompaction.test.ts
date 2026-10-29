/**
 * 打标 system 消息必须活过压缩 — 行为锁
 *
 * 知识库 / 项目记忆 / 动态模块上下文 走的都是 `upsertSystemTagged(tag, content)`:
 * 同一个 tag 永远只有一条, 内容变了就**原地更新**(位置不变 → 前缀缓存不破)。
 *
 * 但压缩链是 `getMessagesForLLM()` → 改写 → `setMessages()`, 而 getMessagesForLLM 的
 * stripMetadata 会把 `_tag` 剥掉 (它是内部元数据, 不该发给模型)。于是压缩一次之后
 * 标记就永久丢了, 下一次 upsert 找不到旧条目 → **追加一条新的**:
 *   · system 段每压一次就多一份副本, 越滚越大
 *   · system 内容变了 = 前缀缓存整段作废 (Anthropic 是 longest-prefix match)
 *
 * 这个测试锁的就是"压缩不许把打标信息弄丢"。
 */
import { describe, it, expect } from 'vitest';
import { ShortTermMemory } from '../shortterm.js';

describe('打标 system 消息 vs 压缩', () => {
  function makeMemory(): ShortTermMemory {
    const mem = new ShortTermMemory();
    mem.add({ role: 'system', content: '你是 Neox' });
    mem.upsertSystemTagged('dynamic_context', '## 模块上下文: src-renderer\n渲染层规矩若干');
    mem.add({ role: 'user', content: '改一下 Foo.vue' });
    mem.add({ role: 'assistant', content: '好' });
    return mem;
  }

  it('压缩改写 memory 之后, 同 tag 仍然是原地更新而不是追加', () => {
    const mem = makeMemory();
    const before = mem.getAll().filter(m => m.role === 'system').length;
    expect(before).toBe(2);

    /* 模拟压缩: 取走 → 改写 → 写回 (compressContextWindow 就是这么干的) */
    const rewritten = mem.getMessagesForLLM();
    mem.setMessages(rewritten);

    /* 注入器再来一次 (用户又碰了同一个模块的文件) */
    mem.upsertSystemTagged('dynamic_context', '## 模块上下文: src-renderer\n渲染层规矩若干 + 新增一条');

    const systems = mem.getAll().filter(m => m.role === 'system');
    expect(systems.length).toBe(2);                       // 不许变 3 条
    expect(systems.filter(m => String(m.content).includes('模块上下文')).length).toBe(1);
    expect(String(systems[1]!.content)).toContain('新增一条');   // 且确实更新了
  });

  it('反复压缩 + 注入不会让 system 段无限膨胀', () => {
    const mem = makeMemory();
    for (let i = 0; i < 5; i++) {
      mem.setMessages(mem.getMessagesForLLM());
      mem.upsertSystemTagged('dynamic_context', `## 模块上下文: src-renderer\n第 ${i} 版`);
    }
    const systems = mem.getAll().filter(m => m.role === 'system');
    expect(systems.length).toBe(2);
    expect(String(systems.find(m => String(m.content).includes('模块上下文'))!.content)).toContain('第 4 版');
  });

  it('removeSystemTagged 在压缩之后依然找得到目标', () => {
    const mem = makeMemory();
    mem.setMessages(mem.getMessagesForLLM());
    mem.removeSystemTagged('dynamic_context');
    expect(mem.getAll().filter(m => String(m.content).includes('模块上下文')).length).toBe(0);
  });
});
