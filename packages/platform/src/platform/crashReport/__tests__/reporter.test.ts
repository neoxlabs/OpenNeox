
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrashReporter, isCrashReportEnabled } from '../reporter.js';
import { writeRunMarker } from '../runMarker.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IPS_FIXTURE = path.join(HERE, 'fixtures', 'node-abort-sample.ips');

const DEAD_PID = 4_000_000;

/* 每轮测试换一个临时 home + 放开 env 闸 (vitest 默认 NODE_ENV=test, 会把上报关掉)。 */
let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-crash-home-'));
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

function makeReporter(overrides: Partial<ConstructorParameters<typeof CrashReporter>[0]> = {}): CrashReporter {
  return new CrashReporter({
    app: 'cli',
    process: 'main',
    version: '9.9.9',
    home,
    apiBase: 'https://crash.test',
    installId: 'inst-fixed',
    now: Date.now,
    ...overrides,
  });
}

function okFetch(calls: Array<{ url: string; body: any }>): typeof fetch {
  return (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200 } as any;
  }) as any;
}

function failFetch(): typeof fetch {
  return (async () => {
    throw new Error('offline');
  }) as any;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

/* 没有官方服务的发行版 (开源版, kernel distribution.ts) 不上报 —— 下面"会发出去"的几组只在有官方服务时跑 */
const HAS_OFFICIAL = DISTRIBUTION.officialServices;

describe('isCrashReportEnabled 闸', () => {
  it.skipIf(!HAS_OFFICIAL)('默认开', () => {
    expect(isCrashReportEnabled()).toBe(true);
  });
  it.skipIf(HAS_OFFICIAL)('没有官方服务的发行版恒关', () => {
    expect(isCrashReportEnabled()).toBe(false);
  });
  it('NEOX_CRASH_REPORT=0 关', () => {
    process.env.NEOX_CRASH_REPORT = '0';
    expect(isCrashReportEnabled()).toBe(false);
  });
  it('自定义 NEOX_HOME_DIRNAME (测试实例) 关', () => {
    process.env.NEOX_HOME_DIRNAME = '.neox-e2e';
    expect(isCrashReportEnabled()).toBe(false);
  });
  it('extra 返回 false 时关', () => {
    expect(isCrashReportEnabled(() => false)).toBe(false);
  });
});

describe.skipIf(!HAS_OFFICIAL)('CrashReporter 上报', () => {
  it('JS 崩溃: 序列化 + 脱敏 (路径/密钥抹掉, 不带对话内容)', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const r = makeReporter({ fetchImpl: okFetch(calls), workspaceDir: '/Users/alice/proj' });
    const err = new Error('boom at /Users/alice/proj/src/a.ts with sk-abcdefghijklmnopqrstuvwx');
    err.stack = 'Error: boom\n    at doIt (/Users/alice/proj/src/a.ts:10:5)\n    at node:internal/x:1:1';
    r.reportJs(err);
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://crash.test/api/v1/crash-reports');
    const body = calls[0].body;
    expect(body.kind).toBe('js');
    expect(body.app).toBe('cli');
    expect(body.version).toBe('9.9.9');
    expect(body.installId).toBe('inst-fixed');
    expect(body.dedupeKey).toHaveLength(16);
    expect(typeof body.occurredAt).toBe('string');
    /* 脱敏 */
    expect(JSON.stringify(body)).not.toContain('alice');
    expect(JSON.stringify(body)).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(body.stack[0]).toContain('proj/src/a.ts'); // 工作区只留最后一段
    expect(body.stack.length).toBeLessThanOrEqual(40);
  });

  it('同一 dedupeKey 一天内最多报 3 次', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const r = makeReporter({ fetchImpl: okFetch(calls) });
    const err = new Error('same crash');
    err.stack = 'Error: same crash\n    at samePlace (src/x.ts:1:1)';
    for (let i = 0; i < 6; i++) r.reportJs(err);
    await settle();
    expect(calls).toHaveLength(3);
  });

  it('发送失败 → 落盘; 下次启动重发', async () => {
    const offline = makeReporter({ fetchImpl: failFetch() });
    const err = new Error('offline crash');
    err.stack = 'Error: offline crash\n    at f (src/o.ts:1:1)';
    offline.reportJs(err);
    await settle();

    const queueDir = path.join(home, 'crash-report', 'queue');
    const pending = fs.readdirSync(queueDir).filter((n) => n.endsWith('.json'));
    expect(pending).toHaveLength(1);

    /* 下次启动: 新的 reporter (同一 home) + 通的网络 → 队列清空 */
    const calls: Array<{ url: string; body: any }> = [];
    const online = makeReporter({ fetchImpl: okFetch(calls) });
    await online.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.message).toContain('offline crash');
    expect(fs.readdirSync(queueDir).filter((n) => n.endsWith('.json'))).toHaveLength(0);
  });

  it('4xx (非 408/429) 视为已处理, 不堵队列', async () => {
    const badReq = (async () => ({ ok: false, status: 400 } as any)) as any;
    const r = makeReporter({ fetchImpl: badReq });
    r.reportJs(new Error('bad'));
    await settle();
    const queueDir = path.join(home, 'crash-report', 'queue');
    expect(fs.readdirSync(queueDir).filter((n) => n.endsWith('.json'))).toHaveLength(0);
  });

  it('NEOX_CRASH_REPORT=0 时什么都不做', async () => {
    process.env.NEOX_CRASH_REPORT = '0';
    const calls: Array<{ url: string; body: any }> = [];
    const r = makeReporter({ fetchImpl: okFetch(calls) });
    r.reportJs(new Error('x'));
    await settle();
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(home, 'crash-report', 'queue'))).toBe(false);
  });
});

describe.skipIf(!HAS_OFFICIAL)('CrashReporter 原生崩溃补报', () => {
  it('上次异常退出标记 + .ips → 补报 native 并清标记', async () => {
    const baseDir = path.join(home, 'crash-report');
    writeRunMarker(baseDir, {
      pid: DEAD_PID,
      startedAt: Date.now() - 2_000,
      app: 'cli',
      version: '9.9.9',
      process: 'main',
    });

    /* 造一个 .ips 目录 */
    const diagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-diag-'));
    fs.copyFileSync(IPS_FIXTURE, path.join(diagDir, 'node-2026-10-18-032240.ips'));

    const calls: Array<{ url: string; body: any }> = [];
    const r = makeReporter({
      fetchImpl: okFetch(calls),
      diagnosticReportsDir: diagDir,
      useRunMarker: false,
    });
    await r.runStartupRecovery();
    await settle();

    const native = calls.find((c) => c.body.kind === 'native');
    expect(native).toBeTruthy();
    expect(native!.body.signal).toBe('SIGABRT');
    expect(Array.isArray(native!.body.nativeFrames)).toBe(true);
    expect(native!.body.nativeFrames.length).toBeGreaterThan(0);
    expect(native!.body.nativeFrames.some((f: string) => f.includes('better_sqlite3'))).toBe(true);
    /* 标记已被清掉 */
    expect(fs.readdirSync(baseDir).filter((n) => n.startsWith('run-'))).toHaveLength(0);
  });

  it('只有残留标记、没有 .ips → 不报, 但标记照样清掉', async () => {
    const baseDir = path.join(home, 'crash-report');
    writeRunMarker(baseDir, {
      pid: DEAD_PID,
      startedAt: Date.now() - 2_000,
      app: 'cli',
      version: '9.9.9',
      process: 'main',
    });

    /* 空 .ips 目录: 模拟正常关闭 CLI (没崩, 自然没有系统崩溃报告) */
    const diagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-diag-empty-'));

    const calls: Array<{ url: string; body: any }> = [];
    const r = makeReporter({
      fetchImpl: okFetch(calls),
      diagnosticReportsDir: diagDir,
      useRunMarker: false,
    });
    await r.runStartupRecovery();
    await settle();

    expect(calls).toHaveLength(0);
    /* 不清标记就会每次启动都重清一遍并堆积 */
    expect(fs.readdirSync(baseDir).filter((n) => n.startsWith('run-'))).toHaveLength(0);
  });
});
