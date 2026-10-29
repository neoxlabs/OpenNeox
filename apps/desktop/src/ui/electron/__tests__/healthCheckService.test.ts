/**
 * Probe diagnostics: health records must carry error/httpStatus/model
 * so the settings modal can show success AND failure (not empty forever).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('HealthCheckService probe record fields', () => {
  let dir: string;
  let service: import('../../../platform-electron/healthCheckService.js').HealthCheckService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'neox-health-'));
    /* 走 NEOX_DATA_DIR 而不是 mock electron: 服务改成**运行时**取 electron 之后
     * (顶层 import 会让整个 bundle 在纯 Node 后端里加载失败, 见 lazyElectron.ts),
     * vi.doMock('electron') 对 createRequire 不起作用 —— 测试会转而去读真实用户目录,
     * 拿到真数据, 断言随机地红。 */
    process.env.NEOX_DATA_DIR = dir;
    vi.resetModules();
    const mod = await import('../../../platform-electron/healthCheckService.js');
    // Fresh instance against temp userData
    service = new mod.HealthCheckService();
  });

  afterEach(() => {
    delete process.env.NEOX_DATA_DIR;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('persists error, httpStatus and model on failure', () => {
    const rec = service.updateProviderHealth('p1', 'error', 1200, 'Invalid API key', 401, 'claude-sonnet-4');
    expect(rec.current).toBe('error');
    expect(rec.latency).toBe(1200);
    expect(rec.history).toHaveLength(1);
    expect(rec.history[0]).toMatchObject({
      status: 'error',
      latency: 1200,
      error: 'Invalid API key',
      httpStatus: 401,
      model: 'claude-sonnet-4',
    });
  });

  it('persists model on success without inventing an error', () => {
    const rec = service.updateProviderHealth('p2', 'excellent', 180, undefined, undefined, 'gpt-4o');
    expect(rec.history[0]).toMatchObject({
      status: 'excellent',
      latency: 180,
      model: 'gpt-4o',
    });
    expect(rec.history[0].error).toBeUndefined();
  });
});
