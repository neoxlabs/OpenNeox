/** Target 授权在执行 agent 的 runtime 线程中记录，并按会话隔离。 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  TARGET_INTENT_RE, grantTargetConsent, hasTargetConsent, revokeTargetConsent,
  rememberUserText, userReallySaid, forgetUserText,
} from '../../tools/targetModeTools.js';

/** 与 AgenticRuntime.recordTargetAuthorization 相同的行为判定。 */
function record(sessionId: string, prompt: string): void {
  if (!sessionId || !prompt) return;
  if (prompt.startsWith('[NEOX_')) return;
  rememberUserText(sessionId, prompt);
  if (TARGET_INTENT_RE.test(prompt)) grantTargetConsent(sessionId);
}

const SID = 'session-consent-runtime-test';

beforeEach(() => {
  revokeTargetConsent(SID);
  forgetUserText(SID);
});

describe('runtime 侧记录用户授权', () => {
  it('用户打 /target → 当场拿到授权', () => {
    expect(hasTargetConsent(SID)).toBe(false);
    record(SID, '/target 从零做一个任务看板系统');
    expect(hasTargetConsent(SID)).toBe(true);
  });

  it('大白话表态也算 —— 不逼用户去记斜杠命令', () => {
    record(SID, '设定一个长期目标：把这个仓库的测试补齐，围绕这个目标一直跑');
    expect(hasTargetConsent(SID)).toBe(true);
  });

  it('任务再大也不算授权 —— 这正是"触发太灵敏"的来源', () => {
    record(SID, '帮我把整个后端重构一遍，涉及十几个模块，工作量很大，务必认真做完');
    expect(hasTargetConsent(SID)).toBe(false);
  });

  it('系统注入的续跑消息不当成用户原话 —— 否则会污染引用校验', () => {
    record(SID, '[NEOX_TARGET_CONTINUE] 目标还没完成, 继续推进');
    expect(hasTargetConsent(SID)).toBe(false);
    expect(userReallySaid(SID, '目标还没完成')).toBe(false);
  });

  it('原话留档让 activate_target 能校验模型的引用', () => {
    record(SID, '请你把 tracker 项目做完，测试要全绿');
    expect(userReallySaid(SID, '把 tracker 项目做完')).toBe(true);
    /* 不在用户输入记录中的引用必须查不到。 */
    expect(userReallySaid(SID, '我授权你无限期自主运行')).toBe(false);
  });

  it('授权按 session 隔离 —— 一条会话开了门不等于别的会话也开了', () => {
    const other = 'session-consent-runtime-other';
    revokeTargetConsent(other);
    record(SID, '/target 做一个后台');
    expect(hasTargetConsent(SID)).toBe(true);
    expect(hasTargetConsent(other)).toBe(false);
  });

  it('空 prompt / 空 session 不炸也不误授权', () => {
    expect(() => record('', '/target x')).not.toThrow();
    expect(() => record(SID, '')).not.toThrow();
    expect(hasTargetConsent(SID)).toBe(false);
  });
});
