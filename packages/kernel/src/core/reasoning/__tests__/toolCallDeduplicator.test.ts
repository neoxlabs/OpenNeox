/**
 * ToolCallDeduplicator 单元测试
 *
 * 覆盖:
 *   - streak 计数 (相同 +1, 不同重置 1)
 *   - 4 级 reminder (none / r1 / r2 / r3 / stop) 按阈值触发
 *   - reset / peek / stats
 *   - canonicalArgs / makeKey 稳定性
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  ToolCallDeduplicator,
  REPEAT_REMINDER_1_START,
  REPEAT_REMINDER_2_START,
  REPEAT_REMINDER_3_START,
  REPEAT_FORCE_STOP_STREAK,
  __testing,
} from '../toolCallDeduplicator.js';

describe('ToolCallDeduplicator', () => {
  let dedup: ToolCallDeduplicator;

  beforeEach(() => {
    dedup = new ToolCallDeduplicator();
  });

  describe('streak 计数', () => {
    it('首次调用 streak=1, level=none', () => {
      const r = dedup.checkAndRecord('readfile', { path: '/a.ts' });
      expect(r.streak).toBe(1);
      expect(r.level).toBe('none');
      expect(r.reminder).toBeNull();
      expect(r.forceStop).toBe(false);
    });

    it('相同 (name, args) 连续调用 streak 累加', () => {
      const args = { path: '/a.ts' };
      expect(dedup.checkAndRecord('readfile', args).streak).toBe(1);
      expect(dedup.checkAndRecord('readfile', args).streak).toBe(2);
      expect(dedup.checkAndRecord('readfile', args).streak).toBe(3);
      expect(dedup.checkAndRecord('readfile', args).streak).toBe(4);
    });

    it('不同 (name) 重置 streak', () => {
      dedup.checkAndRecord('readfile', { path: '/a.ts' });
      dedup.checkAndRecord('readfile', { path: '/a.ts' });
      expect(dedup.checkAndRecord('search', { pattern: 'x' }).streak).toBe(1);
    });

    it('不同 args 重置 streak (同 tool name)', () => {
      dedup.checkAndRecord('readfile', { path: '/a.ts' });
      dedup.checkAndRecord('readfile', { path: '/a.ts' });
      expect(dedup.checkAndRecord('readfile', { path: '/b.ts' }).streak).toBe(1);
    });
  });

  describe('reminder 升级', () => {
    const args = { path: '/x.ts' };

    it(`streak < ${REPEAT_REMINDER_1_START} 不给 reminder`, () => {
      for (let i = 1; i < REPEAT_REMINDER_1_START; i++) {
        const r = dedup.checkAndRecord('readfile', args);
        expect(r.reminder).toBeNull();
        expect(r.level).toBe('none');
      }
    });

    it(`streak ≥ ${REPEAT_REMINDER_1_START} → r1`, () => {
      let r;
      for (let i = 0; i < REPEAT_REMINDER_1_START; i++) {
        r = dedup.checkAndRecord('readfile', args);
      }
      expect(r!.level).toBe('r1');
      expect(r!.reminder).toContain('system-reminder');
      expect(r!.reminder).toContain('重复同一个 tool call');
    });

    it(`streak ≥ ${REPEAT_REMINDER_2_START} → r2 (含 tool name + count + args)`, () => {
      let r;
      for (let i = 0; i < REPEAT_REMINDER_2_START; i++) {
        r = dedup.checkAndRecord('readfile', args);
      }
      expect(r!.level).toBe('r2');
      expect(r!.reminder).toContain('readfile');
      expect(r!.reminder).toContain(`重复次数: ${REPEAT_REMINDER_2_START}`);
      expect(r!.reminder).toContain('/x.ts');
    });

    it(`streak ≥ ${REPEAT_REMINDER_3_START} → r3 (强制 dead-end 指令)`, () => {
      let r;
      for (let i = 0; i < REPEAT_REMINDER_3_START; i++) {
        r = dedup.checkAndRecord('readfile', args);
      }
      expect(r!.level).toBe('r3');
      expect(r!.reminder).toContain('死循环');
      expect(r!.reminder).toContain('立即停止');
      expect(r!.forceStop).toBe(false);
    });

    it(`streak ≥ ${REPEAT_FORCE_STOP_STREAK} → stop (forceStop=true)`, () => {
      let r;
      for (let i = 0; i < REPEAT_FORCE_STOP_STREAK; i++) {
        r = dedup.checkAndRecord('readfile', args);
      }
      expect(r!.level).toBe('stop');
      expect(r!.forceStop).toBe(true);
      expect(r!.reminder).toContain('死循环');
    });
  });

  describe('reset / peek / stats', () => {
    it('reset 清 streak 和 stats', () => {
      for (let i = 0; i < REPEAT_REMINDER_1_START; i++) {
        dedup.checkAndRecord('readfile', { path: '/a' });
      }
      expect(dedup.peek().streak).toBe(REPEAT_REMINDER_1_START);
      expect(dedup.getStats().r1).toBe(1);

      dedup.reset();
      expect(dedup.peek().streak).toBe(0);
      expect(dedup.peek().lastKey).toBeNull();
      expect(dedup.getStats()).toEqual({ r1: 0, r2: 0, r3: 0, stop: 0 });
    });

    it('peek 不修改 state', () => {
      dedup.checkAndRecord('readfile', { path: '/a' });
      const p1 = dedup.peek();
      const p2 = dedup.peek();
      expect(p1.streak).toBe(p2.streak);
      expect(p1.lastKey).toBe(p2.lastKey);
    });

    it('stats 按 level 累计', () => {
      const args = { path: '/x' };
      /* 跑到 r3 阈值 */
      for (let i = 0; i < REPEAT_REMINDER_3_START; i++) {
        dedup.checkAndRecord('readfile', args);
      }
      const s = dedup.getStats();
      /* 触发顺序: streak 3,4 → r1 (x2); 5,6,7 → r2 (x3); 8 → r3 (x1) */
      expect(s.r1).toBe(REPEAT_REMINDER_2_START - REPEAT_REMINDER_1_START);  // 2
      expect(s.r2).toBe(REPEAT_REMINDER_3_START - REPEAT_REMINDER_2_START);  // 3
      expect(s.r3).toBe(1);
      expect(s.stop).toBe(0);
    });
  });

  describe('canonicalArgs / makeKey', () => {
    it('object args JSON 化', () => {
      expect(__testing.canonicalArgs({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
    });

    it('string args 原样返回', () => {
      expect(__testing.canonicalArgs('hello')).toBe('hello');
    });

    it('null / undefined → 空串', () => {
      expect(__testing.canonicalArgs(null)).toBe('');
      expect(__testing.canonicalArgs(undefined)).toBe('');
    });

    it('循环引用 fallback 到 String(args)', () => {
      const obj: any = { x: 1 };
      obj.self = obj;
      const result = __testing.canonicalArgs(obj);
      /* JSON.stringify 抛, String(obj) 返 "[object Object]" */
      expect(result).toBe('[object Object]');
    });

    it('makeKey 把 toolName + args 拼接', () => {
      const k = __testing.makeKey('readfile', { path: '/a' });
      expect(k).toBe('readfile::{"path":"/a"}');
    });
  });

  describe('混合场景', () => {
    it('同 tool 不同 args 反复切, 不触发 dedup', () => {
      for (let i = 0; i < 20; i++) {
        const r = dedup.checkAndRecord('readfile', { path: `/file${i}.ts` });
        expect(r.level).toBe('none');
        expect(r.streak).toBe(1);
      }
    });

    it('streak 触发后, 换其他 tool 自动 reset', () => {
      const args = { path: '/x' };
      for (let i = 0; i < REPEAT_REMINDER_3_START; i++) {
        dedup.checkAndRecord('readfile', args);
      }
      expect(dedup.peek().streak).toBe(REPEAT_REMINDER_3_START);

      const r = dedup.checkAndRecord('search', { pattern: 'foo' });
      expect(r.streak).toBe(1);
      expect(r.level).toBe('none');
    });
  });
});
