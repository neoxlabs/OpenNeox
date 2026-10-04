import { describe, it, expect, beforeEach } from 'vitest';
import { RecoveryTracker, ProgressTracker, RunAccumulator } from '../runTrackers.js';

// ======================== RecoveryTracker ========================

describe('RecoveryTracker', () => {
  let tracker: RecoveryTracker;

  beforeEach(() => {
    tracker = new RecoveryTracker({ maxRecoveryLimit: 3, diminishingThreshold: 200 });
  });

  describe('onFinishLength — 截断恢复', () => {
    it('首次截断：不耗尽，返回 attempt=1', () => {
      const result = tracker.onFinishLength(5000);
      expect(result.exhausted).toBe(false);
      expect(result.attempt).toBe(1);
      expect(result.maxAttempts).toBe(3);
    });

    it('连续 3 次截断（每次有增量）：第 3 次仍可续，第 4 次耗尽', () => {
      expect(tracker.onFinishLength(5000).exhausted).toBe(false);  // attempt 1
      expect(tracker.onFinishLength(10000).exhausted).toBe(false); // attempt 2
      expect(tracker.onFinishLength(15000).exhausted).toBe(false); // attempt 3 = limit, 但本次仍执行
      const result = tracker.onFinishLength(20000);                // attempt 4 > limit
      expect(result.exhausted).toBe(true);
    });

    it('递减回报检测：连续 2 次增量 < 200 → 提前强制耗尽', () => {
      tracker.onFinishLength(5000);   // attempt 1, lastLen=5000
      tracker.onFinishLength(5100);   // attempt 2, delta=100 < 200, streak=1
      const result = tracker.onFinishLength(5150); // delta=50 < 200, streak=2 → 强制耗尽
      expect(result.exhausted).toBe(true);
    });

    it('递减连击被正常增量重置', () => {
      tracker.onFinishLength(5000);   // attempt 1
      tracker.onFinishLength(5100);   // delta=100 < 200, streak=1
      tracker.onFinishLength(6000);   // delta=900 >= 200, streak=0 (reset)
      const result = tracker.onFinishLength(6050);  // delta=50 < 200, streak=1 (not 2 yet)
      expect(result.exhausted).toBe(true); // 但已经是第 4 次 >= limit=3
    });

    it('tryRecoveryCompact 计数器允许 3 次 (B3 2026-06-28: 从一次性 boolean 改为 limited counter)', () => {
      /* B3 调整： 旧 hasAttemptedRecoveryCompact 是一次性 boolean,
         第一次 prompt_too_long 压缩失败后永远不再尝试 → 长上下文死路。改成 3 次计数。 */
      expect(tracker.tryRecoveryCompact()).toBe(true);  // attempt 1
      expect(tracker.tryRecoveryCompact()).toBe(true);  // attempt 2
      expect(tracker.tryRecoveryCompact()).toBe(true);  // attempt 3
      expect(tracker.tryRecoveryCompact()).toBe(false); // 4 — 拒绝
      expect(tracker.getRecoveryCompactAttempts()).toBe(3);
    });

    it('设置 lastTransitionReason 为 max_output_recovery', () => {
      tracker.onFinishLength(5000);
      expect(tracker.lastTransitionReason).toBe('max_output_recovery');
    });
  });

  describe('onFinishNormal — 正常完成', () => {
    it('重置续跑计数，再次截断从 attempt 1 开始', () => {
      tracker.onFinishLength(5000);
      tracker.onFinishLength(10000);
      tracker.onFinishNormal();
      const result = tracker.onFinishLength(3000);
      expect(result.attempt).toBe(1);
      expect(result.exhausted).toBe(false);
    });
  });

  describe('canFallback — 模型降级', () => {
    it('初始状态可以降级', () => {
      expect(tracker.canFallback()).toBe(true);
    });

    it('已降级过（lastTransitionReason 含 fallback）→ 不能再降级', () => {
      tracker.lastTransitionReason = 'streaming_fallback';
      expect(tracker.canFallback()).toBe(false);
    });

    it('其他 transition reason 不阻止降级', () => {
      tracker.lastTransitionReason = 'max_output_recovery';
      expect(tracker.canFallback()).toBe(true);
    });
  });

  describe('snapshot — 诊断快照', () => {
    it('返回所有关键状态', () => {
      tracker.onFinishLength(5000);
      tracker.streamRetries = 2;
      tracker.providerManagedRetryObserved = true;

      const snap = tracker.snapshot();
      expect(snap.maxOutputRecoveryCount).toBe(1);
      expect(snap.diminishingReturnStreak).toBe(0);
      expect(snap.streamRetries).toBe(2);
      expect(snap.providerManagedRetryObserved).toBe(true);
      expect(snap.lastTransitionReason).toBe('max_output_recovery');
    });
  });

  describe('tryRetry — D8 集中 retry budget (2026-06-28)', () => {
    it('totalRetryAttempts 跨 category 共享上限', () => {
      const t = new RecoveryTracker({ maxTotalRetryBudget: 5 });
      expect(t.tryRetry('stream')).toBe(true);
      expect(t.tryRetry('stream')).toBe(true);
      expect(t.tryRetry('max_output')).toBe(true);
      expect(t.tryRetry('recovery_compact')).toBe(true);
      expect(t.tryRetry('stream')).toBe(true);   // 5/5
      expect(t.tryRetry('stream')).toBe(false);  // 6 拒绝
    });

    it('snapshot 含 totalRetryAttempts + retryByCategory', () => {
      const t = new RecoveryTracker();
      t.tryRetry('stream');
      t.tryRetry('stream');
      t.tryRetry('max_output');
      const snap = t.snapshot();
      expect(snap.totalRetryAttempts).toBe(3);
      expect(snap.retryByCategory).toEqual({ stream: 2, max_output: 1 });
    });

    it('getRetryBudgetSnapshot 暴露 used/max/byCategory/rateLimit', () => {
      const t = new RecoveryTracker({ maxTotalRetryBudget: 10 });
      t.tryRetry('a');
      t.tryRetry('b');
      const s = t.getRetryBudgetSnapshot();
      expect(s).toEqual({ used: 2, max: 10, byCategory: { a: 1, b: 1 }, rateLimit: { used: 0, max: 8 } });
    });

    it('tryRateLimitRetry 独立分桶 — 不消耗通用预算, 触顶自拒 (2026-07-19)', () => {
      const t = new RecoveryTracker({ maxTotalRetryBudget: 5, maxRateLimitRetryBudget: 2 });
      expect(t.tryRateLimitRetry()).toBe(true);
      expect(t.tryRateLimitRetry()).toBe(true);
      expect(t.tryRateLimitRetry()).toBe(false); // 429 分桶耗尽
      // 通用预算完全没被消耗
      expect(t.getRetryBudgetSnapshot().used).toBe(0);
      expect(t.tryRetry('stream')).toBe(true);
      expect(t.snapshot().rateLimitRetryAttempts).toBe(2);
    });
  });
});

// ======================== ProgressTracker ========================

describe('ProgressTracker', () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    tracker = new ProgressTracker({ maxNoToolContinue: 3, maxStructuredRetry: 2 });
  });

  describe('onToolBatch — 工具分支', () => {
    it('重置 textOnlyStreakCount', () => {
      tracker.textOnlyStreakCount = 5;
      tracker.onToolBatch();
      expect(tracker.textOnlyStreakCount).toBe(0);
    });
  });

  describe('consumeNoToolBudget — 无工具预算', () => {
    it('前 3 次不耗尽', () => {
      expect(tracker.consumeNoToolBudget('test')).toBe(false);
      expect(tracker.consumeNoToolBudget('test')).toBe(false);
      expect(tracker.consumeNoToolBudget('test')).toBe(false);
    });

    it('第 4 次超出上限(maxNoToolContinue=3)耗尽', () => {
      tracker.consumeNoToolBudget();
      tracker.consumeNoToolBudget();
      tracker.consumeNoToolBudget();
      expect(tracker.consumeNoToolBudget()).toBe(true);
    });

    it('noToolContinueTotal 正确累加', () => {
      tracker.consumeNoToolBudget();
      tracker.consumeNoToolBudget();
      expect(tracker.noToolContinueTotal).toBe(2);
    });
  });

  describe('consumeStructuredRetryBudget — 结构化重试', () => {
    it('结构化上限(2)先触顶', () => {
      tracker.consumeStructuredRetryBudget(); // retry=1, total=1
      tracker.consumeStructuredRetryBudget(); // retry=2, total=2
      expect(tracker.consumeStructuredRetryBudget()).toBe(true); // retry=3 > 2
    });

    it('独立预算 — 不再扣 noToolContinueTotal (D12/B4 2026-06-28)', () => {
      /* B4 调整： consumeStructuredRetryBudget 不再隐式调 consumeNoToolBudget,
         拆掉双重计数。结构化重试有自己 maxStructuredRetry(2) 上限, 跟 no-tool 预算解耦。 */
      tracker.consumeNoToolBudget(); // total=1
      tracker.consumeNoToolBudget(); // total=2
      tracker.consumeNoToolBudget(); // total=3 — no-tool 满了, 但不影响结构化
      tracker.consumeStructuredRetryBudget(); // retry=1
      expect(tracker.consumeStructuredRetryBudget()).toBe(false); // retry=2, 还没满
      expect(tracker.consumeStructuredRetryBudget()).toBe(true);  // retry=3, 触顶
      expect(tracker.noToolContinueTotal).toBe(3); // 没被结构化重试加污染
    });

    it('structuredRetryCount 正确累加', () => {
      tracker.consumeStructuredRetryBudget();
      tracker.consumeStructuredRetryBudget();
      expect(tracker.structuredRetryCount).toBe(2);
    });
  });

  describe('applyProgressGate — 进度门', () => {
    it('更新 lowProgressStreak 和 completionEvidenceNudges', () => {
      tracker.applyProgressGate({ lowProgressStreak: 3, completionEvidenceNudges: 1 });
      expect(tracker.lowProgressStreak).toBe(3);
      expect(tracker.completionEvidenceNudges).toBe(1);
    });
  });

  describe('resetProgressGate', () => {
    it('重置 lowProgressStreak 为 0', () => {
      tracker.lowProgressStreak = 5;
      tracker.resetProgressGate();
      expect(tracker.lowProgressStreak).toBe(0);
    });
  });

  describe('snapshot', () => {
    it('返回完整状态', () => {
      tracker.textOnlyStreakCount = 2;
      tracker.consumeNoToolBudget();
      tracker.applyProgressGate({ lowProgressStreak: 1, completionEvidenceNudges: 3 });

      const snap = tracker.snapshot();
      expect(snap.textOnlyStreakCount).toBe(2);
      expect(snap.noToolContinueTotal).toBe(1);
      expect(snap.structuredRetryCount).toBe(0);
      expect(snap.lowProgressStreak).toBe(1);
      expect(snap.completionEvidenceNudges).toBe(3);
    });
  });
});

// ======================== RunAccumulator ========================

describe('RunAccumulator', () => {
  let acc: RunAccumulator;

  beforeEach(() => {
    acc = new RunAccumulator();
  });

  it('初始状态全零', () => {
    expect(acc.iteration).toBe(0);
    expect(acc.totalToolCalls).toBe(0);
    expect(acc.finalOutput).toBe('');
    expect(acc.encounteredError).toBe(false);
    expect(acc.stopReason).toBeNull();
  });

  describe('undoIteration', () => {
    it('撤回迭代计数', () => {
      acc.iteration = 5;
      acc.undoIteration();
      expect(acc.iteration).toBe(4);
    });

    it('不下溢（iteration=0 时撤回仍为 0）', () => {
      acc.iteration = 0;
      acc.undoIteration();
      expect(acc.iteration).toBe(0);
    });
  });

  describe('terminate', () => {
    it('设置 stopReason 并标记 encounteredError', () => {
      acc.terminate('interrupted');
      expect(acc.stopReason).toBe('interrupted');
      expect(acc.encounteredError).toBe(true);
    });
  });

  describe('addToolCalls', () => {
    it('累加工具调用数', () => {
      acc.addToolCalls(3);
      acc.addToolCalls(2);
      expect(acc.totalToolCalls).toBe(5);
    });
  });

  describe('addUsage', () => {
    it('更新 token 用量', () => {
      acc.addUsage({ total_tokens: 1000, prompt_tokens: 800, completion_tokens: 200 });
      expect(acc.finalUsageStats.totalTokens).toBe(1000);
      expect(acc.finalUsageStats.promptTokens).toBe(800);
      expect(acc.finalUsageStats.completionTokens).toBe(200);
    });

    it('部分字段更新不影响其他字段', () => {
      acc.addUsage({ total_tokens: 500 });
      expect(acc.finalUsageStats.totalTokens).toBe(500);
      expect(acc.finalUsageStats.promptTokens).toBe(0);
    });
  });
});
