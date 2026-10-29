
import { describe, it, expect, vi } from 'vitest';
import {
  describeChildProcessGone,
  describeRenderProcessGone,
  installProcessGoneReporting,
  type ProcessGoneReason,
} from '../bootstrap/processGoneReporting.js';

const ALL_REASONS: ProcessGoneReason[] = [
  'clean-exit',
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'memory-eviction',
];

function makeApp() {
  const handlers = new Map<string, (...args: any[]) => void>();
  const app = {
    on(event: string, listener: (...args: any[]) => void) {
      handlers.set(event, listener);
      return app;
    },
    emit(event: string, ...args: any[]) {
      handlers.get(event)?.(...args);
    },
  };
  return app;
}

function makeReporter() {
  return { reportNative: vi.fn() } as any;
}

const silentLogger = { error: () => { /* 测试里不外溢 */ } };

describe('render-process-gone', () => {
  it.each(ALL_REASONS)('reason=%s 的处理', (reason) => {
    const crash = describeRenderProcessGone({ reason, exitCode: -1 });
    if (reason === 'clean-exit') {
      expect(crash).toBeNull();
      return;
    }
    expect(crash).not.toBeNull();
    expect(crash!.role).toBe('renderer');
    expect(crash!.exitCode).toBe(-1);
    expect(crash!.message).toContain(`reason=${reason}`);
    expect(crash!.message).toContain('exitCode=-1');
  });

  it('app 事件 → 上报 kind 对应字段 (role/message/exitCode)', () => {
    const app = makeApp();
    const reporter = makeReporter();
    installProcessGoneReporting(app, reporter, silentLogger);

    app.emit('render-process-gone', {}, {}, { reason: 'oom', exitCode: -536870904 });

    expect(reporter.reportNative).toHaveBeenCalledTimes(1);
    const arg = reporter.reportNative.mock.calls[0][0];
    expect(arg.role).toBe('renderer');
    expect(arg.exitCode).toBe(-536870904);
    expect(arg.message).toContain('reason=oom');
  });

  it('clean-exit (关窗 / reload) 不报', () => {
    const app = makeApp();
    const reporter = makeReporter();
    installProcessGoneReporting(app, reporter, silentLogger);

    app.emit('render-process-gone', {}, {}, { reason: 'clean-exit', exitCode: 0 });

    expect(reporter.reportNative).not.toHaveBeenCalled();
  });
});

describe('child-process-gone', () => {
  it('GPU 进程 → role:gpu', () => {
    const app = makeApp();
    const reporter = makeReporter();
    installProcessGoneReporting(app, reporter, silentLogger);

    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 139 });

    expect(reporter.reportNative).toHaveBeenCalledTimes(1);
    const arg = reporter.reportNative.mock.calls[0][0];
    expect(arg.role).toBe('gpu');
    expect(arg.exitCode).toBe(139);
    expect(arg.message).toContain('GPU 进程异常退出');
    expect(arg.message).toContain('reason=crashed');
  });

  it('Utility 进程 → role:utility, 消息带进程名', () => {
    const app = makeApp();
    const reporter = makeReporter();
    installProcessGoneReporting(app, reporter, silentLogger);

    app.emit('child-process-gone', {}, {
      type: 'Utility',
      reason: 'abnormal-exit',
      exitCode: 1,
      name: 'Audio Service',
    });

    expect(reporter.reportNative).toHaveBeenCalledTimes(1);
    const arg = reporter.reportNative.mock.calls[0][0];
    expect(arg.role).toBe('utility');
    expect(arg.message).toContain('Utility 进程异常退出');
    expect(arg.message).toContain('Audio Service');
  });

  it('clean-exit 不报', () => {
    const app = makeApp();
    const reporter = makeReporter();
    installProcessGoneReporting(app, reporter, silentLogger);

    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'clean-exit', exitCode: 0 });

    expect(reporter.reportNative).not.toHaveBeenCalled();
  });

  it('非 GPU / Utility (Zygote / Sandbox helper 等) 不报', () => {
    for (const type of ['Zygote', 'Sandbox helper', 'Pepper Plugin', 'Unknown'] as const) {
      expect(describeChildProcessGone({ type, reason: 'crashed', exitCode: 1 })).toBeNull();
    }
  });
});
