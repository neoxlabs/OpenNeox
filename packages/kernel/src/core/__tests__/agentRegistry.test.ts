/**
 * AgentRegistry 单元测试 — P0-2 Multi-agent
 *
 * 覆盖: register / unregister / get / list / listSiblings / resolveByName / clear
 * 拓扑场景: main agent / sub-agents / nested
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createAgentRegistry, type AgentMetadata } from '../agentRegistry.js';

describe('AgentRegistry', () => {
  let reg: ReturnType<typeof createAgentRegistry>;

  beforeEach(() => {
    reg = createAgentRegistry();
  });

  function makeMeta(overrides: Partial<AgentMetadata> & { sessionId: string; agentName: string }): AgentMetadata {
    return {
      role: 'subagent',
      startedAt: Date.now(),
      ...overrides,
    };
  }

  describe('register / unregister / get', () => {
    it('register 后 get 返 metadata', () => {
      reg.register(makeMeta({ sessionId: 's1', agentName: 'main', role: 'main' }));
      expect(reg.get('s1')?.agentName).toBe('main');
    });

    it('unregister 后 get 返 undefined', () => {
      reg.register(makeMeta({ sessionId: 's1', agentName: 'main' }));
      reg.unregister('s1');
      expect(reg.get('s1')).toBeUndefined();
    });

    it('register 同 sessionId 第二次 → 覆盖', () => {
      reg.register(makeMeta({ sessionId: 's1', agentName: 'old' }));
      reg.register(makeMeta({ sessionId: 's1', agentName: 'new' }));
      expect(reg.get('s1')?.agentName).toBe('new');
    });

    it('unregister 不存在的 id → no-op 不抛错', () => {
      expect(() => reg.unregister('nope')).not.toThrow();
    });
  });

  describe('list', () => {
    it('list 返所有 active agent', () => {
      reg.register(makeMeta({ sessionId: 's1', agentName: 'main', role: 'main' }));
      reg.register(makeMeta({ sessionId: 's2', agentName: 'sub1', parentSessionId: 's1' }));
      reg.register(makeMeta({ sessionId: 's3', agentName: 'sub2', parentSessionId: 's1' }));
      expect(reg.list()).toHaveLength(3);
    });

    it('空 registry → 返空数组', () => {
      expect(reg.list()).toEqual([]);
    });
  });

  describe('listSiblings', () => {
    beforeEach(() => {
      /* 拓扑:
       *   main (s1)
       *   ├─ Explorer-1 (s2, parent=s1)
       *   ├─ Explorer-2 (s3, parent=s1)
       *   └─ Explorer-3 (s4, parent=s1)
       *
       *   independent (s5, parent=undefined — 另一个 task 的 main)
       */
      reg.register(makeMeta({ sessionId: 's1', agentName: 'main', role: 'main' }));
      reg.register(makeMeta({ sessionId: 's2', agentName: 'Explorer-1', parentSessionId: 's1' }));
      reg.register(makeMeta({ sessionId: 's3', agentName: 'Explorer-2', parentSessionId: 's1' }));
      reg.register(makeMeta({ sessionId: 's4', agentName: 'Explorer-3', parentSessionId: 's1' }));
      reg.register(makeMeta({ sessionId: 's5', agentName: 'other-main', role: 'main' }));
    });

    it('sub-agent 的 sibling = 同 parent 其他 sub + parent 本身', () => {
      const siblings = reg.listSiblings('s2');
      const names = siblings.map(a => a.agentName).sort();
      expect(names).toEqual(['Explorer-2', 'Explorer-3', 'main']);
    });

    it('main agent 的 sibling = 它的所有 sub-agent', () => {
      const siblings = reg.listSiblings('s1');
      const names = siblings.map(a => a.agentName).sort();
      expect(names).toEqual(['Explorer-1', 'Explorer-2', 'Explorer-3']);
    });

    it('独立 main 看不到别的 task 的 agent', () => {
      const siblings = reg.listSiblings('s5');
      expect(siblings).toEqual([]);
    });

    it('不存在的 sessionId → 返空数组', () => {
      expect(reg.listSiblings('nope')).toEqual([]);
    });
  });

  describe('resolveByName', () => {
    beforeEach(() => {
      reg.register(makeMeta({ sessionId: 's1', agentName: 'main', role: 'main' }));
      reg.register(makeMeta({ sessionId: 's2', agentName: 'Explorer-1', parentSessionId: 's1' }));
      reg.register(makeMeta({ sessionId: 's3', agentName: 'Explorer-2', parentSessionId: 's1' }));
      reg.register(makeMeta({ sessionId: 'other-s', agentName: 'Explorer-1', role: 'main' })); // 另 task 同名
    });

    it('caller 在 task 内 → 优先匹配 sibling', () => {
      const hit = reg.resolveByName('s2', 'Explorer-2');
      expect(hit?.sessionId).toBe('s3');
    });

    it('caller 在 task 内 → 同名 sibling 优先于全局', () => {
      const hit = reg.resolveByName('s2', 'Explorer-1');
      /* s2 自己 = Explorer-1 → siblings 不含 s2 → 应该 fallback 全局, hit other-s */
      expect(hit?.sessionId).toBe('other-s');
    });

    it('完全找不到 → 返 undefined', () => {
      expect(reg.resolveByName('s2', 'no-such-agent')).toBeUndefined();
    });
  });

  describe('clear / size', () => {
    it('clear 全清', () => {
      reg.register(makeMeta({ sessionId: 's1', agentName: 'a' }));
      reg.register(makeMeta({ sessionId: 's2', agentName: 'b' }));
      expect(reg.size()).toBe(2);
      reg.clear();
      expect(reg.size()).toBe(0);
    });
  });
});
