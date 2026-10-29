import { describe, it, expect } from 'vitest';
import { shouldSkipLastSessionRestore } from './modeWorkspaceBinding';

describe('shouldSkipLastSessionRestore', () => {
  it('活跃会话属于本 workspace → 跳过恢复 (核心: 不让旧 lastSession 顶掉刚建的会话)', () => {
    expect(shouldSkipLastSessionRestore({
      activeSessionId: 'B',
      activeSessionWorkspacePathFromList: '/Users/me/proj',
      nextWorkspacePath: '/Users/me/proj',
      restoreSessionId: 'A',
    })).toBe(true);
  });

  it('Windows 大小写/斜杠写法不同仍判为同一 workspace', () => {
    expect(shouldSkipLastSessionRestore({
      activeSessionId: 'B',
      activeSessionWorkspacePathFromList: 'c:\\users\\me\\proj',
      nextWorkspacePath: 'C:\\Users\\me\\proj',
      restoreSessionId: 'A',
    })).toBe(true);
  });

  it('要恢复的就是当前活跃会话 → 跳过 (恢复是 no-op, 别白触发 setState)', () => {
    expect(shouldSkipLastSessionRestore({
      activeSessionId: 'A',
      activeSessionWorkspacePathFromList: null,
      nextWorkspacePath: '/Users/me/proj',
      restoreSessionId: 'A',
    })).toBe(true);
  });

  it('没有活跃会话 → 不跳过 (正常走恢复)', () => {
    expect(shouldSkipLastSessionRestore({
      activeSessionId: null,
      activeSessionWorkspacePathFromList: null,
      nextWorkspacePath: '/Users/me/proj',
      restoreSessionId: 'A',
    })).toBe(false);
  });

  it('活跃会话确实属于别的 workspace → 不跳过 (恢复是对的)', () => {
    expect(shouldSkipLastSessionRestore({
      activeSessionId: 'B',
      activeSessionWorkspacePathFromList: '/Users/me/other',
      nextWorkspacePath: '/Users/me/proj',
      restoreSessionId: 'A',
    })).toBe(false);
  });

  it('活跃会话路径未知 → 不跳过, 交给上游 shouldKeepActiveSessionOnWorkspaceChange 兜底', () => {
    /* 这里故意不"路径未知就保住": 那条取舍属于上游守卫 (它已经这么做了)。
     * 本函数只回答"列表证据是否表明它属于本 workspace", 没证据就不越权。 */
    expect(shouldSkipLastSessionRestore({
      activeSessionId: 'B',
      activeSessionWorkspacePathFromList: null,
      nextWorkspacePath: '/Users/me/proj',
      restoreSessionId: 'A',
    })).toBe(false);
  });
});
