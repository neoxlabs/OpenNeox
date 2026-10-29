
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

export interface TerminalSize {
  columns: number;
  rows: number;
}

export type SizeSource = 'stdout' | 'stty' | 'env' | 'default';

export interface SizeResolution {
  size: TerminalSize;
  sources: { columns: SizeSource; rows: SizeSource };
  /** 至少一个维度用了兜底 */
  recovered: boolean;
}

export interface TerminalSizeOptions {
  /** 默认 process.stdout */
  stdout?: NodeJS.WriteStream;
  /** 默认 process.env */
  env?: NodeJS.ProcessEnv;
  /** 读 `stty size`; 返回 null 表示当前环境拿不到。测试注入用。 */
  queryStty?: () => TerminalSize | null;
  /** 默认走 cliLogger.warn('INK_SIZE', ...) */
  warn?: (message: string) => void;
  /** 尺寸从 0/缺失恢复成正常时调用 (调用方在这里重画) */
  onRecovered?: (size: TerminalSize) => void;
}

export interface TerminalSizeGuard {
  size: TerminalSize;
  /** 是否用了兜底值 (恢复到真实尺寸后变 false) */
  recovered: boolean;
  /** 撤掉覆盖值 + 移除 resize 监听 */
  restore(): void;
}

const DEFAULT_SIZE: TerminalSize = { columns: 80, rows: 24 };

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * `stty size` 输出两列: `rows columns`。
 * pty 没设 winsize 时它输出 `0 0`, 这种值按"拿不到"处理, 继续往下一级回退。
 */
export function readSttySize(): TerminalSize | null {
  try {
    const out = execFileSync('stty', ['size'], {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'ignore'],
      timeout: 500,
    });
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(out);
    if (!match) return null;
    const rows = positiveInt(match[1]);
    const columns = positiveInt(match[2]);
    return rows && columns ? { rows, columns } : null;
  } catch {
    return null;
  }
}

/**
 * 按 真实值 → stty → 环境变量 → 默认值 的顺序解析尺寸。
 * 只对缺失/为 0 的维度走后面的来源, 正常维度不会被 stty/环境变量覆盖。
 */
export function resolveTerminalSize(
  stdout: Pick<NodeJS.WriteStream, 'rows' | 'columns'> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  queryStty: () => TerminalSize | null = readSttySize,
): SizeResolution {
  let rows = positiveInt(stdout?.rows);
  let columns = positiveInt(stdout?.columns);
  const sources: SizeResolution['sources'] = {
    rows: rows ? 'stdout' : 'default',
    columns: columns ? 'stdout' : 'default',
  };

  if (!rows || !columns) {
    const stty = queryStty();
    if (!rows) {
      const value = positiveInt(stty?.rows);
      if (value) {
        rows = value;
        sources.rows = 'stty';
      }
    }
    if (!columns) {
      const value = positiveInt(stty?.columns);
      if (value) {
        columns = value;
        sources.columns = 'stty';
      }
    }
  }

  if (!rows) {
    const value = positiveInt(env.LINES);
    if (value) {
      rows = value;
      sources.rows = 'env';
    }
  }
  if (!columns) {
    const value = positiveInt(env.COLUMNS);
    if (value) {
      columns = value;
      sources.columns = 'env';
    }
  }

  if (!rows) rows = DEFAULT_SIZE.rows;
  if (!columns) columns = DEFAULT_SIZE.columns;

  return {
    size: { columns, rows },
    sources,
    recovered: sources.columns !== 'stdout' || sources.rows !== 'stdout',
  };
}

type Dimension = 'rows' | 'columns';

interface PatchedDimension {
  hadOwn: boolean;
  descriptor?: PropertyDescriptor;
}

function sourceLabel(source: SizeSource): string {
  switch (source) {
    case 'stty': return 'stty';
    case 'env': return '环境变量';
    case 'default': return '默认值';
    default: return 'stdout';
  }
}

/**
 * 原地修正 `stdout.rows/columns`, 让 Ink 适配层和 apps/cli 里直接读
 * `process.stdout.rows` 的组件都拿到可用值。返回值负责撤销与 resize 监听。
 */
export function applyTerminalSizeFallback(options: TerminalSizeOptions = {}): TerminalSizeGuard {
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const queryStty = options.queryStty ?? readSttySize;
  const warn = options.warn ?? ((message: string) => cliLogger.warn('INK_SIZE', message));

  let resolution = resolveTerminalSize(stdout, env, queryStty);
  /* WARN 要报"修正前"的值, 所以先记下来 */
  const rawBefore = { rows: stdout.rows, columns: stdout.columns };
  const patched = new Map<Dimension, PatchedDimension>();
  let recoveredNotified = false;

  const patch = (key: Dimension, value: number): void => {
    if (!patched.has(key)) {
      patched.set(key, {
        hadOwn: Object.hasOwn(stdout, key),
        descriptor: Object.getOwnPropertyDescriptor(stdout, key),
      });
    }
    Object.defineProperty(stdout, key, {
      value,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  };

  const unpatch = (key: Dimension): void => {
    const entry = patched.get(key);
    if (!entry) return;
    patched.delete(key);
    if (entry.hadOwn && entry.descriptor) {
      Object.defineProperty(stdout, key, entry.descriptor);
    } else {
      delete (stdout as unknown as Record<Dimension, unknown>)[key];
    }
  };

  const unpatchAll = (): void => {
    for (const key of [...patched.keys()]) unpatch(key);
  };

  const applyResolution = (): void => {
    if (resolution.sources.rows === 'stdout') unpatch('rows');
    else patch('rows', resolution.size.rows);
    if (resolution.sources.columns === 'stdout') unpatch('columns');
    else patch('columns', resolution.size.columns);
  };

  if (!resolution.recovered) {
    return { size: resolution.size, recovered: false, restore() {} };
  }

  applyResolution();
  warn(
    `终端尺寸不可用 (rows=${String(rawBefore.rows)}, columns=${String(rawBefore.columns)}), ` +
    `回退 ${resolution.size.columns}x${resolution.size.rows} ` +
    `(rows=${sourceLabel(resolution.sources.rows)}, columns=${sourceLabel(resolution.sources.columns)})`,
  );

  const onResize = (): void => {
    /* 先撤掉覆盖值, 读终端此刻的真实尺寸 */
    unpatchAll();
    const rawRows = positiveInt(stdout.rows);
    const rawColumns = positiveInt(stdout.columns);

    if (rawRows && rawColumns) {
      resolution = {
        size: { rows: rawRows, columns: rawColumns },
        sources: { rows: 'stdout', columns: 'stdout' },
        recovered: false,
      };
      if (!recoveredNotified) {
        recoveredNotified = true;
        options.onRecovered?.({ rows: rawRows, columns: rawColumns });
      }
      return;
    }

    /* 仍然是 0: 重新跑一遍回退链 (stty 可能在 resize 后才可用) */
    resolution = resolveTerminalSize(stdout, env, queryStty);
    applyResolution();
  };

  if (typeof stdout.on === 'function') {
    stdout.on('resize', onResize);
  }

  return {
    get size() {
      return resolution.size;
    },
    get recovered() {
      return resolution.recovered;
    },
    restore() {
      if (typeof stdout.off === 'function') {
        stdout.off('resize', onResize);
      }
      unpatchAll();
    },
  };
}

/* ── 单例接线 (InkRuntime 只加 import/安装/恢复三行, 不往两千多行的文件里堆) ── */

let installedGuard: TerminalSizeGuard | null = null;

export function installTerminalSizeGuard(options: TerminalSizeOptions = {}): TerminalSizeGuard {
  installedGuard?.restore();
  installedGuard = applyTerminalSizeFallback(options);
  return installedGuard;
}

export function restoreTerminalSizeGuard(): void {
  installedGuard?.restore();
  installedGuard = null;
}
