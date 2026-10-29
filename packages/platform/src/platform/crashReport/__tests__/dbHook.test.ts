
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CrashReporter } from '../reporter.js';
import { recordDbInitFailure, clearDbInitFailure } from '../../dbInitFailure.js';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-crash-db-'));
  saved.NODE_ENV = process.env.NODE_ENV;
  saved.NEOX_HOME_DIRNAME = process.env.NEOX_HOME_DIRNAME;
  saved.NEOX_CRASH_REPORT = process.env.NEOX_CRASH_REPORT;
  process.env.NODE_ENV = 'production';
  delete process.env.NEOX_HOME_DIRNAME;
  delete process.env.NEOX_CRASH_REPORT;
});

afterEach(() => {
  clearDbInitFailure();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/* 没有官方服务的发行版 (开源版) 不上报, 这组不适用 */
describe.skipIf(!DISTRIBUTION.officialServices)('db 失败上报', () => {
  it('recordDbInitFailure → 发一条 kind:db 的报告 (带脱敏后的原因)', async () => {
    const calls: Array<{ body: any }> = [];
    const reporter = new CrashReporter({
      app: 'desktop',
      process: 'worker',
      version: '9.9.9',
      home,
      apiBase: 'https://crash.test',
      installId: 'inst-db',
      fetchImpl: (async (_u: any, init: any) => {
        calls.push({ body: JSON.parse(init.body) });
        return { ok: true, status: 200 } as any;
      }) as any,
    });
    reporter.installDbHook();

    recordDbInitFailure('/Users/alice/.neox/sessions.db', new Error('file is not a database (code 26)'));
    await new Promise((r) => setTimeout(r, 40));

    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    expect(body.kind).toBe('db');
    expect(body.app).toBe('desktop');
    expect(body.process).toBe('worker');
    expect(body.message).toContain('会话库无法打开');
    expect(body.message).toContain('not a database');
    /* dbPath 里的用户名不能出现在载荷里 */
    expect(JSON.stringify(body)).not.toContain('alice');
    expect(body.dedupeKey).toHaveLength(16);
  });
});
