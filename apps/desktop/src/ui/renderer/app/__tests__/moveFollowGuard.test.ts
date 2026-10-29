import { describe, test, expect } from 'vitest';
import { shouldKeepActiveSessionOnWorkspaceChange } from '../modeWorkspaceBinding';

describe('① 切工作区时要不要保住当前会话', () => {
  test('★ 会话归属已经等于目标工作区 → 必须保住 (移动跟随就靠这条)', () => {
    /* moveSessionToWorkspace 先把 activeSession.workspacePath 改成目标, 再派切换事件。
     * 所以切换副作用跑到时, 归属已经对上了 —— 这时绝不能把 activeSession 清成 null,
     * 否则 sendPrompt 见 null 会**自己新建一个会话**, 用户的对话就丢了。 */
    expect(shouldKeepActiveSessionOnWorkspaceChange({
      activeSessionId: 's-1',
      activeSessionWorkspacePath: '/ws/new',
      nextWorkspacePath: '/ws/new',
    })).toBe(true);
  });

  test('归属仍是旧工作区 → 不保 (正常的切项目, 本来就该换)', () => {
    expect(shouldKeepActiveSessionOnWorkspaceChange({
      activeSessionId: 's-1',
      activeSessionWorkspacePath: '/ws/old',
      nextWorkspacePath: '/ws/new',
    })).toBe(false);
  });

  test('没有活跃会话 → 不保', () => {
    expect(shouldKeepActiveSessionOnWorkspaceChange({
      activeSessionId: null,
      activeSessionWorkspacePath: '/ws/new',
      nextWorkspacePath: '/ws/new',
    })).toBe(false);
  });
});

/* ② pending-select 标记的消费顺序 —— 与 pendingSelectFlag.test.ts 同一组契约,
 *    这里只补一条"两者必须同时成立"的组合判据。 */
describe('② 三处判定必须同时成立', () => {
  /** 与 NeoxRuntimeBridge 里那段同形: 什么情况下**不能**把 activeSession 清空 */
  function shouldNotNullActive(input: {
    keepByWorkspace: boolean; pendingNewFlag: boolean; pendingSelectFlag: boolean;
  }): boolean {
    return input.keepByWorkspace || input.pendingNewFlag || input.pendingSelectFlag;
  }

  test('归属已对上 → 不清空 (哪怕标记已经被消费掉了)', () => {
    expect(shouldNotNullActive({
      keepByWorkspace: true, pendingNewFlag: false, pendingSelectFlag: false,
    })).toBe(true);
  });

  test('标记还在 → 也不清空 (归属还没同步到的那一帧)', () => {
    expect(shouldNotNullActive({
      keepByWorkspace: false, pendingNewFlag: false, pendingSelectFlag: true,
    })).toBe(true);
  });

  test('三条都不成立 → 正常清空 (真的是切到一个无关工作区)', () => {
    expect(shouldNotNullActive({
      keepByWorkspace: false, pendingNewFlag: false, pendingSelectFlag: false,
    })).toBe(false);
  });
});
