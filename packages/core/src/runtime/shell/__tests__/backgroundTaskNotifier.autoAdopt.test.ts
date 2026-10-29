import { describe, expect, it, vi } from 'vitest';
import { BackgroundTaskNotifier } from '../backgroundTaskNotifier.js';

/* 前台跑久了自动让位到后台的命令: 这一轮用户点停止要一起停; 正常做完转正, 之后的停止不碰它 */
describe('BackgroundTaskNotifier auto-adopted commands', () => {
  function setup() {
    const n = new BackgroundTaskNotifier();
    const killProcessGroup = vi.fn(() => true);
    n.attach({ on: vi.fn(), killProcessGroup } as any);
    return { n, killProcessGroup };
  }

  it('user interrupt kills this turn’s auto-backgrounded commands only', () => {
    const { n, killProcessGroup } = setup();
    n.runWithSession('s1', () => {
      n.trackPid(101, 'sleep 90');
      n.markAutoAdopted(101);
      n.trackPid(102, 'npm run dev'); /* agent 主动起的后台服务: 不标 */
    });
    expect(n.killAutoAdoptedForSession('s1')).toEqual([101]);
    expect(killProcessGroup).toHaveBeenCalledWith(101, 'SIGTERM', 'user');
    expect(killProcessGroup).not.toHaveBeenCalledWith(102, expect.anything(), expect.anything());
  });

  it('leaves a port-listening service alone even if it was started this turn', () => {
    const n = new BackgroundTaskNotifier();
    const killProcessGroup = vi.fn(() => true);
    n.attach({ on: vi.fn(), killProcessGroup, get: (pid: number) => (pid === 402 ? { port: 5173 } : { status: 'running' }) } as any);
    n.runWithSession('s1', () => {
      n.trackPid(401, 'sleep 66'); n.markAutoAdopted(401);
      n.trackPid(402, 'npm run dev'); n.markAutoAdopted(402);
    });
    expect(n.killAutoAdoptedForSession('s1')).toEqual([401]);
    expect(killProcessGroup).not.toHaveBeenCalledWith(402, expect.anything(), expect.anything());
  });

  it('a normally finished turn settles them, so a later stop leaves them alone', () => {
    const { n, killProcessGroup } = setup();
    n.runWithSession('s1', () => { n.trackPid(201, 'make build'); n.markAutoAdopted(201); });
    n.settleAutoAdoptedForSession('s1');
    expect(n.killAutoAdoptedForSession('s1')).toEqual([]);
    expect(killProcessGroup).not.toHaveBeenCalled();
  });

  it('does not touch another session’s commands', () => {
    const { n } = setup();
    n.runWithSession('s2', () => { n.trackPid(301, 'sleep 50'); n.markAutoAdopted(301); });
    expect(n.killAutoAdoptedForSession('s1')).toEqual([]);
    expect(n.killAutoAdoptedForSession('s2')).toEqual([301]);
  });
});
