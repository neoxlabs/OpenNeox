import { describe, expect, it, vi } from 'vitest';
import { buildResumePill, isTurnInterrupted, resumeAnchor } from '../useResumePill';
import { INTERRUPTED_NOTICE_ID_PREFIX } from '../turnAnomaly';
import type { TimelineEntry } from '../../../utils/workspaceUtils';

/**
 * work:Q-21 中断后给「继续这一轮」入口
 *
 * 验收: 中断后输入框上方出现「停在第 N 步 · 继续」, 点一下从该步开始。
 * 这里锁三件事: 什么时候该出现 / 步骤号取哪一步 / 点了真的调回调。
 */

const interruptedEntry = (turnId = 'u1'): TimelineEntry => ({
  id: `${INTERRUPTED_NOTICE_ID_PREFIX}${turnId}`,
  type: 'log',
  title: '已停止',
  detail: '本轮已由用户中断',
  timestamp: Date.now(),
} as TimelineEntry);

const userMsg = (id = 'u1'): TimelineEntry => ({
  id,
  type: 'user_message',
  detail: '帮我做一份周报',
  timestamp: Date.now() - 1000,
} as TimelineEntry);


describe('isTurnInterrupted', () => {
  it('最后一条用户消息之后有「已停止」→ true', () => {
    expect(isTurnInterrupted([userMsg('u1'), interruptedEntry('u1')])).toBe(true);
  });

  it('停止记录属于上一轮, 这一轮是新问题 → false', () => {
    expect(isTurnInterrupted([
      userMsg('u1'),
      interruptedEntry('u1'),
      userMsg('u2'),
    ])).toBe(false);
  });

  it('没有任何停止记录 → false', () => {
    expect(isTurnInterrupted([userMsg('u1')])).toBe(false);
    expect(isTurnInterrupted([])).toBe(false);
  });
});

describe('resumeAnchor', () => {
  it('优先 in_progress 那一步', () => {
    expect(resumeAnchor([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ])).toEqual({ index: 1, text: 'b' });
  });

  it('没有 in_progress 时取第一个 pending', () => {
    expect(resumeAnchor([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'pending' },
    ])).toEqual({ index: 1, text: 'b' });
  });

  it('跳过 / 已完成的不算「该从这步继续」', () => {
    expect(resumeAnchor([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'skipped' },
      { content: 'c', status: 'pending' },
    ])).toEqual({ index: 2, text: 'c' });
  });

  it('全做完了 → null', () => {
    expect(resumeAnchor([{ content: 'a', status: 'completed' }])).toBeNull();
    expect(resumeAnchor([])).toBeNull();
  });
});

describe('buildResumePill', () => {
  const base = {
    isZh: true,
    interrupted: true,
    anchor: { index: 2, text: '写初稿' },
    updatedAt: 1,
    onResume: () => {},
  };

  it('中断 + 空闲 → 出一颗「停在第 3 步」的药丸, meta 是继续', () => {
    const pill = buildResumePill(base);
    expect(pill).not.toBeNull();
    expect(pill!.label).toBe('停在第 3 步');
    expect(pill!.meta).toBe('继续');
    expect(pill!.detail).toBe('写初稿');
    expect(pill!.tone).toBe('warn');
  });

  it('正在跑 → 不出 (本轮已经接着在做了)', () => {
    expect(buildResumePill({ ...base, running: true })).toBeNull();
  });

  it('这一轮没被用户停 → 不出 (超时/余额归异常区)', () => {
    expect(buildResumePill({ ...base, interrupted: false })).toBeNull();
  });

  it('没有计划步骤时不出 —— 那种中断交给异常区那一行, 不重复', () => {
    expect(buildResumePill({ ...base, anchor: null })).toBeNull();
  });

  it('整颗药丸可点 → 触发续跑 (不再重复给一枚「继续」按钮)', () => {
    const onResume = vi.fn();
    const pill = buildResumePill({ ...base, onResume })!;
    expect(pill.actions ?? []).toHaveLength(0);
    pill.onActivate?.();
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('英文界面文案', () => {
    const pill = buildResumePill({ ...base, isZh: false })!;
    expect(pill.label).toBe('Stopped at step 3');
    expect(pill.meta).toBe('Resume');
  });
});
