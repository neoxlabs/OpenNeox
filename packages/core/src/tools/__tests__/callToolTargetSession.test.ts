import { describe, expect, it, beforeEach } from 'vitest';
import { ToolTreeEngine } from '../toolTreeEngine.js';
import {
  activateTargetFromCommand,
  getTargetStatus,
  planTargetTool,
  runWithTargetSession,
  setActiveTargetSession,
} from '../targetModeTools.js';

/**
 * target_* 经 call_tool 派发时必须使用正确的 session slot，而不是共享的 fallback session。
 */
describe('call_tool target session scope', () => {
  beforeEach(() => {
    setActiveTargetSession(null);
  });

  it('context.sessionId 让 plan_target 打到主 session, 即使 fallback 已被串号', async () => {
    const mainSid = 'session-main-target';
    const otherSid = 'session-subagent-noise';

    runWithTargetSession(mainSid, () => {
      activateTargetFromCommand('ship feature X');
    });
    expect(getTargetStatus(mainSid)).toBe('active');

    /* 模拟子 agent buildRunner 把 fallback 拍成别的 sid */
    setActiveTargetSession(otherSid);
    expect(getTargetStatus()).toBe('off');

    const engine = new ToolTreeEngine([planTargetTool]);
    const callTool = engine.liveTools.find((t) => t.name === 'call_tool')!;

    const res = await callTool.function(
      {
        name: 'plan_target',
        args: {
          target: 'ship feature X',
          sub_missions: [
            { id: 'b1', description: 'one', status: 'completed' },
            { id: 'b2', description: 'two', status: 'in_progress' },
          ],
        },
      },
      {
        sessionId: mainSid,
        checkNestedToolGate: async () => ({ allowed: true }),
      },
    );

    const parsed = JSON.parse(String(res));
    expect(parsed.ok).toBe(true);
    expect(parsed.completed).toBe(1);
    expect(getTargetStatus(mainSid)).toBe('active');
    expect(getTargetStatus(otherSid)).toBe('off');
  });

  it('无 sessionId 且 fallback 串号时会打到错误 slot (对照: 修前行为)', async () => {
    const mainSid = 'session-main-bare';
    const otherSid = 'session-other-bare';

    runWithTargetSession(mainSid, () => {
      activateTargetFromCommand('goal');
    });
    setActiveTargetSession(otherSid);

    const engine = new ToolTreeEngine([planTargetTool]);
    const callTool = engine.liveTools.find((t) => t.name === 'call_tool')!;

    const res = await callTool.function(
      {
        name: 'plan_target',
        args: {
          target: 'goal',
          sub_missions: [{ id: 'b1', description: 'x', status: 'pending' }],
        },
      },
      { checkNestedToolGate: async () => ({ allowed: true }) },
    );

    const parsed = JSON.parse(String(res));
    expect(String(parsed.error || '')).toMatch(/TARGET MISSION ENDED|current status/i);
    /* 主 session 仍保持激活状态，不受其他 session 的派发影响。 */
    expect(getTargetStatus(mainSid)).toBe('active');
  });
});
