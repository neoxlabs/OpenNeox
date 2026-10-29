
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isAbnormalRuntimeExit, reportAbnormalRuntimeExit } from '../runtimeCrashMonitor.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

let home: string;
let diagDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-core-crash-home-'));
  diagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-core-crash-diag-'));
  savedEnv.NODE_ENV = process.env.NODE_ENV;
  savedEnv.NEOX_HOME_DIRNAME = process.env.NEOX_HOME_DIRNAME;
  savedEnv.NEOX_CRASH_REPORT = process.env.NEOX_CRASH_REPORT;
  process.env.NODE_ENV = 'production';
  delete process.env.NEOX_HOME_DIRNAME;
  delete process.env.NEOX_CRASH_REPORT;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const settle = () => new Promise((r) => setTimeout(r, 60));

describe('isAbnormalRuntimeExit', () => {
  it('主动关闭: 带信号也不算', () => {
    expect(isAbnormalRuntimeExit({ code: 0, signal: 'SIGTERM', deliberateClose: true })).toBe(false);
    expect(isAbnormalRuntimeExit({ code: 137, signal: null, deliberateClose: true })).toBe(false);
  });

  it('正常退出: code 0 且无信号', () => {
    expect(isAbnormalRuntimeExit({ code: 0, signal: null, deliberateClose: false })).toBe(false);
  });

  it('崩溃: 有信号或非 0 退出', () => {
    expect(isAbnormalRuntimeExit({ code: 0, signal: 'SIGSEGV', deliberateClose: false })).toBe(true);
    expect(isAbnormalRuntimeExit({ code: 134, signal: null, deliberateClose: false })).toBe(true);
  });
});

/* 没有官方服务的发行版 (开源版) 不上报, 这组不适用 */
describe.skipIf(!DISTRIBUTION.officialServices)('reportAbnormalRuntimeExit', () => {
  async function installReporter() {
    const calls: Array<{ body: any }> = [];
    const { installCrashReporter } = await import('@neoxlabs/platform/platform/crashReport/index.js');
    installCrashReporter({
      app: 'desktop',
      process: 'main',
      version: '9.9.9',
      home,
      apiBase: 'https://crash.test',
      installId: 'inst-core',
      diagnosticReportsDir: diagDir,
      installProcessHooks: false,
      fetchImpl: (async (_u: any, init: any) => {
        calls.push({ body: JSON.parse(init.body) });
        return { ok: true, status: 200 } as any;
      }) as any,
    });
    return calls;
  }

  it('子进程被信号带走 → 发一条 native (process=process)', async () => {
    const calls = await installReporter();
    reportAbnormalRuntimeExit({
      code: 0,
      signal: 'SIGKILL',
      deliberateClose: false,
      since: Date.now(),
      ipsDelayMs: 0,
    });
    await settle();

    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    expect(body.kind).toBe('native');
    expect(body.app).toBe('desktop');
    expect(body.process).toBe('process');
    expect(body.signal).toBe('SIGKILL');
    expect(body.message).toContain('runtime 子进程异常退出');
  });

  it('主动关闭不报', async () => {
    const calls = await installReporter();
    reportAbnormalRuntimeExit({
      code: 0,
      signal: 'SIGTERM',
      deliberateClose: true,
      since: Date.now(),
      ipsDelayMs: 0,
    });
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('正常退出 (code 0 无信号) 不报', async () => {
    const calls = await installReporter();
    reportAbnormalRuntimeExit({ code: 0, signal: null, deliberateClose: false, since: Date.now(), ipsDelayMs: 0 });
    await settle();
    expect(calls).toHaveLength(0);
  });
});
