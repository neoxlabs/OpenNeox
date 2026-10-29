import { describe, it, expect, beforeAll } from 'vitest';
import { registerLiteBridgedHandlers } from '../liteBridgeBootstrap.js';
import { bridgeChannels, hasBridgeRoute } from '@neoxlabs/platform/shared/ipc.js';

/** renderer 启动路径上真正会调的那几条 —— 少一条界面就起不来。 */
const BOOT_CRITICAL = [
  'ui:get-last-state',   // App 初始化第一个调用
  'ui:get-theme',
  'cloud:health-probe',  // 登录页"云端不可达"红条
  'provider:get-all',
  'ui-state:get',
];

describe('极简版 IPC 桥装载', () => {
  beforeAll(() => { registerLiteBridgedHandlers(); });

  it('装载后路由表不为空 —— 空表意味着线上每一条调用都会 500', () => {
    expect(bridgeChannels().length).toBeGreaterThan(50);
  });

  it.each(BOOT_CRITICAL)('启动必需 channel 已在桥上: %s', (ch) => {
    expect(hasBridgeRoute(ch)).toBe(true);
  });

  it('装载过程本身不抛 —— 一个模块的 electron 静态 import 会带垮整包', () => {
    expect(() => registerLiteBridgedHandlers()).not.toThrow();
  });
});
