import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { ToolPermission } from '@neoxlabs/kernel/types/permissions.js';
import { PermissionManager } from '@neoxlabs/kernel/core/permissions/PermissionManager.js';

function createTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    async function() {
      return 'ok';
    },
  };
}

describe('PermissionManager risk policy', () => {
  it('auto: high-risk action runs without asking', async () => {
    const approvalHandler = vi.fn(async () => ({ approved: false, remember: false }));
    const manager = new PermissionManager({
      approvalHandler,
      defaultPermission: ToolPermission.ALLOW,
      scopeModeResolver: () => 'auto',
    });

    const decision = await manager.checkPermission(
      createTool('execute_shell'),
      { command: 'git reset --hard HEAD~1' },
      { scopeKey: 'agent:main' },
    );

    expect(decision.allowed).toBe(true);
    expect(approvalHandler).not.toHaveBeenCalled();
  });

  it('auto: critical action still asks and cannot be remembered', async () => {
    const approvalHandler = vi.fn(async () => ({ approved: false, remember: false }));
    const manager = new PermissionManager({
      approvalHandler,
      defaultPermission: ToolPermission.ALLOW,
      scopeModeResolver: () => 'auto',
    });

    const decision = await manager.checkPermission(
      createTool('execute_shell'),
      { command: 'rm -rf ~' },
      { scopeKey: 'agent:main' },
    );

    expect(decision.allowed).toBe(false);
    expect(approvalHandler).toHaveBeenCalledTimes(1);
    expect(approvalHandler.mock.calls[0]?.[0]?.risk?.level).toBe('critical');
    expect(approvalHandler.mock.calls[0]?.[0]?.allowRemember).toBe(false);
  });

  it('manual: high-risk action still asks', async () => {
    const approvalHandler = vi.fn(async () => ({ approved: false, remember: false }));
    const manager = new PermissionManager({
      approvalHandler,
      defaultPermission: ToolPermission.ALLOW,
      scopeModeResolver: () => 'manual',
    });

    const decision = await manager.checkPermission(
      createTool('execute_shell'),
      { command: 'git reset --hard HEAD~1' },
      { scopeKey: 'agent:main' },
    );

    expect(decision.allowed).toBe(false);
    expect(approvalHandler).toHaveBeenCalledTimes(1);
  });

  it('sub-agent scope inherits the parent session approval mode', async () => {
    const approvalHandler = vi.fn(async () => ({ approved: false, remember: false }));
    const modes: Record<string, 'auto' | 'manual' | 'dangerous'> = { 'parent-session': 'dangerous' };
    const manager = new PermissionManager({
      approvalHandler,
      defaultPermission: ToolPermission.ALLOW,
      scopeModeResolver: (key) => (key && modes[key]) || 'auto',
    });
    manager.inheritScope('agent_x_1', 'parent-session');
    manager.inheritScope('explore_y_2', 'agent_x_1');

    expect(manager.getScopeMode({ scopeKey: 'agent_x_1' })).toBe('dangerous');
    expect(manager.getScopeMode({ scopeKey: 'explore_y_2' })).toBe('dangerous');
    const decision = await manager.checkPermission(
      createTool('execute_shell'),
      { command: 'rm -rf ~' },
      { scopeKey: 'explore_y_2' },
    );
    expect(decision.allowed).toBe(true);
    expect(approvalHandler).not.toHaveBeenCalled();
  });

  it('keeps low-risk allowed action as direct allow in auto mode', async () => {
    const approvalHandler = vi.fn(async () => ({ approved: false, remember: false }));
    const manager = new PermissionManager({
      approvalHandler,
      defaultPermission: ToolPermission.ALLOW,
      scopeModeResolver: () => 'auto',
    });
    manager.setToolPermission({
      toolName: 'readfile',
      permission: ToolPermission.ALLOW,
    });

    const decision = await manager.checkPermission(
      createTool('readfile'),
      { file_path: 'README.md' },
      { scopeKey: 'agent:main' },
    );

    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe('mode');
    expect(approvalHandler).not.toHaveBeenCalled();
  });
});
