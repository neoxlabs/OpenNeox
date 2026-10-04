/**
 * AgentMessageBus 单元测试 — P0-2 Multi-agent
 *
 * 覆盖: registerInbox / send / receive (一次性消费) / peek / hasMessages /
 *   unregisterInbox / shutdown 消息类型 / 边界 (空 payload / 无 inbox)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createAgentMessageBus } from '../agentMessageBus.js';

describe('AgentMessageBus', () => {
  let bus: ReturnType<typeof createAgentMessageBus>;

  beforeEach(() => {
    bus = createAgentMessageBus();
  });

  describe('register / unregister inbox', () => {
    it('registerInbox 创建 inbox, 重复 register 无副作用', () => {
      bus.registerInbox('s1');
      bus.registerInbox('s1'); // 再调
      expect(bus.inboxCount()).toBe(1);
    });

    it('unregisterInbox 删 inbox, 未读消息一起丢', () => {
      bus.registerInbox('s1');
      bus.registerInbox('s2');
      bus.send({ fromSessionId: 's2', fromAgentName: 'a', toSessionId: 's1', payload: 'hi' });
      expect(bus.totalPending()).toBe(1);

      bus.unregisterInbox('s1');
      expect(bus.totalPending()).toBe(0);
      expect(bus.peek('s1')).toEqual([]);
    });
  });

  describe('send / receive (一次性消费)', () => {
    it('send 后 receive 返消息 + 清 inbox', () => {
      bus.registerInbox('s1');
      const id = bus.send({
        fromSessionId: 's2',
        fromAgentName: 'sender',
        toSessionId: 's1',
        payload: 'hello',
        messageType: 'task',
      });
      expect(id).toMatch(/^msg-/);

      const msgs = bus.receive('s1');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].payload).toBe('hello');
      expect(msgs[0].messageType).toBe('task');

      /* 二次 receive 返空 (一次性消费) */
      expect(bus.receive('s1')).toEqual([]);
    });

    it('多个 send → receive 按 FIFO 顺序', () => {
      bus.registerInbox('s1');
      bus.send({ fromSessionId: 's2', fromAgentName: 'a', toSessionId: 's1', payload: 'first' });
      bus.send({ fromSessionId: 's3', fromAgentName: 'b', toSessionId: 's1', payload: 'second' });
      bus.send({ fromSessionId: 's4', fromAgentName: 'c', toSessionId: 's1', payload: 'third' });

      const msgs = bus.receive('s1');
      expect(msgs.map(m => m.payload)).toEqual(['first', 'second', 'third']);
    });

    it('未 register 接收方 → send 抛错', () => {
      expect(() =>
        bus.send({ fromSessionId: 's1', fromAgentName: 'a', toSessionId: 'no-inbox', payload: 'x' })
      ).toThrow(/没有 inbox/);
    });

    it('空 payload → send 抛错', () => {
      bus.registerInbox('s1');
      expect(() =>
        bus.send({ fromSessionId: 's2', fromAgentName: 'a', toSessionId: 's1', payload: '' })
      ).toThrow(/不能为空/);
      expect(() =>
        bus.send({ fromSessionId: 's2', fromAgentName: 'a', toSessionId: 's1', payload: '   ' })
      ).toThrow(/不能为空/);
    });

    it('messageType 默认 info', () => {
      bus.registerInbox('s1');
      bus.send({ fromSessionId: 's2', fromAgentName: 'a', toSessionId: 's1', payload: 'x' });
      expect(bus.receive('s1')[0].messageType).toBe('info');
    });

    it('self-message 允许', () => {
      bus.registerInbox('s1');
      bus.send({ fromSessionId: 's1', fromAgentName: 'a', toSessionId: 's1', payload: 'note to self' });
      expect(bus.receive('s1')).toHaveLength(1);
    });
  });

  describe('peek (不消费)', () => {
    it('peek 看 inbox 不清', () => {
      bus.registerInbox('s1');
      bus.send({ fromSessionId: 's2', fromAgentName: 'a', toSessionId: 's1', payload: 'x' });

      expect(bus.peek('s1')).toHaveLength(1);
      expect(bus.peek('s1')).toHaveLength(1); // 二次 peek 还有

      bus.receive('s1');
      expect(bus.peek('s1')).toHaveLength(0); // receive 后才清
    });

    it('peek 未 register inbox → 返空数组', () => {
      expect(bus.peek('no-inbox')).toEqual([]);
    });
  });

  describe('hasMessages', () => {
    it('空 inbox / send / receive 状态变化', () => {
      bus.registerInbox('s1');
      expect(bus.hasMessages('s1')).toBe(false);

      bus.send({ fromSessionId: 's2', fromAgentName: 'a', toSessionId: 's1', payload: 'x' });
      expect(bus.hasMessages('s1')).toBe(true);

      bus.receive('s1');
      expect(bus.hasMessages('s1')).toBe(false);
    });
  });

  describe('shutdown 消息类型', () => {
    it('shutdown messageType 正确传递', () => {
      bus.registerInbox('s1');
      bus.send({
        fromSessionId: 'main',
        fromAgentName: 'main',
        toSessionId: 's1',
        payload: 'please exit',
        messageType: 'shutdown',
      });
      const msgs = bus.receive('s1');
      expect(msgs[0].messageType).toBe('shutdown');
    });
  });

  describe('多 agent 互发场景', () => {
    it('A→B + B→A + A→C 全独立 inbox', () => {
      bus.registerInbox('A');
      bus.registerInbox('B');
      bus.registerInbox('C');

      bus.send({ fromSessionId: 'A', fromAgentName: 'A', toSessionId: 'B', payload: 'A->B' });
      bus.send({ fromSessionId: 'B', fromAgentName: 'B', toSessionId: 'A', payload: 'B->A' });
      bus.send({ fromSessionId: 'A', fromAgentName: 'A', toSessionId: 'C', payload: 'A->C' });

      expect(bus.receive('A').map(m => m.payload)).toEqual(['B->A']);
      expect(bus.receive('B').map(m => m.payload)).toEqual(['A->B']);
      expect(bus.receive('C').map(m => m.payload)).toEqual(['A->C']);
    });
  });

  describe('clearAll + totalPending', () => {
    it('clearAll 全清', () => {
      bus.registerInbox('s1');
      bus.send({ fromSessionId: 's2', fromAgentName: 'a', toSessionId: 's1', payload: 'x' });
      expect(bus.totalPending()).toBe(1);

      bus.clearAll();
      expect(bus.totalPending()).toBe(0);
      expect(bus.inboxCount()).toBe(0);
    });
  });
});
