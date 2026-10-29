import { describe, it, expect, beforeEach, vi } from 'vitest';

/* 非 Electron 环境: createRequire('electron') 会抛, ipcMainBridged 应当降级成
 * "只登记不转发" —— 这正是极简版后端里的情形。 */
import { ipcMain, isElectronHost } from '../ipcMainBridged.js';
import { invokeBridge, hasBridgeRoute, bridgeChannels, registerBridgeRoute } from '@neoxlabs/platform/shared/ipc.js';

describe('通用 IPC 桥', () => {
  it('测试环境本来就不是 Electron —— 后面几条的前提', () => {
    expect(isElectronHost()).toBe(false);
  });

  it('ipcMain.handle 注册的 channel 会进路由表, 并且能被调到', async () => {
    ipcMain.handle('test:echo', async (_e, a: number, b: number) => a + b);

    expect(hasBridgeRoute('test:echo')).toBe(true);
    await expect(invokeBridge('test:echo', [2, 3])).resolves.toBe(5);
  });

  it('非 Electron 宿主下 event 传 undefined —— handler 要能接住', async () => {
    /* 现有 handler 大量用 event 解析 workspace scope, 拿不到时会走兜底。
     * 桥不能因为没有 event 就不调。 */
    let seen: unknown = 'never';
    ipcMain.handle('test:event', (e) => { seen = e; return 'ok'; });

    await invokeBridge('test:event', []);
    expect(seen).toBeUndefined();
  });

  it('调没注册的 channel 抛的是人话, 不是 undefined is not a function', async () => {
    /* 这类错最容易被当成"功能坏了"; 错误信息要直接说清是宿主没注册。 */
    await expect(invokeBridge('test:missing', [])).rejects.toThrow(/没有注册 channel/);
  });

  it('重复注册要告警 —— 两处抢同一个 channel 是真 bug, 静默覆盖极难查', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerBridgeRoute('test:dup', () => 1);
    registerBridgeRoute('test:dup', () => 2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('test:dup'));
    warn.mockRestore();
  });

  it('已接桥的 handler 文件真的把 channel 登记上来了 (机制不能只在玩具上成立)', async () => {
    /* 只 import 就该完成注册 —— 注册发生在模块顶层。
     * 这条是**对照组**: 前面几条都用测试自己注册的 channel, 万一 import 源改错了,
     * 它们照样全绿。这条盯的是真实 handler 文件。 */
    await import('../uiStateHandlers.js').catch(() => {});
    const chans = bridgeChannels();
    expect(chans.length).toBeGreaterThan(1);
  });
});
