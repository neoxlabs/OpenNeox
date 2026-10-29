import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUIET_HOURS,
  QUIET_HOURS_END,
  QUIET_HOURS_START,
  formatMinutes,
  hhmmOf,
  inQuietWindow,
  minutesOfDay,
  normalizeQuietHours,
} from './quietHours.js';
import { inQuietHours } from './triggers.js';

describe('免打扰统一口径 (pilot:P-03)', () => {
  it('统一钟点 22:30 ~ 07:30, 默认开', () => {
    expect(QUIET_HOURS_START).toBe('22:30');
    expect(QUIET_HOURS_END).toBe('07:30');
    expect(DEFAULT_QUIET_HOURS).toEqual({ enabled: true, start: '22:30', end: '07:30' });
  });

  it('边界: 22:29 不睡, 22:30 起静音, 07:29 仍静音, 07:30 恢复', () => {
    expect(inQuietWindow('22:29')).toBe(false);
    expect(inQuietWindow('22:30')).toBe(true);
    expect(inQuietWindow('23:59')).toBe(true);
    expect(inQuietWindow('00:00')).toBe(true);
    expect(inQuietWindow('07:29')).toBe(true);
    expect(inQuietWindow('07:30')).toBe(false);
    expect(inQuietWindow('12:00')).toBe(false);
  });

  it('触发引擎同一个口径 (老入口保留)', () => {
    expect(inQuietHours('23:00')).toBe(true);
    expect(inQuietHours('07:29')).toBe(true);
    expect(inQuietHours('07:30')).toBe(false);
    expect(inQuietHours('12:00')).toBe(false);
  });

  it('连续 7 天逐分钟: 夜里 0 条推送, 白天一条不少', () => {
    const pushesAt: string[] = [];
    let nightMinutes = 0;
    let allowedAtNight = 0;
    for (let d = 0; d < 7; d++) {
      for (let m = 0; m < 1440; m++) {
        const now = new Date(2026, 9, 12 + d, Math.floor(m / 60), m % 60);
        const quiet = inQuietWindow(now);
        const hhmm = hhmmOf(now);
        if (hhmm >= '22:30' || hhmm < '07:30') {
          nightMinutes++;
          if (!quiet) allowedAtNight++;
        } else if (quiet) {
          pushesAt.push(hhmm);
        }
      }
    }
    expect(nightMinutes).toBe(7 * (90 + 450)); // 22:30–24:00 (90) + 00:00–07:30 (450)
    expect(allowedAtNight).toBe(0);
    expect(pushesAt).toEqual([]);
  });

  it('存盘里的半份 / 写坏的时间退回默认, 自定义时间保留', () => {
    expect(normalizeQuietHours(null)).toEqual(DEFAULT_QUIET_HOURS);
    expect(normalizeQuietHours({ enabled: false })).toEqual({ enabled: false, start: '22:30', end: '07:30' });
    expect(normalizeQuietHours({ start: '9:5', end: '25:99' })).toEqual({ enabled: true, start: '22:30', end: '07:30' });
    expect(normalizeQuietHours({ enabled: false, start: '23:00', end: '08:00' })).toEqual({ enabled: false, start: '23:00', end: '08:00' });
    expect(normalizeQuietHours({ start: '1:00', end: '3:05' })).toEqual({ enabled: true, start: '01:00', end: '03:05' });
  });

  it('分钟换算', () => {
    expect(minutesOfDay('22:30')).toBe(1350);
    expect(minutesOfDay('7:30')).toBe(450);
    expect(minutesOfDay('24:00')).toBeNull();
    expect(formatMinutes(1350)).toBe('22:30');
    expect(inQuietWindow('21:00', { enabled: true, start: '20:00', end: '20:00' })).toBe(true);
  });
});
