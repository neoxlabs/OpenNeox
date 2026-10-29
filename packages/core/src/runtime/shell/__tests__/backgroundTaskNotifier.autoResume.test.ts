/**
 * A process the agent or the user stopped on purpose must not wake a new turn.
 *
 * Found in a CLI trial: the agent restarted its dev server with bash_kill, and the exit of the
 * process it had just killed started a paid turn whose whole output was "that was the process
 * I stopped, ignore it". The notification still reaches the agent with the next real message.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  BackgroundTaskNotifier,
  __resetBackgroundTaskNotifierForTest,
  setBgTaskAutoResumeHandler,
  setBgTaskSessionActiveCheck,
} from '../backgroundTaskNotifier.js';
import type { ProcessManager, TrackedProcess } from '@neoxlabs/platform/platform/processManager.js';

const proc = (pid: number, status: TrackedProcess['status'], terminatedBy?: 'user' | 'agent' | 'system') => ({
  pid, command: `cmd-${pid}`, cwd: '/tmp', startTime: new Date(), status, exitCode: 0,
  endTime: new Date(), background: true, outputBuffer: [], terminatedBy,
}) as unknown as TrackedProcess;

describe('background exit auto-resume', () => {
  let resume: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    __resetBackgroundTaskNotifierForTest();
    vi.useFakeTimers();
    resume = vi.fn(async () => {});
    setBgTaskAutoResumeHandler(resume);
    setBgTaskSessionActiveCheck(() => false);
  });
  afterEach(() => {
    setBgTaskAutoResumeHandler(null);
    setBgTaskSessionActiveCheck(null);
    vi.useRealTimers();
  });

  const run = async (terminatedBy: 'user' | 'agent' | 'system' | undefined, status: TrackedProcess['status']) => {
    const pm = new EventEmitter() as unknown as ProcessManager;
    const n = new BackgroundTaskNotifier();
    n.attach(pm);
    n.enterSession('s1');
    n.trackPid(11, 'npm run dev');
    (pm as unknown as EventEmitter).emit(status === 'killed' ? 'process:kill' : 'process:exit', proc(11, status, terminatedBy));
    await vi.advanceTimersByTimeAsync(5_000);
    return n;
  };

  it('does not wake a turn for a process the agent killed, but keeps the note', async () => {
    const n = await run('agent', 'killed');
    expect(resume).not.toHaveBeenCalled();
    expect(n.hasNotificationsFor('s1')).toBe(true);
  });

  it('does not wake a turn for a process the user stopped', async () => {
    await run('user', 'killed');
    expect(resume).not.toHaveBeenCalled();
  });

  it('still wakes a turn when a process ends on its own', async () => {
    await run(undefined, 'completed');
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
