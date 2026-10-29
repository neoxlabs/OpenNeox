/**
 * devicePresence 单测 (pilot:H-07)。
 *
 * 这里的失效方式都是静默的: 设备其实关了却判在线 → agent 派活给一台不在的电脑;
 * 心跳迟到把 lastSeenAt 撞回去 → 人明明刚说过话却被当成离线。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEVICE_STALE_MS,
  __resetDevicePresenceForTesting,
  clearDevicePresence,
  listDevicePresence,
  presenceFromHello,
  reportDevicePresence,
} from '../devicePresence.js';

const T0 = 1_700_000_000_000;

describe('devicePresence', () => {
  beforeEach(() => __resetDevicePresenceForTesting());

  it('报到后可读到在线状态、电量、网络', () => {
    reportDevicePresence({ deviceId: 'p1', kind: 'phone', name: 'Pixel', batteryPct: 62, charging: true, network: 'wifi', at: T0 });
    const [d] = listDevicePresence(T0 + 1_000);
    expect(d).toMatchObject({ deviceId: 'p1', kind: 'phone', name: 'Pixel', batteryPct: 62, charging: true, network: 'wifi', online: true });
  });

  it('心跳超过阈值 → 离线, 但仍保留最后在线时间', () => {
    reportDevicePresence({ deviceId: 'd1', kind: 'desktop', at: T0 });
    const [d] = listDevicePresence(T0 + DEVICE_STALE_MS + 1);
    expect(d.online).toBe(false);
    expect(d.lastSeenAt).toBe(T0);
  });

  it('只报电量时不清掉设备名 / 网络 (合并而不是覆盖)', () => {
    reportDevicePresence({ deviceId: 'p1', kind: 'phone', name: 'Pixel', network: 'wifi', at: T0 });
    reportDevicePresence({ deviceId: 'p1', kind: 'phone', batteryPct: 30, at: T0 + 1_000 });
    const [d] = listDevicePresence(T0 + 2_000);
    expect(d).toMatchObject({ name: 'Pixel', network: 'wifi', batteryPct: 30 });
  });

  it('迟到的心跳不让 lastSeenAt 倒退', () => {
    reportDevicePresence({ deviceId: 'p1', kind: 'phone', at: T0 + 10_000 });
    reportDevicePresence({ deviceId: 'p1', kind: 'phone', at: T0 });
    expect(listDevicePresence(T0 + 11_000)[0].lastSeenAt).toBe(T0 + 10_000);
  });

  it('在线设备排在离线前面', () => {
    reportDevicePresence({ deviceId: 'old', kind: 'phone', at: T0 });
    reportDevicePresence({ deviceId: 'new', kind: 'desktop', at: T0 + DEVICE_STALE_MS + 5_000 });
    const all = listDevicePresence(T0 + DEVICE_STALE_MS + 6_000);
    expect(all.map((d) => d.deviceId)).toEqual(['new', 'old']);
  });

  it('非法入参不抛也不入表', () => {
    reportDevicePresence({ deviceId: '', kind: 'phone' });
    reportDevicePresence({ deviceId: 'x', kind: 'watch' as any });
    expect(listDevicePresence(T0)).toEqual([]);
  });

  it('clearDevicePresence 可单台 / 全部清掉', () => {
    reportDevicePresence({ deviceId: 'a', kind: 'phone', at: T0 });
    reportDevicePresence({ deviceId: 'b', kind: 'desktop', at: T0 });
    clearDevicePresence('a');
    expect(listDevicePresence(T0).map((d) => d.deviceId)).toEqual(['b']);
    clearDevicePresence();
    expect(listDevicePresence(T0)).toEqual([]);
  });
});

describe('presenceFromHello', () => {
  it('解析电脑节点心跳', () => {
    expect(presenceFromHello('dev-1', { device_kind: 'desktop', node: true }, T0)).toMatchObject({
      deviceId: 'dev-1',
      kind: 'desktop',
      at: T0,
    });
  });

  it('解析手机心跳并带上电量 / 网络 / 设备名', () => {
    expect(presenceFromHello('pilot-1', { device_kind: 'mobile', battery_pct: 88, charging: false, network: 'cellular', device_name: 'Pixel 9' }, T0))
      .toMatchObject({ kind: 'phone', batteryPct: 88, charging: false, network: 'cellular', name: 'Pixel 9' });
  });

  it('带 payload.device=phone 的 session.input 也算一次报到', () => {
    expect(presenceFromHello('d1', { payload: { device: 'phone', text: 'hi' } }, T0)?.kind).toBe('phone');
  });

  it('认不出设备类型 → null (不把普通 RPC 当心跳)', () => {
    expect(presenceFromHello('d1', { text: 'hi' }, T0)).toBeNull();
    expect(presenceFromHello('d1', null, T0)).toBeNull();
    expect(presenceFromHello('d1', { device_kind: 'tablet' }, T0)).toBeNull();
  });

  it('离谱电量 (负数 / >100 / 非数字) 直接丢掉, 不报假数', () => {
    expect(presenceFromHello('p', { device_kind: 'mobile', battery_pct: -5 }, T0)?.batteryPct).toBeUndefined();
    expect(presenceFromHello('p', { device_kind: 'mobile', battery_pct: 101 }, T0)?.batteryPct).toBeUndefined();
    expect(presenceFromHello('p', { device_kind: 'mobile', battery_pct: 'abc' }, T0)?.batteryPct).toBeUndefined();
    expect(presenceFromHello('p', { device_kind: 'mobile', battery_pct: '77' }, T0)?.batteryPct).toBe(77);
  });
});
