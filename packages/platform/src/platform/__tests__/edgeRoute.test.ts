import { describe, expect, it } from 'vitest';
import { chooseEdge, DEFAULT_EDGES, hostResolverRulesFor, mapUrlForEdge, validEdgeList, type EdgeDef } from '../edgeRoute.js';

/* 测试用的备选线路 (不是真实线路) */
const alt: EdgeDef = {
  id: 'hk',
  ip: '203.0.113.10',
  alias: { 'neox-dev.com': 'e1.neox-dev.com', 'gateway.neox-dev.com': 'gw-e1.neox-dev.com' },
};

describe('chooseEdge', () => {
  it('默认线路更快 → 留在默认线路', () => {
    expect(chooseEdge({ cf: { ok: 3, medianMs: 60 }, hk: { ok: 3, medianMs: 260 } }, 'cf')).toBe('cf');
  });
  it('默认线路丢请求 (成功更少) → 换线路', () => {
    expect(chooseEdge({ cf: { ok: 2, medianMs: 3100 }, hk: { ok: 3, medianMs: 320 } }, 'cf')).toBe('hk');
  });
  it('都通但默认线路慢一半以上 → 换; 只慢一点不切 (防抖)', () => {
    expect(chooseEdge({ cf: { ok: 3, medianMs: 1500 }, hk: { ok: 3, medianMs: 400 } }, 'cf')).toBe('hk');
    expect(chooseEdge({ cf: { ok: 3, medianMs: 500 }, hk: { ok: 3, medianMs: 400 } }, 'cf')).toBe('cf');
  });
  it('备选线路不通 → 回默认线路', () => {
    expect(chooseEdge({ cf: { ok: 3, medianMs: 3000 }, hk: { ok: 0, medianMs: null } }, 'hk')).toBe('cf');
  });
  it('全都不通 (断网) → 保持现状, 不乱切', () => {
    expect(chooseEdge({ cf: { ok: 0, medianMs: null }, hk: { ok: 0, medianMs: null } }, 'hk')).toBe('hk');
  });
});

describe('mapUrlForEdge (Bun 改主机名)', () => {
  it('接口 / 网关换成线路专用入口, 路径 / 查询 / 协议不变', () => {
    expect(mapUrlForEdge('https://neox-dev.com/api/v1/auth/me?x=1', alt)).toBe('https://e1.neox-dev.com/api/v1/auth/me?x=1');
    expect(mapUrlForEdge('https://gateway.neox-dev.com/n1/chat/completions', alt)).toBe('https://gw-e1.neox-dev.com/n1/chat/completions');
    expect(mapUrlForEdge('wss://gateway.neox-dev.com/n1/asr/stream', alt)).toBe('wss://gw-e1.neox-dev.com/n1/asr/stream');
  });
  it('下载站 / 第三方 / 默认线路一律不动', () => {
    expect(mapUrlForEdge('https://dl.neox-dev.com/mobile/x.apk', alt)).toBe('https://dl.neox-dev.com/mobile/x.apk');
    expect(mapUrlForEdge('https://api.openai.com/v1/x', alt)).toBe('https://api.openai.com/v1/x');
    expect(mapUrlForEdge('https://neox-dev.com/x', DEFAULT_EDGES[0])).toBe('https://neox-dev.com/x');
  });
});

describe('validEdgeList (服务端清单)', () => {
  it('默认清单合法; 必须带 cf 兜底; alias 只能指向 neox-dev.com', () => {
    expect(validEdgeList(DEFAULT_EDGES)).toBe(true);
    expect(validEdgeList([{ id: 'cf' }])).toBe(true);
    expect(validEdgeList([alt])).toBe(false);
    expect(validEdgeList([{ id: 'cf' }, { id: 'x', ip: '1.2.3.4', alias: { 'neox-dev.com': 'evil.com' } }])).toBe(false);
    expect(validEdgeList([])).toBe(false);
  });
});

describe('hostResolverRulesFor (Electron 渲染层)', () => {
  it('备选线路: 每个原域名 MAP 到它的 IP; 默认线路: 不改', () => {
    expect(hostResolverRulesFor(alt)).toBe(
      Object.keys(alt.alias!).map(h => `MAP ${h} ${alt.ip}`).join(', '));
    expect(hostResolverRulesFor(DEFAULT_EDGES[0])).toBeNull();
  });
});
