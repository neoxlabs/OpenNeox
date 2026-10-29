import { describe, it, expect } from 'vitest';
import { PermissionManager, type PermissionMemoryStorage } from '../PermissionManager.js';
import type { PermissionMemory } from '../../../types/permissions.js';

function memStorage(initial: Record<string, PermissionMemory> = {}) {
  let saved: Record<string, PermissionMemory> = { ...initial };
  const storage: PermissionMemoryStorage = {
    load: () => ({ ...saved }),
    save: (entries) => { saved = { ...entries }; },
  };
  return { storage, saved: () => saved };
}

describe('PermissionManager 总是允许清单', () => {
  it('只列放行的、按时间倒序; 会话内的记忆和拒绝不算', () => {
    const { storage } = memStorage({
      '__always__::browser_run': { toolName: 'browser_run', decision: true, timestamp: 100 },
      '__always__::execute_shell': { toolName: 'execute_shell', decision: true, timestamp: 300 },
      '__always__::delete_file': { toolName: 'delete_file', decision: false, timestamp: 200 },
    });
    const pm = new PermissionManager({ storage });
    (pm as any).saveMemory('write_file', true, 'session-a');

    expect(pm.listAlwaysAllow().map((x) => x.toolName)).toEqual(['execute_shell', 'browser_run']);
  });

  it('撤掉一条: 清单里没了, 盘上也立刻没了 (不等防抖)', () => {
    const disk = memStorage({
      '__always__::browser_run': { toolName: 'browser_run', decision: true, timestamp: 100 },
      '__always__::execute_shell': { toolName: 'execute_shell', decision: true, timestamp: 300 },
    });
    const pm = new PermissionManager({ storage: disk.storage });

    pm.revokeAlwaysAllow('browser_run');

    expect(pm.listAlwaysAllow().map((x) => x.toolName)).toEqual(['execute_shell']);
    expect(Object.keys(disk.saved())).toEqual(['__always__::execute_shell']);
  });
});
