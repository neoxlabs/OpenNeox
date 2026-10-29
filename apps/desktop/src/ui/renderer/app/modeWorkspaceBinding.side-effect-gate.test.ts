import { describe, it, expect } from 'vitest';
import { shouldApplyWorkspaceSideEffect } from './modeWorkspaceBinding';

describe('shouldApplyWorkspaceSideEffect', () => {
  it('workspace 没变、只是 sessions 刷新, 且已有活跃会话 → 不动 (核心: 切换空档不清掉刚点中的会话)', () => {
    const ref = { current: '/ws/MKAIOrg' as string | null };
    expect(shouldApplyWorkspaceSideEffect(ref, '/ws/MKAIOrg', 'B')).toBe(false);
  });

  it('workspace 没变但还没有活跃会话 → 照常 (启动时 sessions 晚到, 要补一次恢复)', () => {
    const ref = { current: '/ws/a' as string | null };
    expect(shouldApplyWorkspaceSideEffect(ref, '/ws/a', null)).toBe(true);
  });

  it('首次运行 / workspace 真的变了 → 照常, 并记下新 workspace', () => {
    const ref = { current: null as string | null };
    expect(shouldApplyWorkspaceSideEffect(ref, '/ws/a', 'B')).toBe(true);
    expect(ref.current).toBe('/ws/a');
    expect(shouldApplyWorkspaceSideEffect(ref, '/ws/ordersys', 'B')).toBe(true);
    expect(ref.current).toBe('/ws/ordersys');
    /* 同一 workspace 再被 sessions 刷新触发 → 不动 */
    expect(shouldApplyWorkspaceSideEffect(ref, '/ws/ordersys', 'B')).toBe(false);
  });

  it('同一个工作区只是写法不同 (大小写 / 分隔符 / 尾斜杠) → 不算变了', () => {
    const ref = { current: 'C:\\Work\\project' as string | null };
    expect(shouldApplyWorkspaceSideEffect(ref, 'c:/work/project/', 'B')).toBe(false);
  });
});
