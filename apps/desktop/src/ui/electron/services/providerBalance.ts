
export type BalanceResult =
  /* kind: 'balance' = 还剩多少 (默认); 'used' = 这把 Key 已经花了多少 —— new-api 的"不限额度" Key 查不出余额, 只查得出用量 */
  | { status: 'ok'; amount: number; currency: 'CNY' | 'USD'; kind?: 'balance' | 'used'; note?: string }
  | { status: 'unsupported' }
  | { status: 'error'; error: string };

const NEWAPI_QUOTA_PER_USD = 500_000;

async function queryNewApiToken(origin: string, apiKey: string): Promise<BalanceResult> {
  let res: Response;
  try {
    res = await fetch(`${origin}/api/usage/token`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { status: 'unsupported' };
  }
  if (res.status === 401 || res.status === 403) return { status: 'error', error: `HTTP ${res.status}` };
  if (!res.ok) return { status: 'unsupported' };
  let j: any;
  try { j = await res.json(); } catch { return { status: 'unsupported' }; }
  const d = j?.data;
  if (j?.code !== true || !d || typeof d !== 'object') return { status: 'unsupported' };
  const used = num(d.total_used);
  const available = num(d.total_available);
  if (d.unlimited_quota === true) {
    return used == null ? { status: 'unsupported' } : { status: 'ok', kind: 'used', amount: used / NEWAPI_QUOTA_PER_USD, currency: 'USD' };
  }
  return available == null ? { status: 'unsupported' } : { status: 'ok', kind: 'balance', amount: Math.max(0, available / NEWAPI_QUOTA_PER_USD), currency: 'USD' };
}

interface BalanceTarget { baseUrl?: string; apiKey?: string }

type Vendor = 'deepseek' | 'moonshot' | 'openrouter' | 'siliconflow';

export function balanceVendorOf(baseUrl: string | undefined): Vendor | null {
  let host = '';
  try { host = new URL(baseUrl || '').hostname.toLowerCase(); } catch { return null; }
  if (host.endsWith('deepseek.com')) return 'deepseek';
  if (host.endsWith('moonshot.cn') || host.endsWith('moonshot.ai')) return 'moonshot';
  if (host.endsWith('openrouter.ai')) return 'openrouter';
  if (host.endsWith('siliconflow.cn') || host.endsWith('siliconflow.com')) return 'siliconflow';
  return null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

async function getJson(url: string, apiKey: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) {
    /* 401 最常见 = Key 失效; 把状态码带上, 界面据此说人话 */
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }
  try { return JSON.parse(text); } catch { throw new Error('Invalid response'); }
}

/* 这些是官方厂商自己的域名 —— 没有 new-api 那个接口, 别白发一次请求 */
const OFFICIAL_HOST = /(^|\.)(openai\.com|anthropic\.com|googleapis\.com|bigmodel\.cn|x\.ai|aliyuncs\.com|volces\.com|opencode\.ai|mistral\.ai|groq\.com|together\.xyz|fireworks\.ai|minimax(i)?\.(chat|io|com))$/;

export async function queryProviderBalance(target: BalanceTarget): Promise<BalanceResult> {
  const vendor = balanceVendorOf(target.baseUrl);
  const apiKey = (target.apiKey || '').trim();
  if (!vendor) {
    let url: URL;
    try { url = new URL(target.baseUrl || ''); } catch { return { status: 'unsupported' }; }
    if (!apiKey || OFFICIAL_HOST.test(url.hostname.toLowerCase())) return { status: 'unsupported' };
    return queryNewApiToken(url.origin, apiKey);
  }
  if (!apiKey) return { status: 'error', error: 'No API key' };
  const origin = new URL(target.baseUrl!).origin;
  try {
    switch (vendor) {
      case 'deepseek': {
        /* { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] } */
        const j = await getJson(`${origin}/user/balance`, apiKey);
        const info = (j?.balance_infos ?? []).find((b: any) => b?.currency === 'CNY') ?? j?.balance_infos?.[0];
        const amount = num(info?.total_balance);
        if (amount == null) return { status: 'error', error: 'Unexpected response' };
        return { status: 'ok', amount, currency: info?.currency === 'USD' ? 'USD' : 'CNY' };
      }
      case 'moonshot': {
        /* { code: 0, data: { available_balance, voucher_balance, cash_balance } } —— .cn 是人民币, .ai 是美元 */
        const j = await getJson(`${origin}/v1/users/me/balance`, apiKey);
        const amount = num(j?.data?.available_balance);
        if (j?.code !== 0 || amount == null) return { status: 'error', error: j?.message || 'Unexpected response' };
        return { status: 'ok', amount, currency: origin.endsWith('.ai') ? 'USD' : 'CNY' };
      }
      case 'openrouter': {
        /* { data: { total_credits, total_usage } } —— 余额 = 充值总额 - 已用 */
        const j = await getJson('https://openrouter.ai/api/v1/credits', apiKey);
        const total = num(j?.data?.total_credits);
        const used = num(j?.data?.total_usage);
        if (total == null || used == null) return { status: 'error', error: 'Unexpected response' };
        return { status: 'ok', amount: Math.max(0, total - used), currency: 'USD' };
      }
      case 'siliconflow': {
        /* { code: 20000, data: { balance, chargeBalance, totalBalance } } */
        const j = await getJson(`${origin}/v1/user/info`, apiKey);
        const amount = num(j?.data?.totalBalance ?? j?.data?.balance);
        if (amount == null) return { status: 'error', error: j?.message || 'Unexpected response' };
        return { status: 'ok', amount, currency: origin.endsWith('.com') ? 'USD' : 'CNY' };
      }
    }
  } catch (err: any) {
    return { status: 'error', error: err?.name === 'TimeoutError' ? 'Request timeout' : String(err?.message ?? err) };
  }
}
