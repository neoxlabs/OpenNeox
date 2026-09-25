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
