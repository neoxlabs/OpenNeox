import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_QUIET_HOURS } from '@neoxlabs/pilot-data-sdk';
import { getNotifyConfig, isInQuietHours } from '../notifyStore';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../../../../..');
const read = (p: string) => readFileSync(resolve(REPO, p), 'utf8');

function at(day: number, h: number, m: number): Date {
  return new Date(2026, 9, day, h, m);
}

describe('免打扰统一 22:30–07:30', () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('新装就是 22:30–07:30 且开着', () => {
    expect(getNotifyConfig().quietHours).toEqual(DEFAULT_QUIET_HOURS);
    expect(DEFAULT_QUIET_HOURS).toEqual({ enabled: true, start: '22:30', end: '07:30' });
  });

  it('边界: 22:29 弹, 22:30 不弹, 07:29 不弹, 07:30 弹', () => {
    const q = getNotifyConfig().quietHours;
    expect(isInQuietHours(q, at(18, 22, 29))).toBe(false);
    expect(isInQuietHours(q, at(18, 22, 30))).toBe(true);
    expect(isInQuietHours(q, at(19, 7, 29))).toBe(true);
    expect(isInQuietHours(q, at(19, 7, 30))).toBe(false);
  });

  it('连续 7 天逐分钟: 免打扰窗口内 0 条通知', () => {
    const q = getNotifyConfig().quietHours;
    let nightPushes = 0;
    let dayBlocked = 0;
    for (let d = 0; d < 7; d++) {
      for (let m = 0; m < 1440; m++) {
        const t = at(18 + d, Math.floor(m / 60), m % 60);
        const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
        const quiet = isInQuietHours(q, t);
        if (hhmm >= '22:30' || hhmm < '07:30') {
          if (!quiet) nightPushes++;
        } else if (quiet) {
          dayBlocked++;
        }
      }
    }
    expect(nightPushes).toBe(0);
    expect(dayBlocked).toBe(0);
  });

  it('老默认 22:00–07:00 跟新口径走; 自己改过的时间不动', () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    store.set('neox.notify-config-v1', JSON.stringify({ quietHours: { enabled: false, start: '22:00', end: '07:00' } }));
    expect(getNotifyConfig().quietHours).toEqual(DEFAULT_QUIET_HOURS);

    store.set('neox.notify-config-v1', JSON.stringify({ quietHours: { enabled: false, start: '23:15', end: '06:45' } }));
    expect(getNotifyConfig().quietHours).toEqual({ enabled: false, start: '23:15', end: '06:45' });
  });

  it('main 进程两处也从统一常量取, 不再各写一份时间', () => {
    for (const p of [
      'apps/desktop/src/ui/electron/ipc/pilotHandlers.ts',
      'apps/desktop/src/ui/electron/services/pilotPhoneLink.ts',
      'apps/desktop/src/ui/electron/services/pilotCallService.ts',
    ]) {
      const src = read(p);
      expect(src, p).toContain('DEFAULT_QUIET_HOURS');
      expect(src, p).not.toMatch(/'22:00'/);
      expect(src, p).not.toMatch(/'08:00'/);
    }
  });

  it('手机端镜像同一口径 (Flutter 常量)', () => {
    const src = read('apps/mobile/lib/core/notifications/notify_prefs.dart');
    expect(src).toContain("static const quietStart = '22:30';");
    expect(src).toContain("static const quietEnd = '07:30';");
    expect(src).toContain("getBool('notify_quiet') ?? true");
  });
});
