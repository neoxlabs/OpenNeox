import { describe, expect, it } from 'vitest';
import {
  OutwardSendGuard,
  OUTWARD_SEND_WINDOW_MS,
  DUPLICATE_SEND_MESSAGE,
} from '../outwardSendGuard.js';

describe('OutwardSendGuard — 同收件人 + 同文本 2 分钟内只发一次 (S-07)', () => {
  it('2 分钟内第二次拦下, 过了窗口放行', () => {
    let now = 1_000_000;
    const guard = new OutwardSendGuard(OUTWARD_SEND_WINDOW_MS, () => now);
    guard.remember('+8613800138000', '我晚点到');

    now += 60_000;
    expect(guard.isDuplicate('+8613800138000', '我晚点到')).toBe(true);

    /* 正好满 2 分钟就不算「2 分钟内」了 */
    now = 1_000_000 + OUTWARD_SEND_WINDOW_MS;
    expect(guard.isDuplicate('+8613800138000', '我晚点到')).toBe(false);
  });

  it('收件人 / 文本任一不同都放行', () => {
    let now = 1_000_000;
    const guard = new OutwardSendGuard(OUTWARD_SEND_WINDOW_MS, () => now);
    guard.remember('+8613800138000', '我晚点到');

    expect(guard.isDuplicate('+8613900139000', '我晚点到')).toBe(false);
    expect(guard.isDuplicate('+8613800138000', '我马上到')).toBe(false);
  });

  it('号码里的空格 / 横线不影响判重, 首尾空白也不影响', () => {
    let now = 1_000_000;
    const guard = new OutwardSendGuard(OUTWARD_SEND_WINDOW_MS, () => now);
    guard.remember('+86 138-0013-8000', '  我晚点到\n');

    expect(guard.isDuplicate('+8613800138000', '我晚点到')).toBe(true);
  });

  it('没记过就不算重复 (失败不记账, 可以重试)', () => {
    const guard = new OutwardSendGuard(OUTWARD_SEND_WINDOW_MS, () => 1_000_000);
    expect(guard.isDuplicate('+8613800138000', '我晚点到')).toBe(false);
  });

  it('回给模型的话说清楚为什么拦', () => {
    expect(DUPLICATE_SEND_MESSAGE).toContain('2 分钟内已发过同样内容');
    expect(DUPLICATE_SEND_MESSAGE).toContain('不要重复发送');
  });
});
