/**
 * Q2 ReasoningLoopDetector 单元测试
 *
 * 覆盖:
 *   - streak 计数 (相同 prefix +1, 不同 reset 1, recordToolCall 重置)
 *   - 4 级 reminder (r1/r2/r3/stop) 按阈值触发
 *   - normalize 鲁棒性: 大小写 / markdown / 空白 / 长度截断 不影响相似检测
 *   - reset / peek / stats / __testing exports
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ReasoningLoopDetector,
  REASONING_REMINDER_1_START,
  REASONING_REMINDER_2_START,
  REASONING_REMINDER_3_START,
  REASONING_FORCE_STOP_STREAK,
  __testing,
} from '../reasoningLoopDetector.js';

describe('ReasoningLoopDetector', () => {
  let detector: ReasoningLoopDetector;

  beforeEach(() => {
    detector = new ReasoningLoopDetector();
  });

  // ============================================================================
  // streak 基础
  // ============================================================================

  describe('streak counting', () => {
    it('首次 streak=1, level=none, 无 reminder', () => {
      const r = detector.checkAndRecord('我需要先理解任务. 让我想想.');
      expect(r.streak).toBe(1);
      expect(r.level).toBe('none');
      expect(r.reminder).toBeNull();
      expect(r.forceStop).toBe(false);
    });

    it('完全相同文本连续调 → streak 累加', () => {
      const text = '我需要先理解任务. 让我想想.';
      expect(detector.checkAndRecord(text).streak).toBe(1);
      expect(detector.checkAndRecord(text).streak).toBe(2);
      expect(detector.checkAndRecord(text).streak).toBe(3);
      expect(detector.checkAndRecord(text).streak).toBe(4);
    });

    it('文本前缀相同 (后半段不同) → 仍算相同 (prefix hash)', () => {
      /* 前 100 字符相同 (prefix 用), 后面差别不影响 hash. 用足够长的相同前缀
       * (normalize 去空白后必须 ≥100 字符才能验证 prefix 截断生效). */
      const longHead = 'A'.repeat(120);  /* 120 个英文字符, normalize 后还是 120 */
      detector.checkAndRecord(longHead + ' tail-1-x');
      const r = detector.checkAndRecord(longHead + ' tail-2-y完全不同');
      expect(r.streak).toBe(2);
    });

    it('文本前缀不同 → streak 重置 1', () => {
      detector.checkAndRecord('我需要先理解任务.');
      const r = detector.checkAndRecord('好的, 我现在开始动手实现.');
      expect(r.streak).toBe(1);
    });

    it('recordToolCall → streak 重置 (破环)', () => {
      const text = '我需要思考.';
      detector.checkAndRecord(text);
      detector.checkAndRecord(text);
      detector.checkAndRecord(text);
      expect(detector.peek().streak).toBe(3);

      detector.recordToolCall();
      expect(detector.peek().streak).toBe(0);
      expect(detector.peek().lastHash).toBeNull();

      const r = detector.checkAndRecord(text);
      expect(r.streak).toBe(1);
    });
  });

  // ============================================================================
  // Reminder 升级
  // ============================================================================

  describe('reminder escalation', () => {
    const text = '我需要先理解一下这个问题.';

    it(`streak < ${REASONING_REMINDER_1_START} → 无 reminder`, () => {
      for (let i = 1; i < REASONING_REMINDER_1_START; i++) {
        const r = detector.checkAndRecord(text);
        expect(r.reminder).toBeNull();
        expect(r.level).toBe('none');
      }
    });

    it(`streak ≥ ${REASONING_REMINDER_1_START} → r1`, () => {
      let r;
      for (let i = 0; i < REASONING_REMINDER_1_START; i++) {
        r = detector.checkAndRecord(text);
      }
      expect(r!.level).toBe('r1');
      expect(r!.reminder).toContain('system-reminder');
      expect(r!.reminder).toContain('没调用任何工具');
    });

    it(`streak ≥ ${REASONING_REMINDER_2_START} → r2 (含 streak 数)`, () => {
      let r;
      for (let i = 0; i < REASONING_REMINDER_2_START; i++) {
        r = detector.checkAndRecord(text);
      }
      expect(r!.level).toBe('r2');
      expect(r!.reminder).toContain(`连续 ${REASONING_REMINDER_2_START} 轮`);
      expect(r!.reminder).toContain('死循环');
    });

    it(`streak ≥ ${REASONING_REMINDER_3_START} → r3 (强制总结)`, () => {
      let r;
      for (let i = 0; i < REASONING_REMINDER_3_START; i++) {
        r = detector.checkAndRecord(text);
      }
      expect(r!.level).toBe('r3');
      expect(r!.reminder).toContain('立即停止');
      expect(r!.forceStop).toBe(false);
    });

    it(`streak ≥ ${REASONING_FORCE_STOP_STREAK} → stop (forceStop=true)`, () => {
      let r;
      for (let i = 0; i < REASONING_FORCE_STOP_STREAK; i++) {
        r = detector.checkAndRecord(text);
      }
      expect(r!.level).toBe('stop');
      expect(r!.forceStop).toBe(true);
    });
  });

  // ============================================================================
  // Normalize 鲁棒性
  // ============================================================================

  describe('normalize robustness', () => {
    it('大小写不影响 (英文)', () => {
      detector.checkAndRecord('Let me think about this carefully.');
      const r = detector.checkAndRecord('LET ME THINK ABOUT THIS CAREFULLY.');
      expect(r.streak).toBe(2);
    });

    it('Markdown 符号不影响 (* # _ ` -)', () => {
      detector.checkAndRecord('我需要思考一下这个问题');
      const r = detector.checkAndRecord('**我需要** 思考 *一下* `这个` 问题');
      expect(r.streak).toBe(2);
    });

    it('多空白合并成单空格不影响', () => {
      detector.checkAndRecord('我  需要   思考');
      const r = detector.checkAndRecord('我 需要 思考');
      expect(r.streak).toBe(2);
    });

    it('前后 trim 不影响', () => {
      detector.checkAndRecord('我需要思考');
      const r = detector.checkAndRecord('  我需要思考  \n');
      expect(r.streak).toBe(2);
    });

    it('超长文本只比前 100 字符', () => {
      const head = 'A'.repeat(100);
      detector.checkAndRecord(head + ' tail-1');
      const r = detector.checkAndRecord(head + ' completely-different-tail');
      expect(r.streak).toBe(2);
    });

    it('前 100 字符不同 → 不算同 reasoning', () => {
      detector.checkAndRecord('A'.repeat(100));
      const r = detector.checkAndRecord('B'.repeat(100));
      expect(r.streak).toBe(1);
    });
  });

  // ============================================================================
  // reset / peek / stats
  // ============================================================================

  describe('lifecycle', () => {
    it('reset 清 streak + stats', () => {
      for (let i = 0; i < REASONING_REMINDER_1_START; i++) {
        detector.checkAndRecord('test');
      }
      expect(detector.peek().streak).toBe(REASONING_REMINDER_1_START);
      expect(detector.getStats().r1).toBe(1);

      detector.reset();
      expect(detector.peek().streak).toBe(0);
      expect(detector.peek().lastHash).toBeNull();
      expect(detector.getStats()).toEqual({ r1: 0, r2: 0, r3: 0, stop: 0 });
    });

    it('peek 不修改 state', () => {
      detector.checkAndRecord('x');
      const p1 = detector.peek();
      const p2 = detector.peek();
      expect(p1.streak).toBe(p2.streak);
    });

    it('stats 按 level 累计', () => {
      for (let i = 0; i < REASONING_REMINDER_3_START; i++) {
        detector.checkAndRecord('test reasoning');
      }
      const s = detector.getStats();
      /* streak 3,4 → r1 (x2); 5,6,7 → r2 (x3); 8 → r3 (x1) */
      expect(s.r1).toBe(REASONING_REMINDER_2_START - REASONING_REMINDER_1_START);
      expect(s.r2).toBe(REASONING_REMINDER_3_START - REASONING_REMINDER_2_START);
      expect(s.r3).toBe(1);
      expect(s.stop).toBe(0);
    });
  });

  // ============================================================================
  // 混合场景
  // ============================================================================

  describe('mixed scenarios', () => {
    it('reasoning → tool call → reasoning 应该断 streak', () => {
      const text = '想想看';
      detector.checkAndRecord(text);
      detector.checkAndRecord(text);
      detector.checkAndRecord(text);
      detector.checkAndRecord(text);
      expect(detector.peek().streak).toBe(4);

      detector.recordToolCall();  /* 行动了 */

      detector.checkAndRecord(text);
      expect(detector.peek().streak).toBe(1);
    });

    it('实际死循环场景: 8 轮纯思考 → r3 触发要求 text-only 总结', () => {
      const reasoning = '我需要先理解这个任务的需求, 让我整理一下思路.';
      let r;
      for (let i = 0; i < REASONING_REMINDER_3_START; i++) {
        r = detector.checkAndRecord(reasoning);
      }
      expect(r!.level).toBe('r3');
      expect(r!.reminder).toContain('纯文本总结');
    });

    it('reasoning 措辞略变但 prefix 相同 → 仍被检测', () => {
      /* 让前 100 字符相同 (normalize 去空白后 ≥100), 末尾文件名不同. */
      const head = 'X'.repeat(110);
      const r1 = head + ' touching file A.';
      const r2 = head + ' touching file B.';
      const r3 = head + ' touching file C 完全不同结尾.';

      detector.checkAndRecord(r1);
      detector.checkAndRecord(r2);
      const r = detector.checkAndRecord(r3);
      expect(r.streak).toBe(3);
      expect(r.level).toBe('r1');
    });
  });

  // ============================================================================
  // __testing exports
  // ============================================================================

  describe('__testing', () => {
    it('normalizeAndHashPrefix 暴露', () => {
      expect(typeof __testing.normalizeAndHashPrefix('x')).toBe('string');
    });

    it('djb2Hash 暴露', () => {
      expect(typeof __testing.djb2Hash('x')).toBe('string');
    });

    it('两次相同输入 hash 相同', () => {
      expect(__testing.djb2Hash('hello')).toBe(__testing.djb2Hash('hello'));
    });
  });
});
