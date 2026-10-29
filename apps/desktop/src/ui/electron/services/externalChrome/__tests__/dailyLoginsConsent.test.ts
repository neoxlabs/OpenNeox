import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const h = vi.hoisted(() => ({
  cfg: { reuseDailyLogins: false, dailyLoginsDecided: false } as { reuseDailyLogins: boolean; dailyLoginsDecided: boolean },
  saved: [] as Array<{ reuseDailyLogins?: boolean }>,
  sent: [] as Array<{ channel: string; payload: any }>,
  windows: [] as any[],
  bus: null as any,
}));

vi.mock('electron', async () => {
  const { EventEmitter: E } = await import('node:events');
  h.bus = new E();
  return {
    ipcMain: h.bus,
    BrowserWindow: { getAllWindows: () => h.windows },
  };
});
vi.mock('@neoxlabs/platform/platform/configService.js', () => ({
  configService: {
    getBrowserUseConfig: () => ({ ...h.cfg }),
    setBrowserUseConfig: (patch: { reuseDailyLogins?: boolean }) => {
      h.saved.push(patch);
      if (typeof patch.reuseDailyLogins === 'boolean') h.cfg = { reuseDailyLogins: patch.reuseDailyLogins, dailyLoginsDecided: true };
    },
  },
}));
vi.mock('@neoxlabs/kernel/platform/cliLogger.js', () => ({ cliLogger: { info: () => {}, warn: () => {} } }));

import { resolveDailyLoginsChoice } from '../dailyLoginsConsent.js';

const win = () => ({
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: (channel: string, payload: any) => h.sent.push({ channel, payload }) },
});

beforeEach(() => {
  h.cfg = { reuseDailyLogins: false, dailyLoginsDecided: false };
  h.saved = [];
  h.sent = [];
  h.windows = [win()];
  (h.bus as EventEmitter).removeAllListeners();
  vi.useRealTimers();
});

describe('resolveDailyLoginsChoice', () => {
  it('switch on: reuses without asking', async () => {
    h.cfg = { reuseDailyLogins: true, dailyLoginsDecided: true };
    expect(await resolveDailyLoginsChoice()).toBe(true);
    expect(h.sent).toHaveLength(0);
  });

  it('decided no: never asks', async () => {
    h.cfg = { reuseDailyLogins: false, dailyLoginsDecided: true };
    expect(await resolveDailyLoginsChoice()).toBe(false);
    expect(h.sent).toHaveLength(0);
  });

  it('undecided: asks once and saves the answer; concurrent launches share the question', async () => {
    const a = resolveDailyLoginsChoice();
    const b = resolveDailyLoginsChoice();
    expect(h.sent).toHaveLength(1);
    const id = h.sent[0].payload.id;
    h.bus.emit(`browser:daily-logins-ack-${id}`);
    h.bus.emit('browser:daily-logins-answer', {}, { id, allow: true });
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(h.saved).toEqual([{ reuseDailyLogins: true }]);
    expect(await resolveDailyLoginsChoice()).toBe(true);
    expect(h.sent).toHaveLength(1);
  });

  it('no ack from the renderer: launches without and saves nothing', async () => {
    vi.useFakeTimers();
    const p = resolveDailyLoginsChoice();
    await vi.advanceTimersByTimeAsync(1600);
    expect(await p).toBe(false);
    expect(h.saved).toEqual([]);
  });

  it('no window: launches without and saves nothing', async () => {
    h.windows = [];
    expect(await resolveDailyLoginsChoice()).toBe(false);
    expect(h.saved).toEqual([]);
  });

  it('answers for another prompt are ignored', async () => {
    const p = resolveDailyLoginsChoice();
    const id = h.sent[0].payload.id;
    h.bus.emit(`browser:daily-logins-ack-${id}`);
    h.bus.emit('browser:daily-logins-answer', {}, { id: id + 99, allow: true });
    h.bus.emit('browser:daily-logins-answer', {}, { id, allow: false });
    expect(await p).toBe(false);
    expect(h.saved).toEqual([{ reuseDailyLogins: false }]);
  });
});
