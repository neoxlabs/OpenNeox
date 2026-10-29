import { describe, expect, it } from 'vitest';
import { mapsTool, wgs84ToBd09 } from '../mapsTool.js';

describe('maps', () => {
  it('WGS84 → BD09: 天安门偏移落在百度坐标附近, 境外不偏', () => {
    const [lat, lng] = wgs84ToBd09(39.9087, 116.3975);
    expect(lat).toBeCloseTo(39.9156, 2);
    expect(lng).toBeCloseTo(116.4104, 2);
    const [tLat, tLng] = wgs84ToBd09(35.6812, 139.7671);
    /* 境外只剩 GCJ→BD 那一小步 (~0.006°), 不会被挪出几百米 */
    expect(Math.abs(tLat - 35.6812)).toBeLessThan(0.01);
    expect(Math.abs(tLng - 139.7671)).toBeLessThan(0.01);
  });

  it('没配 key 直说缺什么, 不发请求', async () => {
    const prev = process.env.NEOX_BAIDU_AK;
    delete process.env.NEOX_BAIDU_AK;
    const out = JSON.parse(await (mapsTool.function as (a: unknown) => Promise<string>)({ action: 'traffic', road: '长安街', city: '北京' }));
    if (prev !== undefined) process.env.NEOX_BAIDU_AK = prev;
    expect(out.success).toBe(false);
    expect(String(out.error)).toMatch(/没配地图 key|地图/);
  });
});
