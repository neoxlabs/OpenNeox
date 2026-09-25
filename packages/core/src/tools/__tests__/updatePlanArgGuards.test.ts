/**
 * update_plan validates malformed arguments, accepts compatible input shapes,
 * and stores only array plans so prompt generation remains safe on later runs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleUpdatePlan,
  getActionFramePrompt,
  notifyActionFrameRunStart,
  __resetActionFrameStateForTesting,
} from '../updatePlan.js';

const SID = 'sess-arg-guard';

beforeEach(() => {
  __resetActionFrameStateForTesting();
});

describe('update_plan 畸形参数', () => {
  it('plan 完全缺失 → 结构化 error, 不抛 TypeError', async () => {
    const out = await handleUpdatePlan({} as any, { sessionId: SID });
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeTruthy();
    expect(out).not.toContain('reading');
  });

  it('args 本身是 undefined → 结构化 error, 不抛 TypeError', async () => {
    const out = await handleUpdatePlan(undefined as any, { sessionId: SID });
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
  });

  it('plan 是字符串 → 结构化 error, 不抛 TypeError', async () => {
    const out = await handleUpdatePlan({ plan: 'not-an-array' } as any, { sessionId: SID });
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
  });

  it('plan 是对象数组但元素缺 step → 结构化 error, 不抛 TypeError', async () => {
    const out = await handleUpdatePlan(
      { plan: [{ status: 'in_progress' }] } as any,
      { sessionId: SID },
    );
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
  });

  it('畸形参数不会污染 action-frame 内存态 (下一次 getActionFramePrompt 不崩)', async () => {
    await handleUpdatePlan(undefined as any, { sessionId: SID });
    notifyActionFrameRunStart(SID);
    expect(() => getActionFramePrompt(SID)).not.toThrow();
  });

  /* Session state always stores an array so the next prompt can filter it. */
  it('传入字符串 plan 后, 会话内存态里的 plan 仍是数组', async () => {
    await handleUpdatePlan({ plan: 'nope' } as any, { sessionId: SID });
    notifyActionFrameRunStart(SID);
    expect(() => getActionFramePrompt(SID)).not.toThrow();
  });
});

describe('update_plan 可救回的形态', () => {
  it('plan 传成 JSON 字符串 → 解析后正常更新', async () => {
    /* The run starts first because the action frame accepts plans updated in
     * the current run. */
    notifyActionFrameRunStart(SID);
    const out = await handleUpdatePlan(
      { plan: '[{"step":"修 bug","status":"in_progress"}]' } as any,
      { sessionId: SID },
    );
    expect(JSON.parse(out).success).toBe(true);
    expect(getActionFramePrompt(SID)).toContain('修 bug');
  });

  it('steps 键名 (旧 update_todolist 习惯) → 正常更新', async () => {
    const out = await handleUpdatePlan(
      { steps: [{ step: '跑测试', status: 'completed' }, { step: '打包', status: 'in_progress' }] } as any,
      { sessionId: SID },
    );
    expect(JSON.parse(out).success).toBe(true);
  });

  it('call_tool 包装层 { name, args } → 正常更新', async () => {
    notifyActionFrameRunStart(SID);
    const out = await handleUpdatePlan(
      { name: 'update_plan', args: { plan: [{ step: '被包一层', status: 'in_progress' }] } } as any,
      { sessionId: SID },
    );
    expect(JSON.parse(out).success).toBe(true);
    expect(getActionFramePrompt(SID)).toContain('被包一层');
  });

  it('多步骤但 status 缺失 → 视为 pending, 不是崩', async () => {
    const out = await handleUpdatePlan(
      { plan: [{ step: '第一步' }, { step: '第二步', status: 'in_progress' }] } as any,
      { sessionId: SID },
    );
    expect(JSON.parse(out).success).toBe(true);
  });
});

describe('既有语义不被破坏', () => {
  it('多个 in_progress 仍被拒 (原规则保留)', async () => {
    const out = await handleUpdatePlan({
      plan: [
        { step: 'a', status: 'in_progress' },
        { step: 'b', status: 'in_progress' },
      ],
    }, { sessionId: SID });
    expect(JSON.parse(out).success).toBe(false);
    expect(JSON.parse(out).error).toContain('in_progress');
  });

  it('正常 plan 返回 success 且带 message', async () => {
    const out = await handleUpdatePlan({
      plan: [{ step: '唯一步骤', status: 'in_progress' }],
    }, { sessionId: SID });
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toBeTruthy();
  });
});
