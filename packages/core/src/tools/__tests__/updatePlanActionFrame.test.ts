/**
 * action-frame 门控测试 .
 *
 * 语义: 只有"本次 run 内 update_plan 过"的会话才注入每轮 action-frame;
 * 无 plan / plan 早于 runStart / plan 全部完成 → null (kernel no-op)。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleUpdatePlan,
  getActionFramePrompt,
  getUnfinishedPlanSteps,
  notifyActionFrameRunStart,
  __resetActionFrameStateForTesting,
} from '../updatePlan.js';

const SID = 'sess-af-test';

describe('getActionFramePrompt 门控', () => {
  beforeEach(() => {
    __resetActionFrameStateForTesting();
  });

  it('无 plan → null', () => {
    notifyActionFrameRunStart(SID);
    expect(getActionFramePrompt(SID)).toBeNull();
  });

  it('本次 run 内更新过的 plan → 注入 frame (含当前步骤与进度)', async () => {
    notifyActionFrameRunStart(SID);
    await handleUpdatePlan(
      {
        plan: [
          { step: '读取配置文件', status: 'completed' },
          { step: '修复解析逻辑', status: 'in_progress' },
          { step: '补回归测试', status: 'pending' },
          { step: '更新文档', status: 'pending' },
        ],
      },
      { sessionId: SID },
    );
    const frame = getActionFramePrompt(SID);
    expect(frame).toBeTruthy();
    expect(frame).toContain('修复解析逻辑');
    expect(frame).toContain('1/4');
  });

  it('plan 早于 runStart (上个任务遗留) → null', async () => {
    await handleUpdatePlan(
      { plan: [{ step: '旧任务步骤', status: 'in_progress' }] },
      { sessionId: SID },
    );
    /* 新 run 开始 — 旧 plan 视为陈旧 */
    await new Promise((r) => setTimeout(r, 5));
    notifyActionFrameRunStart(SID);
    expect(getActionFramePrompt(SID)).toBeNull();
  });

  it('plan 全部完成 → null (别再催)', async () => {
    notifyActionFrameRunStart(SID);
    await handleUpdatePlan(
      {
        plan: [
          { step: '第一步', status: 'completed' },
          { step: '第二步', status: 'completed' },
        ],
      },
      { sessionId: SID },
    );
    expect(getActionFramePrompt(SID)).toBeNull();
  });

  it('无 in_progress 但有 pending → 提示先标记当前步骤', async () => {
    notifyActionFrameRunStart(SID);
    await handleUpdatePlan(
      {
        plan: [
          { step: '第一步', status: 'completed' },
          { step: '第二步', status: 'pending' },
        ],
      },
      { sessionId: SID },
    );
    const frame = getActionFramePrompt(SID);
    expect(frame).toBeTruthy();
    expect(frame).toContain('in_progress');
  });

  it('sessionId 为空 → 永远 null', () => {
    expect(getActionFramePrompt(undefined)).toBeNull();
    expect(getActionFramePrompt(null)).toBeNull();
  });
});

/* 收尾闸 (runtimeBuilder.unfinishedPlanNudge) 的数据源: 只认本 run 的 plan, 做完的步不算 */
describe('getUnfinishedPlanSteps', () => {
  beforeEach(() => {
    __resetActionFrameStateForTesting();
  });

  it('本 run 的 plan 还剩两步 → 列出这两步', async () => {
    notifyActionFrameRunStart(SID);
    await handleUpdatePlan(
      {
        plan: [
          { step: '核对表单链路', status: 'completed' },
          { step: '实现附件同步', status: 'in_progress' },
          { step: '跑针对性测试', status: 'pending' },
        ],
      },
      { sessionId: SID },
    );
    expect(getUnfinishedPlanSteps(SID)).toEqual(['实现附件同步', '跑针对性测试']);
  });

  it('全做完 / 上个任务遗留 / 没 plan → 空', async () => {
    expect(getUnfinishedPlanSteps(SID)).toEqual([]);
    await handleUpdatePlan({ plan: [{ step: '旧任务', status: 'in_progress' }] }, { sessionId: SID });
    await new Promise((r) => setTimeout(r, 5));
    notifyActionFrameRunStart(SID);
    expect(getUnfinishedPlanSteps(SID)).toEqual([]);
    await handleUpdatePlan({ plan: [{ step: '新任务', status: 'completed' }] }, { sessionId: SID });
    expect(getUnfinishedPlanSteps(SID)).toEqual([]);
  });
});
/* work:Q-06 —— 用户点「跳过这一步」之后, 这一步既不该进未完成清单 (收尾闸别再催),
 * 也不该出现在 action-frame 的待办里。 */
describe('skipped 状态 (用户跳过的步骤)', () => {
  beforeEach(() => {
    __resetActionFrameStateForTesting();
  });

  it('skipped 不算未完成', async () => {
    notifyActionFrameRunStart(SID);
    await handleUpdatePlan(
      {
        plan: [
          { step: '收集素材', status: 'completed' },
          { step: '做竞品对比', status: 'skipped' },
          { step: '写初稿', status: 'in_progress' },
        ],
      },
      { sessionId: SID },
    );
    expect(getUnfinishedPlanSteps(SID)).toEqual(['写初稿']);
  });

  it('全部 completed/skipped → 不再催 (未完成清单为空)', async () => {
    notifyActionFrameRunStart(SID);
    await handleUpdatePlan(
      {
        plan: [
          { step: '收集素材', status: 'completed' },
          { step: '做竞品对比', status: 'skipped' },
        ],
      },
      { sessionId: SID },
    );
    expect(getUnfinishedPlanSteps(SID)).toEqual([]);
  });

  it('action-frame 的待办里不再列出被跳过的步骤', async () => {
    notifyActionFrameRunStart(SID);
    await handleUpdatePlan(
      {
        plan: [
          { step: '做竞品对比', status: 'skipped' },
          { step: '写初稿', status: 'in_progress' },
          { step: '排版', status: 'pending' },
        ],
      },
      { sessionId: SID },
    );
    const frame = getActionFramePrompt(SID) ?? '';
    expect(frame).toContain('写初稿');
    expect(frame).not.toContain('做竞品对比');
    /* 语言跟随本机配置, 所以只断言步骤名在不在, 不断言 "待办:" 这个前缀 */
    expect(frame).toContain('排版');
  });
});
