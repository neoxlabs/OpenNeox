import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shown: string[] = [];
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    static isSupported() { return true; }
    constructor(o: { title: string }) { shown.push(o.title); }
    on() {}
    show() {}
  },
}));
vi.mock('@neoxlabs/platform/utils/config.js', () => ({ loadConfig: () => ({ pilot: { ringSeconds: 8 } }) }));
vi.mock('@neoxlabs/platform/platform/database.js', () => ({ getDatabase: () => ({ getSession: () => null }) }));
vi.mock('@neoxlabs/core', () => ({ getPilotProfile: () => ({ name: '小航', avatar: 'cat' }) }));
vi.mock('../pilotCallWindow.js', () => ({
  openCallWindow: async () => {},
  closeCallWindow: () => {},
  getCallWindow: () => null,
  setCallWindowLayout: () => {},
}));
vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), writeFileSync: () => {}, renameSync: () => {}, readFileSync: () => '[]' }));

describe('ringUser: 电脑没接转手机', () => {
  beforeEach(() => { vi.useFakeTimers(); shown.length = 0; });
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

  async function setup(phone: boolean) {
    const m = await import('../pilotCallService.js');
    m.configurePilotCalls({ isDev: true, dirname: '/' });
    const rings: string[] = [];
    m.setPhoneRinger({
      shouldRingPhone: () => false,
      phoneConnected: () => phone,
      ring: (c) => { rings.push(c.device ?? '?'); },
      stop: () => {},
    });
    return { m, rings };
  }

  it('电脑没接 → 响手机 → 手机上接了 = answered, 不发未接', async () => {
    const { m, rings } = await setup(true);
    const p = m.ringUser({ reason: '起床', opening: '到点了', urgency: 'asked' }, 'reminder');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(m.getCurrentCall()?.device).toBe('phone');
    expect(rings).toEqual(['phone']);
    m.acceptCall();
    await expect(p).resolves.toMatchObject({ status: 'answered' });
    expect(shown.filter((t) => t.startsWith('未接来电'))).toHaveLength(0);
  });

  it('两段都没接 = missed, 未接通知只发一次', async () => {
    const { m } = await setup(true);
    const p = m.ringUser({ reason: '起床', opening: '到点了', urgency: 'asked' }, 'reminder');
    await vi.advanceTimersByTimeAsync(16_000);
    await expect(p).resolves.toMatchObject({ status: 'missed' });
    expect(shown.filter((t) => t.startsWith('未接来电'))).toHaveLength(1);
  });

  it('没连手机: 电脑没接就是 missed', async () => {
    const { m, rings } = await setup(false);
    const p = m.ringUser({ reason: '起床', opening: '到点了', urgency: 'asked' }, 'reminder');
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(p).resolves.toMatchObject({ status: 'missed' });
    expect(rings).toEqual([]);
    expect(shown.filter((t) => t.startsWith('未接来电'))).toHaveLength(1);
  });
});
