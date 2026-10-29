import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  applyTerminalSizeFallback,
  installTerminalSizeGuard,
  resolveTerminalSize,
  restoreTerminalSizeGuard,
  type TerminalSize,
} from '../terminalSize.js';

/**
 * 自动化 pty 不设 winsize 时 isTTY=true 但 rows/columns 都是 0。
 * 这里用原型 getter 模拟真实的 process.stdout (getter 在原型上, 允许被 own property 覆盖)。
 */
class FakeStdout extends EventEmitter {
  isTTY = true;
  private state: { rows?: number; columns?: number };

  constructor(rows?: number, columns?: number) {
    super();
    this.state = { rows, columns };
  }

  get rows(): number | undefined {
    return this.state.rows;
  }

  get columns(): number | undefined {
    return this.state.columns;
  }

  setSize(rows?: number, columns?: number): void {
    this.state = { rows, columns };
  }

  write(): boolean {
    return true;
  }
}

const stty = (rows: number, columns: number) => () => ({ rows, columns } as TerminalSize);

describe('resolveTerminalSize', () => {
  it('rows/columns 都正常时原样返回, 不查 stty', () => {
    const queryStty = vi.fn(stty(50, 181));
    const result = resolveTerminalSize({ rows: 54, columns: 181 }, {}, queryStty);
    expect(result.size).toEqual({ rows: 54, columns: 181 });
    expect(result.recovered).toBe(false);
    expect(queryStty).not.toHaveBeenCalled();
  });

  it('rows=0 / columns=0 时回退 stty size', () => {
    const result = resolveTerminalSize({ rows: 0, columns: 0 }, {}, stty(50, 181));
    expect(result.size).toEqual({ rows: 50, columns: 181 });
    expect(result.sources).toEqual({ rows: 'stty', columns: 'stty' });
    expect(result.recovered).toBe(true);
  });

  it('rows 缺失 (undefined) 时依次回退 stty → 环境变量', () => {
    const fromStty = resolveTerminalSize({ rows: undefined, columns: 120 }, {}, stty(40, 100));
    expect(fromStty.size).toEqual({ rows: 40, columns: 120 });
    expect(fromStty.sources).toEqual({ rows: 'stty', columns: 'stdout' });

    const fromEnv = resolveTerminalSize({ rows: undefined, columns: 120 }, { LINES: '36' }, () => null);
    expect(fromEnv.size).toEqual({ rows: 36, columns: 120 });
    expect(fromEnv.sources.rows).toBe('env');
  });

  it('stty 也拿不到时用 LINES/COLUMNS', () => {
    const result = resolveTerminalSize({ rows: 0, columns: 0 }, { LINES: '40', COLUMNS: '132' }, () => null);
    expect(result.size).toEqual({ rows: 40, columns: 132 });
    expect(result.sources).toEqual({ rows: 'env', columns: 'env' });
  });

  it('全都拿不到时用默认 24x80', () => {
    const result = resolveTerminalSize({ rows: 0, columns: 0 }, {}, () => null);
    expect(result.size).toEqual({ rows: 24, columns: 80 });
    expect(result.sources).toEqual({ rows: 'default', columns: 'default' });
  });

  it('stty 返回 0 0 (pty 没设 winsize) 时按拿不到处理', () => {
    const result = resolveTerminalSize({ rows: 0, columns: 0 }, {}, stty(0, 0));
    expect(result.size).toEqual({ rows: 24, columns: 80 });
    expect(result.sources).toEqual({ rows: 'default', columns: 'default' });
  });

  it('只补缺失的维度, 正常维度不被 stty/环境变量覆盖', () => {
    const result = resolveTerminalSize({ rows: 0, columns: 181 }, { COLUMNS: '100' }, stty(50, 100));
    expect(result.size).toEqual({ rows: 50, columns: 181 });
    expect(result.sources).toEqual({ rows: 'stty', columns: 'stdout' });
  });
});

describe('applyTerminalSizeFallback', () => {
  it('正常尺寸: 不覆盖 stdout, 不 WARN', () => {
    const stdout = new FakeStdout(54, 181);
    const warn = vi.fn();
    const queryStty = vi.fn(stty(50, 181));
    const guard = applyTerminalSizeFallback({
      stdout: stdout as unknown as NodeJS.WriteStream,
      env: {},
      queryStty,
      warn,
    });

    expect(guard.recovered).toBe(false);
    expect(stdout.rows).toBe(54);
    expect(stdout.columns).toBe(181);
    expect(queryStty).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(Object.hasOwn(stdout, 'rows')).toBe(false);

    guard.restore();
    expect(stdout.rows).toBe(54);
    expect(stdout.columns).toBe(181);
  });

  it('rows=0/columns=0: 覆盖成 stty 尺寸并 WARN (报告修正前的值)', () => {
    const stdout = new FakeStdout(0, 0);
    const warn = vi.fn();
    const guard = applyTerminalSizeFallback({
      stdout: stdout as unknown as NodeJS.WriteStream,
      env: {},
      queryStty: stty(50, 181),
      warn,
    });

    expect(guard.recovered).toBe(true);
    expect(guard.size).toEqual({ rows: 50, columns: 181 });
    expect(stdout.rows).toBe(50);
    expect(stdout.columns).toBe(181);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('rows=0');
    expect(warn.mock.calls[0][0]).toContain('columns=0');
    expect(warn.mock.calls[0][0]).toContain('181x50');
    expect(warn.mock.calls[0][0]).toContain('stty');

    guard.restore();
    expect(stdout.rows).toBe(0);
    expect(stdout.columns).toBe(0);
  });

  it('rows 缺失时用环境变量兜底, columns 保持真实值', () => {
    const stdout = new FakeStdout(undefined, 150);
    const warn = vi.fn();
    const guard = applyTerminalSizeFallback({
      stdout: stdout as unknown as NodeJS.WriteStream,
      env: { LINES: '40' },
      queryStty: () => null,
      warn,
    });

    expect(stdout.rows).toBe(40);
    expect(stdout.columns).toBe(150);
    expect(warn.mock.calls[0][0]).toContain('环境变量');

    guard.restore();
    expect(stdout.rows).toBeUndefined();
    expect(stdout.columns).toBe(150);
  });

  it('resize 从 0 变正常: 撤掉兜底并回调 onRecovered 重画', () => {
    const stdout = new FakeStdout(0, 0);
    const onRecovered = vi.fn();
    const guard = applyTerminalSizeFallback({
      stdout: stdout as unknown as NodeJS.WriteStream,
      env: {},
      queryStty: () => null,
      warn: () => {},
      onRecovered,
    });

    expect(stdout.rows).toBe(24);
    expect(stdout.columns).toBe(80);

    stdout.setSize(54, 181);
    stdout.emit('resize');

    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(onRecovered).toHaveBeenCalledWith({ rows: 54, columns: 181 });
    expect(stdout.rows).toBe(54);
    expect(stdout.columns).toBe(181);
    expect(guard.recovered).toBe(false);
    expect(guard.size).toEqual({ rows: 54, columns: 181 });

    /* 再 resize 一次不应重复触发重画 */
    stdout.emit('resize');
    expect(onRecovered).toHaveBeenCalledTimes(1);

    guard.restore();
  });

  it('resize 后仍然是 0: 不重画, 继续保留兜底值', () => {
    const stdout = new FakeStdout(0, 0);
    const onRecovered = vi.fn();
    const guard = applyTerminalSizeFallback({
      stdout: stdout as unknown as NodeJS.WriteStream,
      env: { LINES: '30', COLUMNS: '100' },
      queryStty: () => null,
      warn: () => {},
      onRecovered,
    });

    expect(stdout.rows).toBe(30);
    stdout.setSize(0, 0);
    stdout.emit('resize');

    expect(onRecovered).not.toHaveBeenCalled();
    expect(stdout.rows).toBe(30);
    expect(stdout.columns).toBe(100);

    guard.restore();
  });

  it('restore 之后不再响应 resize', () => {
    const stdout = new FakeStdout(0, 0);
    const onRecovered = vi.fn();
    const warn = vi.fn();
    const guard = applyTerminalSizeFallback({
      stdout: stdout as unknown as NodeJS.WriteStream,
      env: {},
      queryStty: () => null,
      warn,
      onRecovered,
    });

    guard.restore();
    expect(stdout.listenerCount('resize')).toBe(0);
    expect(stdout.rows).toBe(0);

    stdout.setSize(54, 181);
    stdout.emit('resize');
    expect(onRecovered).not.toHaveBeenCalled();
  });
});

describe('installTerminalSizeGuard / restoreTerminalSizeGuard', () => {
  it('重复安装时先撤掉上一份, restore 后彻底清掉覆盖值', () => {
    const first = new FakeStdout(0, 0);
    installTerminalSizeGuard({
      stdout: first as unknown as NodeJS.WriteStream,
      env: {},
      queryStty: () => null,
      warn: () => {},
    });
    expect(first.rows).toBe(24);
    expect(first.listenerCount('resize')).toBe(1);

    const second = new FakeStdout(0, 0);
    installTerminalSizeGuard({
      stdout: second as unknown as NodeJS.WriteStream,
      env: {},
      queryStty: () => null,
      warn: () => {},
    });
    /* 上一份已被撤掉, 不会留下监听/覆盖值 */
    expect(first.rows).toBe(0);
    expect(first.listenerCount('resize')).toBe(0);
    expect(second.rows).toBe(24);

    restoreTerminalSizeGuard();
    expect(second.rows).toBe(0);
    expect(second.listenerCount('resize')).toBe(0);
  });
});
