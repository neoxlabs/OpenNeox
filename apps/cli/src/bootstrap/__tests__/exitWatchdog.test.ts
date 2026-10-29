import { describe, expect, it } from 'vitest';
import { windowsDelayedKillCommand } from '../../utils/exitWatchdog.js';

describe('windowsDelayedKillCommand', () => {
  it('不再使用 timeout (stdio:ignore 下会立刻报错退出, 延时失效)', () => {
    const cmd = windowsDelayedKillCommand(1234, 1);
    expect(cmd).not.toMatch(/\btimeout\b/);
  });

  it('用 ping 做延时 (不读 stdin, 重定向下也能等)', () => {
    const cmd = windowsDelayedKillCommand(1234, 1);
    expect(cmd).toMatch(/ping -n \d+ 127\.0\.0\.1/);
  });

  it('精确强杀传进来的 pid', () => {
    expect(windowsDelayedKillCommand(4321, 1)).toContain('taskkill /f /pid 4321');
  });

  it('延时秒数换算成 ping 次数 (n 个包 ≈ n-1 秒)', () => {
    expect(windowsDelayedKillCommand(1, 1)).toMatch(/ping -n 2 /);
    expect(windowsDelayedKillCommand(1, 3)).toMatch(/ping -n 4 /);
  });

  it('延时下限 2 个包 —— 1 个包等于不等待', () => {
    expect(windowsDelayedKillCommand(1, 0)).toMatch(/ping -n 2 /);
    expect(windowsDelayedKillCommand(1, -5)).toMatch(/ping -n 2 /);
  });
});
