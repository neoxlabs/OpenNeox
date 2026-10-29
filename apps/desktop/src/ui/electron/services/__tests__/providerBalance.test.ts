import { describe, it, expect, vi, afterEach } from 'vitest';
import { balanceVendorOf, queryProviderBalance } from '../providerBalance';

describe('BYOK 余额', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('按 baseUrl 域名认厂商 (不按名字), 走 Anthropic 协议的 DeepSeek 也认得', () => {
    expect(balanceVendorOf('https://api.deepseek.com')).toBe('deepseek');
    expect(balanceVendorOf('https://api.deepseek.com/anthropic')).toBe('deepseek');
    expect(balanceVendorOf('https://api.moonshot.cn/v1')).toBe('moonshot');
    expect(balanceVendorOf('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(balanceVendorOf('https://api.siliconflow.cn/v1')).toBe('siliconflow');
    expect(balanceVendorOf('https://api.openai.com/v1')).toBeNull();
    expect(balanceVendorOf('not a url')).toBeNull();
  });

  it('查不了的厂商返回 unsupported, 不发请求', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await queryProviderBalance({ baseUrl: 'https://api.anthropic.com', apiKey: 'k' })).toEqual({ status: 'unsupported' });
    expect(f).not.toHaveBeenCalled();
  });

  it('DeepSeek: 取人民币那一条的 total_balance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '1.00' }, { currency: 'CNY', total_balance: '495.78' }],
    }))));
    expect(await queryProviderBalance({ baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'k' }))
      .toEqual({ status: 'ok', amount: 495.78, currency: 'CNY' });
  });

  it('OpenRouter: 余额 = 充值总额 - 已用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 5.25 } }))));
    expect(await queryProviderBalance({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' }))
      .toEqual({ status: 'ok', amount: 4.75, currency: 'USD' });
  });

  it('new-api 中转站: 限额 Key 报剩余, 不限额 Key 报已用 (500000 额度 = $1)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: true, data: { total_available: 2_500_000, total_used: 83_356_699, unlimited_quota: false },
    }))));
    expect(await queryProviderBalance({ baseUrl: 'https://api.some-relay.net/v1', apiKey: 'k' }))
      .toEqual({ status: 'ok', kind: 'balance', amount: 5, currency: 'USD' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: true, data: { total_available: -5_946_730, total_used: 83_356_699, unlimited_quota: true },
    }))));
    const r = await queryProviderBalance({ baseUrl: 'https://api.some-relay.net/v1', apiKey: 'k' });
    expect(r).toMatchObject({ status: 'ok', kind: 'used', currency: 'USD' });
    expect((r as any).amount).toBeCloseTo(166.71, 2);
  });

  it('不是 new-api 的中转站 (404) 当 unsupported, 不报错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('404 page not found', { status: 404 })));
    expect(await queryProviderBalance({ baseUrl: 'https://relay-b.cfd/v1', apiKey: 'k' })).toEqual({ status: 'unsupported' });
  });

  it('401 带状态码回去 (界面据此写「Key 无效」)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    const r = await queryProviderBalance({ baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'k' });
    expect(r.status).toBe('error');
    expect((r as any).error).toMatch(/HTTP 401/);
  });
});
