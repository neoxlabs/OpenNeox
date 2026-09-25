/**
 * shellEnv —— Windows 分支。
 *
 * Windows 分支通过一次加载 `$PROFILE` 的 PowerShell 调用获取用户环境。执行工具使用
 * `-NoProfile`，因此启动阶段必须把 profile 中的 PATH 和工具变量合并到缓存环境。
 *
 * 这组用例在 Mac/Linux 上也能跑 —— mock 掉 execa + 伪造 platform, 只验分支行为。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execaMock = vi.fn();
const execaSyncMock = vi.fn();
vi.mock('execa', () => ({
  execa: (...args: unknown[]) => execaMock(...args),
  execaSync: (...args: unknown[]) => execaSyncMock(...args),
}));

const origPlatform = process.platform;
function setPlatform(p: string) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/* 每个用例都要一份全新的模块 (模块内有 cachedShellEnv 单例) */
async function freshModule() {
  vi.resetModules();
  return await import('../shellEnv.js');
}

beforeEach(() => {
  execaMock.mockReset();
  execaSyncMock.mockReset();
  setPlatform('win32');
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
});

describe('preloadShellEnv · Windows', () => {
  it('起 PowerShell 捞用户环境, 拿到的 PATH 覆盖进程自身的', async () => {
    execaMock.mockResolvedValue({
      stdout: 'Path=C:\\tools\\maven\\bin;C:\\nvm\\v20\\\nJAVA_HOME=C:\\jdk17\n',
    });
    const mod = await freshModule();
    await mod.preloadShellEnv();
    const env = mod.getShellEnv();
    expect(execaMock).toHaveBeenCalled();
    /* PowerShell 回来的键是 Path, 下游按 PATH 取 —— 必须补上, 否则等于没捞 */
    expect(env.PATH).toContain('maven');
    expect(env.JAVA_HOME).toBe('C:\\jdk17');
  });

  it('捞取失败时回落进程自身环境, 不抛错 (宁可少 PATH 也不能起不来)', async () => {
    execaMock.mockRejectedValue(new Error('powershell not found'));
    const mod = await freshModule();
    await expect(mod.preloadShellEnv()).resolves.toBeUndefined();
    const env = mod.getShellEnv();
    expect(env).toBeTruthy();
  });

  it('输出里没有 = 时视为无效, 回落自身环境', async () => {
    execaMock.mockResolvedValue({ stdout: '这不是环境变量输出\n' });
    const mod = await freshModule();
    await mod.preloadShellEnv();
    expect(mod.getShellEnv()).toBeTruthy();
  });

  it('pwsh 不在时退到 powershell.exe', async () => {
    execaMock
      .mockRejectedValueOnce(new Error('pwsh missing'))
      .mockResolvedValueOnce({ stdout: 'Path=C:\\fallback\n' });
    const mod = await freshModule();
    await mod.preloadShellEnv();
    expect(mod.getShellEnv().PATH).toContain('fallback');
    expect(execaMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
