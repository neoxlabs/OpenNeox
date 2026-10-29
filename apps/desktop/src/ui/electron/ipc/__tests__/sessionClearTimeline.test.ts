import { describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => any>();
vi.mock('../ipcMainBridged.js', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: (...args: any[]) => any) => handlers.set(ch, fn)) },
}));
vi.mock('../../remoteSessions.js', () => ({ remoteSessions: () => ({ has: () => false }) }));

const { registerSessionCheckpointTimelineIpcHandlers } = await import('../sessionCheckpointTimelineHandlers.js');

describe('session:clear-timeline', () => {
  it('drops the cached copy and leaves the stored timeline alone', async () => {
    const session: any = { id: 's1', messages: [], timeline: [{ id: 'e1' }, { id: 'e2' }] };
    const sessionsCache = new Map<string, any>();
    const sessionStore: any = { setTimeline: vi.fn(), clearTimeline: vi.fn() };
    registerSessionCheckpointTimelineIpcHandlers({
      projectManager: {} as any,
      getSessionOrThrow: async () => session,
      getSqliteSession: () => ({}) as any,
      refreshSession: async () => session,
      persistSession: async (s: any) => s,
      sessionStore,
      sessionsCache,
    });

    await handlers.get('session:clear-timeline')!({ sender: { id: 1 } }, 's1');

    expect(sessionStore.clearTimeline).not.toHaveBeenCalled();
    expect(sessionStore.setTimeline).not.toHaveBeenCalled();
    expect(session.timeline).toBeUndefined();
    expect(sessionsCache.get('s1')).toBe(session);
  });
});
