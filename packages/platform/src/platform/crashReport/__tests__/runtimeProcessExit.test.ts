
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrashReporter } from '../reporter.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IPS_FIXTURE = path.join(HERE, 'fixtures', 'node-abort-sample.ips');

let home: string;
let diagDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-crash-child-'));
  diagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-crash-diag-'));
  savedEnv.NODE_ENV = process.env.NODE_ENV;
  savedEnv.NEOX_HOME_DIRNAME = process.env.NEOX_HOME_DIRNAME;
  savedEnv.NEOX_CRASH_REPORT = process.env.NEOX_CRASH_REPORT;
  savedEnv.NEOX_API_BASE = process.env.NEOX_API_BASE;
  process.env.NODE_ENV = 'production';
  delete process.env.NEOX_HOME_DIRNAME;
  delete process.env.NEOX_CRASH_REPORT;
  delete process.env.NEOX_API_BASE;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function makeReporter(overrides: Record<string, unknown> = {}): CrashReporter {
  return new CrashReporter({
    app: 'cli',
    process: 'main',
    version: '9.9.9',
    home,
    apiBase: 'https://crash.test',
    installId: 'inst-child',
    diagnosticReportsDir: diagDir,
    ...overrides,
  } as any);
}

function captureFetch(calls: Array<{ body: any }>): typeof fetch {
  return (async (_url: any, init: any) => {
    calls.push({ body: JSON.parse(init.body) });
    return { ok: true, status: 200 } as any;
  }) as any;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

/* 没有官方服务的发行版 (开源版) 不上报, 这组不适用 */
describe.skipIf(!DISTRIBUTION.officialServices)('runtime 子进程异常退出', () => {
  it('signal + .ips → kind:native, process:process, 栈来自 .ips', async () => {
    fs.copyFileSync(IPS_FIXTURE, path.join(diagDir, 'node-2026-10-18-032240.ips'));
    const calls: Array<{ body: any }> = [];
    const r = makeReporter({ fetchImpl: captureFetch(calls) });

    r.reportRuntimeProcessExit({
      exitCode: 0,
      signal: 'SIGABRT',
      since: Date.now() - 2_000,
      ipsDelayMs: 0,
    });
    await settle();

    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    expect(body.kind).toBe('native');
    expect(body.process).toBe('process');
    expect(body.signal).toBe('SIGABRT');
    /* 被信号带走时 waitpid 的 code 是 0 —— 不能把它写成 exitCode:0 */
    expect(body.exitCode).toBeUndefined();
    expect(body.message).toContain('runtime 子进程异常退出');
    expect(body.message).toContain('signal=SIGABRT');
    expect(Array.isArray(body.nativeFrames)).toBe(true);
    expect(body.nativeFrames.length).toBeGreaterThan(0);
    expect(body.nativeFrames.some((f: string) => f.includes('better_sqlite3'))).toBe(true);
    /* 载荷里绝不能出现本机 .ips 路径 */
    expect(JSON.stringify(body)).not.toContain(diagDir);
  });

  it('.ips 不在时间窗内 → 仍然报, 但只带 signal/exitCode (不硬编栈)', async () => {
    fs.copyFileSync(IPS_FIXTURE, path.join(diagDir, 'node-2026-10-18-032240.ips'));
    const calls: Array<{ body: any }> = [];
    const r = makeReporter({ fetchImpl: captureFetch(calls) });

    r.reportRuntimeProcessExit({
      exitCode: 134,
      signal: 'SIGABRT',
      /* 子进程「启动」在很久以后 → 目录里的 .ips 都不在窗口内 */
      since: Date.now() + 60_000,
      ipsDelayMs: 0,
    });
    await settle();

    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    expect(body.kind).toBe('native');
    expect(body.exitCode).toBe(134);
    expect(body.message).toContain('exitCode=134');
    /* native 载荷的 nativeFrames 始终是数组 (拿不到栈就是空数组) */
    expect(body.nativeFrames).toEqual([]);
  });

  it('只给退出码 (没信号) 也报 —— 非 0 退出就是异常', async () => {
    const calls: Array<{ body: any }> = [];
    const r = makeReporter({ fetchImpl: captureFetch(calls) });

    r.reportRuntimeProcessExit({ exitCode: 134, since: Date.now(), ipsDelayMs: 0 });
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0].body.signal).toBeUndefined();
    expect(calls[0].body.exitCode).toBe(134);
  });

  it('总开关关掉时不起草 (NEOX_CRASH_REPORT=0)', async () => {
    process.env.NEOX_CRASH_REPORT = '0';
    const calls: Array<{ body: any }> = [];
    const r = makeReporter({ fetchImpl: captureFetch(calls) });

    r.reportRuntimeProcessExit({ exitCode: 0, signal: 'SIGSEGV', since: Date.now(), ipsDelayMs: 0 });
    await settle();

    expect(calls).toHaveLength(0);
  });
});
