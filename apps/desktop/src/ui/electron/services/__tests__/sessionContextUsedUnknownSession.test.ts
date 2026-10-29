import { describe, expect, it, vi } from 'vitest';

const updateSessionContextUsed = vi.fn();

vi.mock('../../../../platform-electron/storageService.js', () => ({ storageService: {} }));
vi.mock('@neoxlabs/core/platform/sessionStore.js', () => ({
  sessionStore: { loadSession: vi.fn(async () => null) },
}));
vi.mock('@neoxlabs/platform/platform/database.js', () => ({
  getDatabase: () => ({ updateSessionContextUsed }),
}));
vi.mock('@neoxlabs/core/memory/sqlite-session.js', () => ({ SQLiteSession: class {} }));

const { createSessionStateServices } = await import('../sessionState.js');

describe('updateSessionContextUsed: 库里没有的会话', () => {
  it('子 agent 会话 (Explorer-2-xxx): 正常返回, 不抛, 不落库', async () => {
    const svc = createSessionStateServices(() => undefined);
    await expect(svc.updateSessionContextUsed('Explorer-2-jsdfn9', 12000, { persist: true })).resolves.toBeUndefined();
    expect(updateSessionContextUsed).not.toHaveBeenCalled();
  });

  it('真要拿会话的地方 (getSessionOrThrow) 照旧报错', async () => {
    const svc = createSessionStateServices(() => undefined);
    await expect(svc.getSessionOrThrow('Explorer-2-jsdfn9')).rejects.toThrow('Session not found');
  });
});
