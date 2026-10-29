import { describe, it, expect, beforeEach, vi } from 'vitest';

type Mode = 'auto' | 'manual' | 'dangerous';

/** 装一个最小 window.neox —— store 只认 window.neox.* 这条扁平路径 */
function installBridge(backendGlobal: Mode | null, staleUiState?: Mode) {
  const uiState = new Map<string, string | null>();
  if (staleUiState) uiState.set('approvalModeDefault', staleUiState);
  const calls: Array<{ sessionId: string; mode: Mode; scope?: string }> = [];
  (globalThis as any).window = {
    neox: {
      uiStateGet: async (k: string) => ({ success: true, value: uiState.get(k) ?? null }),
      uiStateSet: async (k: string, v: string | null) => { uiState.set(k, v); return { success: true }; },
      getApprovalMode: async () => ({ mode: backendGlobal ?? undefined }),
      setApprovalMode: async (sessionId: string, mode: Mode, _m?: string, opts?: any) => {
        calls.push({ sessionId, mode, scope: opts?.scope });
      },
    },
  };
  return { uiState, calls };
}

async function freshStore() {
  vi.resetModules();
  return import('../approvalModeStore');
}

beforeEach(() => { delete (globalThis as any).window; });

describe('全局档只认后端', () => {
  it('后端 (config) 是 dangerous、旧 ui_state 副本是 auto → 默认档是 dangerous, 启动时不回写后端', async () => {
    const { calls } = installBridge('dangerous', 'auto');
    const store = await freshStore();
    expect(await store.preloadApprovalModeDefault()).toBe('dangerous');
    expect(calls).toHaveLength(0);
  });
});

describe('resetDangerousApprovalDefaultOnLogout', () => {
  it('dangerous → 降到 auto, 写到后端 global (由后端落 config)', async () => {
    const { calls } = installBridge('dangerous');
    const store = await freshStore();
    const downgraded = await store.resetDangerousApprovalDefaultOnLogout();
    expect(downgraded).toBe(true);
    expect(calls.some(c => c.mode === 'auto' && c.scope === 'global')).toBe(true);
    expect(store.getApprovalModeDefaultSnapshot()).toBe('auto');
  });

  it('manual 不动 —— 那是无害偏好, 登出再登入不该被抹掉', async () => {
    const { calls } = installBridge('manual');
    const store = await freshStore();
    expect(await store.resetDangerousApprovalDefaultOnLogout()).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('auto 不动', async () => {
    const { calls } = installBridge('auto');
    const store = await freshStore();
    expect(await store.resetDangerousApprovalDefaultOnLogout()).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('后端没值时不报错, 也不多写一次', async () => {
    const { calls } = installBridge(null);
    const store = await freshStore();
    await expect(store.resetDangerousApprovalDefaultOnLogout()).resolves.toBe(false);
    expect(calls.filter(c => c.scope === 'global')).toHaveLength(0);
  });
});
