import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionManager } from '../PermissionManager.js';
import { ToolPermission, ToolCategory } from '../../../types/permissions.js';
import { __resetApprovalCacheForTest } from '../approvalCache.js';

function makeShellTool() {
  return {
    name: 'execute_shell',
    description: 'run shell',
    category: ToolCategory.EXECUTE,
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    execute: async () => ({ content: 'ok' }),
  } as any;
}

describe('PermissionManager manual mode vs Always Allow', () => {
  beforeEach(() => {
    __resetApprovalCacheForTest();
  });

  it('manual 模式下忽略 Always Allow，仍要求审批', async () => {
    const approvalHandler = vi.fn(async () => ({ approved: true, remember: false }));
    const pm = new PermissionManager({
      approvalHandler,
      scopeModeResolver: () => 'manual',
    });
    pm.setToolPermission({
      toolName: 'execute_shell',
      permission: ToolPermission.ASK,
      allowRemember: true,
    });
    // 模拟历史 Always Allow
    (pm as any).saveMemory('execute_shell', true, '__always__');

    const decision = await pm.checkPermission(makeShellTool(), { command: 'echo hi' }, { scopeKey: 'session-x' });
    expect(approvalHandler).toHaveBeenCalledTimes(1);
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe('user');
  });

  /* 档位重定义后, auto 档对 low·medium 直接按档位放行 (source='mode'),
   * 根本走不到 Always Allow 那一步 —— 免审这个结果不变, 但来源变了。 */
  it('auto 模式下这类命令仍免审 (现在是档位放行)', async () => {
    const approvalHandler = vi.fn(async () => ({ approved: true, remember: false }));
    const pm = new PermissionManager({
      approvalHandler,
      scopeModeResolver: () => 'auto',
    });
    pm.setToolPermission({
      toolName: 'execute_shell',
      permission: ToolPermission.ASK,
      allowRemember: true,
    });
    (pm as any).saveMemory('execute_shell', true, '__always__');

    const decision = await pm.checkPermission(makeShellTool(), { command: 'echo hi' }, { scopeKey: 'session-y' });
    expect(approvalHandler).not.toHaveBeenCalled();
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe('mode');
  });
});
