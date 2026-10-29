
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { neoxHome } from '@neoxlabs/kernel/platform/neoxHome.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';
import { RateLimiter } from './dedupe.js';
import { CrashQueue } from './queue.js';
import { findNativeCrashReports, type NativeCrashInfo } from './ips.js';
import { clearRunMarker, detectAbnormalExits, writeRunMarker, type RunMarker } from './runMarker.js';
import { computeDedupeKey, normalizeStack, sanitizeText, truncateMessage } from './sanitize.js';
import { onDbInitFailure, type DbInitFailure } from '../dbInitFailure.js';
import type { CrashApp, CrashKind, CrashProcessRole, CrashReportPayload } from './types.js';

const API_PATH = '/api/v1/crash-reports';

export interface CrashReporterOptions {
  app: CrashApp;
  /** 进程角色 */
  process: CrashProcessRole;
  version: string;
  commit?: string;
  /** 覆盖 ~/.neox (测试用) */
  home?: string;
  /** 覆盖云端 api base; 缺省读 NEOX_API_BASE, 再缺省 https://neox-dev.com */
  apiBase?: string;
  /** 覆盖匿名安装 id; 缺省从 crash-report/install-id 读或生成 */
  installId?: string;
  userId?: string;
  /** 额外的开关 (通常是 config.crashReports !== false)。env / 测试实例的闸始终生效。 */
  isEnabled?: () => boolean;
  /** 注入 fetch (测试 mock) */
  fetchImpl?: typeof fetch;
  now?: () => number;
  startupRecovery?: boolean;
  /** 主进程: 写运行标记 (下次启动补报原生崩溃)。worker 必须传 false。默认 true。 */
  useRunMarker?: boolean;
  /** 是否注册进程级 uncaughtException/unhandledRejection。
   *  只有该进程本来就有监听者时才该开 —— 否则加监听会改变崩溃语义 (worker 会不再死)。
   *  默认 true (CLI / 桌面主进程本来就有)。 */
  installProcessHooks?: boolean;
  /** 本机 .ips 目录 (测试可换); 缺省 macOS 的 DiagnosticReports */
  diagnosticReportsDir?: string;
  /** 当前工作区路径 —— 栈里命中后只留最后一段 */
  workspaceDir?: string;
}

/**
 * 总开关。三道闸, 任何一道关掉都不报:
 *   1. NEOX_CRASH_REPORT=0 —— 显式关
 *   2. NEOX_HOME_DIRNAME 是非默认值 —— 测试 / E2E 实例
 *   3. NODE_ENV=test
 * extra() 用于再叠一层 config (设置页里的「发送崩溃报告」开关)。
 */
export function isCrashReportEnabled(extra?: () => boolean | undefined): boolean {
  if (process.env.NEOX_CRASH_REPORT === '0') return false;
  /* 没有官方服务的发行版 (开源版): 不往我们的服务器上报任何东西 */
  if (!DISTRIBUTION.officialServices) return false;
  const homeEnv = process.env.NEOX_HOME_DIRNAME?.trim();
  if (homeEnv && homeEnv !== '.neox') return false;
  if (process.env.NODE_ENV === 'test') return false;
  if (extra) {
    try {
      if (extra() === false) return false;
    } catch {
      /* 读配置失败 → 按开处理, 别因为一个读不到就把上报整体关掉 */
    }
  }
  return true;
}

/** 读或生成匿名安装 id (不是账号 id)。同机 CLI / 桌面共用一份。 */
export function readOrCreateInstallId(dir: string): string {
  const file = path.join(dir, 'install-id');
  try {
    const v = fs.readFileSync(file, 'utf-8').trim();
    if (v) return v;
  } catch {
    /* 首次 */
  }
  const id = randomUUID();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, id, 'utf-8');
  } catch {
    /* 写不进去也能用本次生成的 id */
  }
  return id;
}

/** 构建时注入的 commit (可选), 没有就不带。 */
declare const __NEOX_COMMIT__: string | undefined;
function readBuildCommit(): string | undefined {
  try {
    if (typeof __NEOX_COMMIT__ !== 'undefined' && __NEOX_COMMIT__) return __NEOX_COMMIT__;
  } catch {
    /* 未注入 */
  }
  const env = (process.env.NEOX_BUILD_COMMIT || process.env.NEOX_COMMIT || '').trim();
  return env ? env.slice(0, 40) : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    const s = JSON.stringify(error);
    return s ?? String(error);
  } catch {
    return String(error);
  }
}

export class CrashReporter {
  private readonly baseDir: string;
  private readonly queue: CrashQueue;
  private readonly rate: RateLimiter;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly installId: string;
  private dbHookInstalled = false;
  private processHooksInstalled = false;
  private markerFile: string | null = null;
  /** 正在跑的 flush (单飞) 与"期间又有新入队"标记 —— 见 flush()。 */
  private flushing: Promise<void> | null = null;
  private flushDirty = false;

  constructor(private readonly opts: CrashReporterOptions) {
    const home = opts.home ?? neoxHome();
    this.baseDir = path.join(home, 'crash-report');
    this.now = opts.now ?? Date.now;
    this.queue = new CrashQueue(path.join(this.baseDir, 'queue'), this.now);
    this.rate = new RateLimiter(path.join(this.baseDir, 'rate.json'), this.now);
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.installId = opts.installId ?? readOrCreateInstallId(this.baseDir);
  }

  private enabled(): boolean {
    return isCrashReportEnabled(this.opts.isEnabled);
  }

  private apiBase(): string {
    const base = this.opts.apiBase || process.env.NEOX_API_BASE || 'https://neox-dev.com';
    return base.replace(/\/+$/, '');
  }

  /** 组一条脱敏过的载荷。 */
  private buildReport(params: {
    kind: CrashKind;
    message: string;
    stack?: string;
    nativeFrames?: string[];
    exitCode?: number;
    signal?: string;
    role?: CrashProcessRole;
  }): CrashReportPayload {
    const scrub = { workspaceDir: this.opts.workspaceDir };
    const frames = params.kind === 'native'
      ? (params.nativeFrames ?? []).slice(0, 20)
      : normalizeStack(params.stack, scrub);
    const dedupeBasis = frames.length ? frames : [sanitizeText(params.message, scrub)];

    return {
      kind: params.kind,
      app: this.opts.app,
      version: this.opts.version,
      commit: this.opts.commit ?? readBuildCommit(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      process: params.role ?? this.opts.process,
      exitCode: params.exitCode,
      signal: params.signal,
      message: truncateMessage(sanitizeText(params.message, scrub)),
      stack: params.kind === 'native' ? undefined : frames,
      nativeFrames: params.kind === 'native' ? frames : undefined,
      dedupeKey: computeDedupeKey(params.kind, dedupeBasis),
      occurredAt: new Date(this.now()).toISOString(),
      installId: this.installId,
      userId: this.opts.userId,
    };
  }

  /** 限频 → 落盘 → 尝试发。所有崩溃类型的唯一入口。 */
  private capture(report: CrashReportPayload): void {
    if (!this.enabled()) return;
    try {
      if (!this.rate.shouldSend(report.dedupeKey)) return;
      this.rate.record(report.dedupeKey);
      this.queue.enqueue(report);
      void this.flush();
    } catch {
      /* 上报绝不能再抛 */
    }
  }

  /** 重发队列里的全部待发 (从旧到新, 一发失败就停, 留着下次)。
   *
   * 单飞: 崩溃可能在同一毫秒里来好几条 (循环崩溃), 每次 capture 都 fire-and-forget 一个 flush,
   * 并发 flush 会各自 list() 到同一批文件 → 同一条被 POST 多次。这里用一个在跑的 promise +
   * dirty 标记串起来: 有新的入队就把当前这轮跑完再跑一轮, 绝不并发。
   */
  flush(): Promise<void> {
    if (this.flushing) {
      this.flushDirty = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.flushDirty = false;
          if (!this.enabled()) return;
          for (const item of this.queue.list()) {
            const done = await this.send(item.report);
            if (done) this.queue.remove(item.file);
            else return;
          }
        } while (this.flushDirty);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  private async send(report: CrashReportPayload): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.apiBase()}${API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(8000)
          : undefined,
      });
      if (res.ok) return true;
      /* 4xx (除 408/429) = 服务端明确不收这条, 重发也没用 → 当已处理丢弃, 别堵住后面的队列 */
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return true;
      return false;
    } catch {
      return false;
    }
  }

  /** JS 层崩溃。 */
  reportJs(error: unknown, extra?: { role?: CrashProcessRole; exitCode?: number; signal?: string }): void {
    const stack = error instanceof Error
      ? error.stack
      : (typeof (error as { stack?: unknown } | null)?.stack === 'string' ? (error as { stack: string }).stack : undefined);
    this.capture(this.buildReport({
      kind: 'js',
      message: errorMessage(error),
      stack,
      exitCode: extra?.exitCode,
      signal: extra?.signal,
      role: extra?.role,
    }));
  }

  /** 原生崩溃 (从运行标记 / .ips 推出来的)。 */
  reportNative(params: { message: string; signal?: string; nativeFrames?: string[]; exitCode?: number; role?: CrashProcessRole }): void {
    this.capture(this.buildReport({
      kind: 'native',
      message: params.message,
      nativeFrames: params.nativeFrames,
      signal: params.signal,
      exitCode: params.exitCode,
      role: params.role,
    }));
  }

  reportHang(params: { message: string; stack?: string; durationMs: number; role?: CrashProcessRole }): void {
    /* 时长只写到档位: 没有栈时去重靠 message, 写精确毫秒会让每条都算新的, 限频就失效了 */
    const ms = params.durationMs;
    const bucket = ms >= 10_000 ? '≥10s' : ms >= 5_000 ? '5-10s' : ms >= 3_000 ? '3-5s' : '1-3s';
    this.capture(this.buildReport({
      kind: 'hang',
      message: `${params.message} · 卡顿 ${bucket}`,
      stack: params.stack,
      role: params.role,
    }));
  }

  /**
   * runtime 隔离子进程 (NEOX_RUNTIME_ISOLATION=process) 异常退出 —— 父进程侧检测。
   *
   * 子进程 abort / segfault 时父进程拿得到 code 和 signal, 但拿不到栈: 栈在系统的 .ips 里,
   * 而且系统写完有 1~3s 延迟。所以先等一小会儿再找, 找不到就只报 signal (有信号/非 0 退出
   * 本身已经足够定位是哪一档)。等 .ips 的定时器 unref, 不拖住父进程退出。
   *
   * 主动关闭由调用方排除 (见 core 的 isAbnormalRuntimeExit), 这里不再判断。
   */
  reportRuntimeProcessExit(params: {
    exitCode?: number;
    signal?: string | null;
    /** 子进程启动时刻 (ms) —— 只找这之后产生的 .ips */
    since: number;
    /** 等 .ips 落盘的延迟, 默认 2000ms; 测试传 0 */
    ipsDelayMs?: number;
  }): void {
    const fire = () => {
      try {
        if (!this.enabled()) return;
        const ips = this.findIpsSince(params.since);
        const signal = params.signal ?? ips?.signal;
        /* 被信号带走时 waitpid 的 code 是 0, 记成 exitCode:0 会误导 —— 只留 signal */
        const exitCode = signal && (params.exitCode ?? 0) === 0 ? undefined : params.exitCode;
        const detail = [
          signal ? `signal=${signal}` : '',
          exitCode !== undefined ? `exitCode=${exitCode}` : '',
        ].filter(Boolean).join(', ');
        this.capture(this.buildReport({
          kind: 'native',
          message: `runtime 子进程异常退出${detail ? ` (${detail})` : ''}`,
          nativeFrames: ips?.frames,
          signal: signal ?? undefined,
          exitCode,
          role: 'process',
        }));
      } catch {
        /* 上报绝不能再抛 */
      }
    };
    try {
      const delay = Math.max(0, params.ipsDelayMs ?? 2000);
      if (delay === 0) { fire(); return; }
      const timer = setTimeout(fire, delay);
      /* 别为了等 .ips 拖住父进程退出 */
      if (typeof timer.unref === 'function') timer.unref();
    } catch {
      /* ignore */
    }
  }

  /** 会话库打不开 / 损坏恢复。 */
  reportDbFailure(failure: DbInitFailure): void {
    this.capture(this.buildReport({
      kind: 'db',
      message: `会话库无法打开: ${failure.message}`,
    }));
  }

  /** 订阅 dbInitFailure (不碰进程级 handler, worker 也能装)。 */
  installDbHook(): void {
    if (this.dbHookInstalled) return;
    this.dbHookInstalled = true;
    try {
      onDbInitFailure((failure) => {
        try {
          this.reportDbFailure(failure);
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
  }

  /** 注册进程级 uncaughtException / unhandledRejection。只在本来就有监听者的进程里用。 */
  installProcessHooks(): void {
    if (this.processHooksInstalled) return;
    this.processHooksInstalled = true;
    process.on('uncaughtException', (error: Error) => {
      try {
        this.reportJs(error, { exitCode: 1 });
      } catch {
        /* ignore */
      }
    });
    process.on('unhandledRejection', (reason: unknown) => {
      try {
        this.reportJs(reason);
      } catch {
        /* ignore */
      }
    });
  }

  async runStartupRecovery(): Promise<void> {
    if (!this.enabled()) return;
    try {
      this.recoverAbnormalExits();
    } catch {
      /* ignore */
    }
    if (this.opts.useRunMarker !== false) this.armRunMarker();
    await this.flush();
  }

  private recoverAbnormalExits(): void {
    for (const { file, marker } of detectAbnormalExits(this.baseDir)) {
      try {
        const ips = this.findIpsFor(marker);
        if (!ips) continue;
        const role = (marker.process || this.opts.process) as CrashProcessRole;
        this.capture(this.buildReport({
          kind: 'native',
          message: `进程异常退出 (pid ${marker.pid}, signal=${ips.signal ?? 'unknown'})`,
          nativeFrames: ips.frames,
          signal: ips.signal,
          role,
        }));
      } catch {
        /* 单条失败不影响其它标记 */
      } finally {
        clearRunMarker(file);
      }
    }
  }

  private findIpsFor(marker: RunMarker): NativeCrashInfo | null {
    return this.findIpsSince(marker.startedAt - 5_000);
  }

  /** 找 since 之后产生的原生崩溃报告 (不看是哪个进程写的 —— 调用方自己给准窗口)。 */
  private findIpsSince(since: number): NativeCrashInfo | null {
    if (process.platform !== 'darwin' && !this.opts.diagnosticReportsDir) return null;
    try {
      const list = findNativeCrashReports({
        dir: this.opts.diagnosticReportsDir,
        since,
        procNames: ['node', 'Neox', 'Electron'],
      });
      return list[0] ?? null;
    } catch {
      return null;
    }
  }

  private armRunMarker(): void {
    this.markerFile = writeRunMarker(this.baseDir, {
      pid: process.pid,
      startedAt: this.now(),
      app: this.opts.app,
      version: this.opts.version,
      process: this.opts.process,
    });
    process.on('exit', () => clearRunMarker(this.markerFile));
  }
}

let _current: CrashReporter | null = null;

/**
 * 装一个崩溃上报器并注册为当前进程的全局实例。
 *
 * 只装 db hook (安全, 不改任何崩溃语义) + 按需装进程级 hook。
 * startupRecovery 由宿主自己决定什么时候跑 (CLI/桌面主进程在启动早期调)。
 */
export function installCrashReporter(opts: CrashReporterOptions): CrashReporter {
  const reporter = new CrashReporter(opts);
  _current = reporter;
  reporter.installDbHook();
  if (opts.installProcessHooks !== false) reporter.installProcessHooks();
  return reporter;
}

/** 拿当前进程的崩溃上报器 (worker 侧上报 worker 崩溃时用)。 */
export function getCrashReporter(): CrashReporter | null {
  return _current;
}
