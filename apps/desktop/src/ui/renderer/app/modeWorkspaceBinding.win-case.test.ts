import { describe, it, expect } from 'vitest';
import { shouldKeepActiveSessionOnWorkspaceChange } from './modeWorkspaceBinding';

describe('modeWorkspaceBinding — Windows 路径写法分歧', () => {
  it('会话 bake 的路径与新工作区只差大小写/斜杠时, 仍判定为同一个工作区 (保住活跃会话)', () => {
    expect(shouldKeepActiveSessionOnWorkspaceChange({
      activeSessionId: 's1',
      activeSessionWorkspacePath: 'c:\\users\\me\\proj',   /* 主进程写的 (已 lowercase) */
      nextWorkspacePath: 'C:\\Users\\me\\proj',            /* 渲染层的原始写法 */
    })).toBe(true);
  });

  it('会话没有 workspacePath 时保住它 —— 不能因为"路径未知"就把运行中的会话清掉', () => {
    expect(shouldKeepActiveSessionOnWorkspaceChange({
      activeSessionId: 's1',
      activeSessionWorkspacePath: null,
      nextWorkspacePath: 'C:\\Users\\me\\proj',
    })).toBe(true);
    expect(shouldKeepActiveSessionOnWorkspaceChange({
      activeSessionId: 's1',
      activeSessionWorkspacePath: '',
      nextWorkspacePath: '/Users/me/proj',
    })).toBe(true);
  });

  it('没有活跃会话时仍然不保 (空态该走恢复流程)', () => {
    expect(shouldKeepActiveSessionOnWorkspaceChange({
      activeSessionId: null,
      activeSessionWorkspacePath: null,
      nextWorkspacePath: '/Users/me/proj',
    })).toBe(false);
  });

  it('真的是两个项目时不误保', () => {
    expect(shouldKeepActiveSessionOnWorkspaceChange({
      activeSessionId: 's1',
      activeSessionWorkspacePath: 'C:\\Users\\me\\proj',
      nextWorkspacePath: 'C:\\Users\\me\\other',
    })).toBe(false);
  });
});
