import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ app: null as any }));


let requestWindowsUpdateInstall: typeof import('./windowsUpdateInstall.js').requestWindowsUpdateInstall;
let requestInstallerOnQuit: typeof import('./windowsUpdateInstall.js').requestInstallerOnQuit;
let cancelPendingWindowsUpdateInstall: typeof import('./windowsUpdateInstall.js').cancelPendingWindowsUpdateInstall;

beforeEach(async () => {
  vi.resetModules();
  mock.app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  vi.doMock('electron', () => ({ app: mock.app }));
  ({ requestWindowsUpdateInstall, requestInstallerOnQuit, cancelPendingWindowsUpdateInstall } = await import('./windowsUpdateInstall.js'));
});

describe('Windows update quit handoff', () => {
  it('waits for actual quit, not before-quit or cleanup, and suppresses the updater quit hook', () => {
    const updater = { autoInstallOnAppQuit: true, quitAndInstall: vi.fn() };
    mock.app.on('quit', () => {
      if (updater.autoInstallOnAppQuit) updater.quitAndInstall();
    });
    requestWindowsUpdateInstall(updater);
    expect(mock.app.quit).toHaveBeenCalledOnce();
    expect(updater.autoInstallOnAppQuit).toBe(false);
    mock.app.emit('before-quit');
    mock.app.emit('will-quit');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    mock.app.emit('quit', {}, 0);
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    mock.app.emit('quit', {}, 0);
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('cancels installation and restores the prior auto-install preference', () => {
    const updater = { autoInstallOnAppQuit: true, quitAndInstall: vi.fn() };
    requestWindowsUpdateInstall(updater);
    cancelPendingWindowsUpdateInstall();
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(mock.app.listenerCount('quit')).toBe(0);
    mock.app.emit('quit', {}, 0);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    requestWindowsUpdateInstall(updater);
    mock.app.emit('quit', {}, 0);
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('preserves Later and deduplicates repeated install requests', () => {
    const updater = { autoInstallOnAppQuit: false, quitAndInstall: vi.fn() };
    requestWindowsUpdateInstall(updater);
    requestWindowsUpdateInstall(updater);
    expect(mock.app.quit).toHaveBeenCalledOnce();
    cancelPendingWindowsUpdateInstall();
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it('does not open an external installer before quit or start a second cached update', () => {
    const updater = { autoInstallOnAppQuit: true, quitAndInstall: vi.fn() };
    const install = vi.fn();
    requestInstallerOnQuit(install, updater);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(install).not.toHaveBeenCalled();
    mock.app.emit('quit', {}, 0);
    expect(install).toHaveBeenCalledOnce();
  });

  it('skips installation on a nonzero exit code', () => {
    const install = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    requestInstallerOnQuit(install);
    mock.app.emit('quit', {}, 1);
    expect(install).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[auto-update] 应用异常退出，跳过安装:', 1);
    log.mockRestore();
  });

  it('logs an installer exception without throwing from quit', () => {
    const error = new Error('spawn failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    requestInstallerOnQuit(() => { throw error; });
    expect(() => mock.app.emit('quit', {}, 0)).not.toThrow();
    expect(log).toHaveBeenCalledWith('[auto-update] 安装器启动失败:', error);
    log.mockRestore();
  });
});
