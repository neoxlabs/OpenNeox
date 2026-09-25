import { describe, it, expect, vi, afterEach } from 'vitest';
import { runProviderHealthCheck } from '../providerHealthCheck.js';

const base = { providerId: 'neox-cloud', protocol: 'openai' as const, baseUrl: '', model: 'gpt-4o' };

afterEach(() => { vi.unstubAllGlobals(); });

describe('neox-cloud 托管 provider 探活', () => {
  it('sentinel 未解析 (未登录) → 请先登录', async () => {
    const r = await runProviderHealthCheck({ ...base, apiKey: 'neox-managed', cloudApiBase: 'https://neox-dev.com' });
    expect(r.status).toBe('error');
    expect(r.errorMessage).toBe('请先登录 Neox Cloud');
  });

  it('apiKey 空 (resolver 抹掉 = 没 token) → 请先登录', async () => {
    const r = await runProviderHealthCheck({ ...base, apiKey: '', cloudApiBase: 'https://neox-dev.com' });
    expect(r.status).toBe('error');
    expect(r.errorMessage).toBe('请先登录 Neox Cloud');
  });

  it('有凭据但调用方没传 cloudApiBase → 保持旧行为, 不回归', async () => {
    const r = await runProviderHealthCheck({ ...base, apiKey: 'nxk_abc_def' });
    expect(r.status).toBe('error');
    expect(r.errorMessage).toBe('请先登录 Neox Cloud');
  });

  it('有凭据 + 有 base → 打 /api/health, 不再谎报未登录', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const r = await runProviderHealthCheck({ ...base, apiKey: 'nxk_abc_def', cloudApiBase: 'https://neox-dev.com/' });
    expect(fetchMock).toHaveBeenCalledOnce();
    /* 尾斜杠要被吃掉, 不能打出 //api/health */
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://neox-dev.com/api/health');
    expect(r.status).toMatch(/excellent|good|poor/);
    expect(r.errorMessage).toBeUndefined();
  });

  it('控制面非 2xx → error 带 httpStatus, 但不说"请先登录"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 503 }));
    const r = await runProviderHealthCheck({ ...base, apiKey: 'nxk_abc_def', cloudApiBase: 'https://neox-dev.com' });
    expect(r.status).toBe('error');
    expect(r.httpStatus).toBe(503);
    expect(r.errorMessage).not.toContain('请先登录');
  });

  it('网络不通 → offline 而不是 error (error 在这张表里=要你动手改配置)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    const r = await runProviderHealthCheck({ ...base, apiKey: 'nxk_abc_def', cloudApiBase: 'https://neox-dev.com' });
    expect(r.status).toBe('offline');
  });
});
