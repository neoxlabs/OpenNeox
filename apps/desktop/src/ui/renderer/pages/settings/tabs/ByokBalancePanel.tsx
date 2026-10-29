import React from 'react';
import { useSettingsContext } from '../SettingsContext';
import { ProviderBrandIcon, inferProviderBrand } from '../../../modules/agent-timeline/ProviderBrandIcon';
import { NEOX_CLOUD_PROVIDER_ID } from '../../../../shared/neoxCloud';
import { dispatchHint } from '../../../components/notifyEvents';

type Balance =
  | { status: 'ok'; amount: number; currency: 'CNY' | 'USD'; kind?: 'balance' | 'used' }
  | { status: 'unsupported' }
  | { status: 'error'; error: string }
  | { status: 'loading' };

interface Links { console?: string; topUp?: string; usage?: string }

/* 按 baseUrl 域名找官方页面 —— 名字用户能改, 域名决定钱花在谁那儿 */
const LINKS: Array<[RegExp, Links]> = [
  [/deepseek\.com$/, { console: 'https://platform.deepseek.com', topUp: 'https://platform.deepseek.com/top_up', usage: 'https://platform.deepseek.com/usage' }],
  [/moonshot\.cn$/, { console: 'https://platform.moonshot.cn/console/account' }],
  [/moonshot\.ai$/, { console: 'https://platform.moonshot.ai/console/account' }],
  [/openrouter\.ai$/, { console: 'https://openrouter.ai/settings/keys', topUp: 'https://openrouter.ai/settings/credits', usage: 'https://openrouter.ai/activity' }],
  [/siliconflow\.cn$/, { console: 'https://cloud.siliconflow.cn' }],
  [/siliconflow\.com$/, { console: 'https://cloud.siliconflow.com' }],
  [/(^|\.)openai\.com$/, { console: 'https://platform.openai.com', topUp: 'https://platform.openai.com/settings/organization/billing/overview', usage: 'https://platform.openai.com/usage' }],
  [/anthropic\.com$/, { console: 'https://console.anthropic.com', topUp: 'https://console.anthropic.com/settings/billing' }],
  [/bigmodel\.cn$/, { console: 'https://open.bigmodel.cn' }],
  [/googleapis\.com$/, { console: 'https://aistudio.google.com' }],
  [/x\.ai$/, { console: 'https://console.x.ai' }],
  [/aliyuncs\.com$/, { console: 'https://bailian.console.aliyun.com' }],
  [/volces\.com$/, { console: 'https://console.volcengine.com/ark' }],
];

function linksFor(baseUrl: string | undefined): Links | null {
  let host = '';
  try { host = new URL(baseUrl || '').hostname.toLowerCase(); } catch { return null; }
  return LINKS.find(([re]) => re.test(host))?.[1] ?? null;
}

/* 符号按余额本身的币种取 (中转站按人民币, 官方按美元), 跟界面语言无关 */
const CURRENCY_SYMBOL: Record<'CNY' | 'USD', string> = { CNY: '¥', USD: '$' };
const fmtMoney = (b: { amount: number; currency: 'CNY' | 'USD' }) =>
  `${CURRENCY_SYMBOL[b.currency]}${b.amount.toFixed(2)}`;

/* 低于这个数标红: 人民币 10 元 / 美元 2 刀 —— 大致够跑一两天重度任务 */
const isLow = (b: { amount: number; currency: 'CNY' | 'USD' }) => b.amount < (b.currency === 'CNY' ? 10 : 2);

/* 同一次打开设置页内不重复查: 切 tab 回来直接用; 点「刷新」才重查 */
const cache = new Map<string, { at: number; value: Balance }>();
const CACHE_MS = 5 * 60_000;

export const ByokBalancePanel: React.FC<{ zh: boolean }> = ({ zh }) => {
  const { providers } = useSettingsContext();
  const list = React.useMemo(
    () => (providers as any[]).filter((p) => p.id !== NEOX_CLOUD_PROVIDER_ID),
    [providers],
  );
  const [balances, setBalances] = React.useState<Record<string, Balance>>({});

  const load = React.useCallback((force: boolean) => {
    const api = (window as any).neox;
    for (const p of list) {
      const hit = cache.get(p.id);
      if (!force && hit && Date.now() - hit.at < CACHE_MS) {
        setBalances((prev) => ({ ...prev, [p.id]: hit.value }));
        continue;
      }
      setBalances((prev) => ({ ...prev, [p.id]: { status: 'loading' } }));
      void Promise.resolve(api?.providerBalance?.(p.id))
        .then((r: Balance | undefined) => r ?? { status: 'unsupported' as const })
        .catch((e: any) => ({ status: 'error' as const, error: String(e?.message ?? e) }))
        .then((value) => {
          cache.set(p.id, { at: Date.now(), value });
          setBalances((prev) => ({ ...prev, [p.id]: value }));
        });
    }
  }, [list]);

  React.useEffect(() => { load(false); }, [load]);

  if (list.length === 0) return null;
  const open = (url: string) => {
    try {
      const opening = (window as any).neox?.openExternal?.(url);
      void opening?.catch(() => dispatchHint(zh ? '打不开这个页面' : 'Couldn’t open the page', 'warning'));
    } catch { /* 没有 bridge 的宿主直接忽略 */ }
  };

  return (
    <div className="byok3 byok3-card byok-bal-card">
      <div className="byok3-card__head">
        <span className="byok3-card__title">{zh ? '各家余额' : 'Balances'}</span>
        <button type="button" className="byok3-textbtn" onClick={() => load(true)}>
          <span aria-hidden="true">↻</span>
          {zh ? '刷新' : 'Refresh'}
        </button>
      </div>
      {list.map((p) => {
        const b = balances[p.id] ?? { status: 'loading' };
        const links = linksFor(p.baseUrl);
        const brand = inferProviderBrand({ name: p.name, protocol: p.protocol, id: p.id });
        const linkItems: Array<[string, string | undefined]> = [
          [zh ? '控制台' : 'Console', links?.console],
          [zh ? '充值' : 'Top up', links?.topUp],
          [zh ? '用量明细' : 'Usage', links?.usage],
        ];
        const shownLinks = linkItems.filter(([, url]) => !!url);
        const value = b.status === 'ok'
          ? (b.kind === 'used'
            /* new-api 中转站的"不限额度" Key: 查不出还剩多少, 只查得出这把 Key 花了多少 —— 如实写「已用」 */
            ? <span className="byok-bal__muted" title={zh ? '这把 Key 不限额度, 中转站只报它已经用了多少' : 'Unlimited key — the relay only reports how much it has used'}>
                {zh ? `已用 ${fmtMoney(b)}` : `Used ${fmtMoney(b)}`}
              </span>
            : <>
                <span className={`byok-bal__amount${isLow(b) ? ' is-low' : ''}`}>{fmtMoney(b)}</span>
                {isLow(b) && <span className="byok-bal__chip">{zh ? '余额低' : 'Low'}</span>}
              </>)
          : b.status === 'loading'
            ? <span className="byok-bal__muted">…</span>
            : b.status === 'error'
              ? <span className="byok-bal__err" title={b.error}>
                  {/HTTP 401|HTTP 403/.test(b.error) ? (zh ? 'Key 无效' : 'Invalid key') : (zh ? '查询失败' : 'Unavailable')}
                </span>
              /* 没有控制台链接的 (中转站) 就别说"到控制台查看" —— 那句话指向一个不存在的按钮 */
              : links?.console
                ? <span className="byok-bal__muted">{zh ? '到控制台查看' : 'See console'}</span>
                : <span className="byok-bal__muted" title={zh ? '这家不提供余额查询接口' : 'No balance API for this provider'}>—</span>;
        /* 图标位永远占着 —— 认不出品牌的中转站给首字母圆标, 每行结构一致 */
        return (
          <div key={p.id} className="byok-bal__row">
            <span className="byok-bal__logo">
              {brand !== 'generic'
                ? <ProviderBrandIcon brand={brand} size={24} />
                : <span className="byok-bal__initial" aria-hidden="true">{(p.name || '?').trim().charAt(0).toUpperCase()}</span>}
            </span>
            <span className="byok-bal__name" title={p.name}>{p.name}</span>
            <span className="byok-bal__links">
              {shownLinks.map(([label, url], i) => (
                <React.Fragment key={label}>
                  {i > 0 && <span className="byok-bal__dot" aria-hidden="true">·</span>}
                  <button type="button" className="byok-bal__link" onClick={() => open(url!)}>
                    {label}
                  </button>
                </React.Fragment>
              ))}
            </span>
            <span className="byok-bal__value">{value}</span>
          </div>
        );
      })}
    </div>
  );
};
