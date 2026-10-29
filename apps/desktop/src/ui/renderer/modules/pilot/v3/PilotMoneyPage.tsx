/**
 * Pilot · 钱 (稿 pl2)。数都来自 pilot-data 的 /overview (rooms.money) 和 /records, 跟手机同一份账。
 *
 *   头: 钱 · 这个月记了几笔 | 这个月 / 平时 / 照这速度月底
 *   左: 花在哪 (按类一条条横条, 底下一句它看出来的 + 一个能直接办的按钮) · 最近几笔
 *   右: 家底 (净资产 + 一个月变化 + 各账户) · 每月自动扣 · 「帮我理理财」
 */
import React, { useMemo } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { baseType, usePilotOverview, usePilotRecords, yuan, type PilotRecordRow } from './pilotData';
import { useInsightRunner } from './useInsightRunner';
import { brandLogo } from './brandLogos';

const S = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const I = {
  food: <svg {...S}><path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 21V3c-2 1.5-3 4-3 7v3h3" /></svg>,
  move: <svg {...S}><rect x="4.5" y="4" width="15" height="13" rx="3" /><path d="M4.5 11h15M8 17v2.5M16 17v2.5M8 14h.01M16 14h.01" /></svg>,
  bag: <svg {...S}><path d="M5 8h14l-1 12H6zM9 8V6.5a3 3 0 0 1 6 0V8" /></svg>,
  home: <svg {...S}><path d="M4 11 12 4l8 7M6 9.5V20h12V9.5" /></svg>,
  shirt: <svg {...S}><path d="M9 4 4 7l2 4 2-1v10h8V10l2 1 2-4-5-3a3 3 0 0 1-6 0Z" /></svg>,
  more: <svg {...S}><path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="2.5" /></svg>,
  coffee: <svg {...S}><path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5v2.5M11 3.5v2.5" /></svg>,
  income: <svg {...S}><path d="M12 19V5M6 11l6-6 6 6" /></svg>,
  bank: <svg {...S}><path d="M3.5 9 12 4l8.5 5M5 9v9M19 9v9M9.5 9v9M14.5 9v9M3.5 20h17" /></svg>,
  invest: <svg {...S}><path d="M4 18 9.5 12l3.5 3.5L20 8M15 8h5v5" /></svg>,
  loan: <svg {...S}><path d="M4 11 12 4l8 7M6 9.5V20h12V9.5M10 20v-5h4v5" /></svg>,
  card: <svg {...S}><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="M3 10h18M7 15h3" /></svg>,
  repeat: <svg {...S}><path d="M17 3l3 3-3 3M4 11V9.5A3.5 3.5 0 0 1 7.5 6H20M7 21l-3-3 3-3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H4" /></svg>,
};

/** 类目 → 小图标 (服务端已归到 吃饭 / 交通 / 购物 / 居家 / 衣着 / 其它) */
function catIcon(cat: string): React.ReactNode {
  if (/吃|饭|餐|食|外卖|咖啡|奶茶/.test(cat)) return I.food;
  if (/交通|打车|地铁|公交|高铁|加油|停车/.test(cat)) return I.move;
  if (/购物|淘宝|京东|超市/.test(cat)) return I.bag;
  if (/居家|住|房|物业|水|电|燃气/.test(cat)) return I.home;
  if (/衣/.test(cat)) return I.shirt;
  return I.more;
}
function rowIcon(r: PilotRecordRow): React.ReactNode {
  if (baseType(r.type) === 'finance.income') return I.income;
  const text = `${r.data.category ?? ''} ${r.data.merchant ?? ''} ${r.title}`;
  if (/咖啡|瑞幸|星巴克|奶茶/.test(text)) return I.coffee;
  return catIcon(text);
}
function accountIcon(kind: string, name: string): React.ReactNode {
  const t = `${kind} ${name}`;
  if (/贷|loan|mortgage/i.test(t)) return I.loan;
  if (/基金|理财|股票|余额宝|invest|fund|stock/i.test(t)) return I.invest;
  if (/信用卡|credit/i.test(t)) return I.card;
  return I.bank;
}

function when(ms: number, zh: boolean): string {
  const d = new Date(ms);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return zh ? `今天 ${hm}` : `Today ${hm}`;
  return zh ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}` : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm}`;
}
/** 账户类型 (服务端存英文 kind) → 一个词 */
const KIND_ZH: Record<string, string> = {
  property: '房产', deposit: '储蓄', fund: '理财', stock: '股票', debt: '负债', loan: '贷款', credit: '信用卡', cash: '现金', car: '车',
};
const KIND_EN: Record<string, string> = {
  property: 'Property', deposit: 'Savings', fund: 'Funds', stock: 'Stocks', debt: 'Debt', loan: 'Loan', credit: 'Credit card', cash: 'Cash', car: 'Car',
};

/** 行首那格: 认得出是哪家就放那家的真 logo, 认不出画线条小图标 */
const ListIcon: React.FC<{ logo: string | null; fallback: React.ReactNode }> = ({ logo, fallback }) => (
  logo
    ? <span className="pv3-list__ic is-logo"><img src={logo} alt="" draggable={false} /></span>
    : <span className="pv3-list__ic">{fallback}</span>
);

const md = (day: string) => day.slice(5).replace('-', '/');

/** 按月扣的下一次: 汇总里给的日子已经过了 (上个周期的) 就顺延到下个月同一天, 不显示过去的日期 */
function nextCharge(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  while (d < today) d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface Props {
  sessionId: string | null;
  onGoChat: () => void;
}

export const PilotMoneyPage: React.FC<Props> = ({ sessionId, onGoChat }) => {
  const { isZh } = useI18n();
  const { data } = usePilotOverview();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const month = usePilotRecords(['finance.expense', 'finance.income'], { from: monthStart, limit: 500 });
  const { run, ask, done } = useInsightRunner(sessionId, onGoChat);
  const m = data?.rooms.money;

  const cats = useMemo(() => [...(m?.monthByCategory ?? [])].sort((a, b) => b.amount - a.amount).slice(0, 6), [m]);
  const maxCat = Math.max(1, ...cats.map((c) => c.amount));
  const tip = (data?.insights ?? []).find((i) => i.domain === 'money' && i.action && !done[i.id]);
  const recent = (month.data?.records ?? []).slice(0, 6);
  const count = month.data?.records.filter((r) => baseType(r.type) === 'finance.expense').length;

  /* 月底: 有 money.pace 洞察就用它算好的 (扣掉了大额); 没有就 平时一个月 × 速度倍数 (scene.pace 是倍数不是钱) */
  const paceInsight = (data?.insights ?? []).find((i) => i.id === 'money.pace');
  const projected = typeof paceInsight?.numbers?.projected === 'number'
    ? paceInsight.numbers.projected
    : m?.scene?.usualMonth != null && m.scene.pace != null ? m.scene.usualMonth * m.scene.pace : null;
  const stats = [
    { v: yuan(m?.monthSpent ?? null), l: isZh ? '这个月' : 'This month' },
    { v: yuan(m?.scene?.usualMonth ?? null), l: isZh ? '平时' : 'Usual' },
    { v: yuan(projected), l: isZh ? '照这速度月底' : 'Month-end pace' },
  ];

  return (
    <div className="pv3-room" data-loading={data ? undefined : ''}>
      <header className="pv3-room__head">
        <div>
          <h1 className="pv3-pagehead">{isZh ? '钱' : 'Money'}</h1>
          <p className="pv3-pagesub">
            {isZh ? `${now.getMonth() + 1}月` : now.toLocaleDateString('en-US', { month: 'long' })}
            {count != null ? (isZh ? ` · 已记 ${count} 笔，都是它自动记的` : ` · ${count} logged automatically`) : ''}
          </p>
        </div>
        <div className="pv3-room__stats">
          {stats.map((s) => (
            <div key={s.l} className="pv3-stat"><b>{s.v}</b><span>{s.l}</span></div>
          ))}
        </div>
      </header>

      <div className="pv3-room__cols">
        <div className="pv3-room__col">
          <section className="pv3-box">
            <h2 className="pv3-box__title">{isZh ? '花在哪' : 'Where it went'}</h2>
            {cats.length === 0 ? (
              <p className="pv3-box__empty">{isZh ? '这个月还没有记账' : 'Nothing logged this month'}</p>
            ) : (
              <ul className="pv3-bars">
                {cats.map((c) => (
                  <li key={c.category}>
                    <span className="pv3-bars__ic">{catIcon(c.category)}</span>
                    <span className="pv3-bars__name">{c.category}</span>
                    <span className="pv3-bars__track"><i style={{ width: `${Math.max(4, (c.amount / maxCat) * 100)}%` }} /></span>
                    <b>{yuan(c.amount)}</b>
                  </li>
                ))}
              </ul>
            )}
            {tip && tip.action && (
              <div className="pv3-box__tip">
                <i className={`pv3-dot is-${tip.tone}`} aria-hidden />
                <span>{tip.title}</span>
                <button type="button" className="pv3-pill" onClick={() => void run(tip, tip.action!)}>{tip.action.label}</button>
              </div>
            )}
          </section>

          <section className="pv3-box">
            <h2 className="pv3-box__title">{isZh ? '最近' : 'Recent'}</h2>
            {recent.length === 0 ? (
              <p className="pv3-box__empty">{isZh ? '还没有' : 'None yet'}</p>
            ) : (
              <ul className="pv3-list">
                {recent.map((r) => {
                  const income = baseType(r.type) === 'finance.income';
                  const label = String(r.data.merchant || '') || r.title.replace(/^(支出|收入)\s*/, '') || (isZh ? '一笔' : 'Item');
                  const method = typeof r.data.method === 'string' ? r.data.method : '';
                  return (
                    <li key={r.id}>
                      <ListIcon logo={brandLogo(String(r.data.merchant ?? ''))} fallback={rowIcon(r)} />
                      <span className="pv3-list__main">
                        <b>{label}</b>
                        <small>{when(r.occurred_at, isZh)}{method ? ` · ${method}` : ''}</small>
                      </span>
                      <span className={`pv3-list__amt${income ? ' is-in' : ''}`}>{yuan(income ? (r.value ?? 0) : -(r.value ?? 0), { sign: true })}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <div className="pv3-room__col">
          <section className="pv3-box">
            <h2 className="pv3-box__title">{isZh ? '家底' : 'Net worth'}</h2>
            <div className="pv3-networth">
              <div>
                <small>{isZh ? '净资产' : 'Net worth'}</small>
                <b>{yuan(m?.netWorth ?? null)}</b>
              </div>
              {m?.netWorthDelta30 != null && (
                <div className="pv3-networth__delta">
                  <small>{isZh ? '一个月' : '30 days'}</small>
                  <span className={m.netWorthDelta30 >= 0 ? 'is-up' : 'is-down'}>{yuan(m.netWorthDelta30, { sign: true })}</span>
                </div>
              )}
            </div>
            {(m?.accounts.length ?? 0) > 0 && (
              <ul className="pv3-list pv3-list--ruled">
                {m!.accounts.map((a) => (
                  <li key={a.name}>
                    <ListIcon logo={brandLogo(a.name)} fallback={accountIcon(a.kind, a.name)} />
                    <span className="pv3-list__main"><b>{a.name}</b>{a.kind ? <small>{(isZh ? KIND_ZH : KIND_EN)[a.kind] ?? a.kind}</small> : null}</span>
                    <span className="pv3-list__amt">{yuan(a.value)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="pv3-box">
            <h2 className="pv3-box__title">{isZh ? '每月自动扣' : 'Recurring'}</h2>
            {(m?.subscriptions.length ?? 0) === 0 ? (
              <p className="pv3-box__empty">{isZh ? '没看出有按月扣的' : 'No recurring charges found'}</p>
            ) : (
              <ul className="pv3-list pv3-list--ruled">
                {m!.subscriptions.map((s) => (
                  <li key={s.name}>
                    <ListIcon logo={brandLogo(s.name)} fallback={I.repeat} />
                    <span className="pv3-list__main"><b>{s.name}</b></span>
                    <span className="pv3-list__amt pv3-list__amt--stack">
                      {yuan(s.amount)}
                      <small>{isZh ? `下次 ${md(nextCharge(s.nextDay))}` : `Next ${md(nextCharge(s.nextDay))}`}</small>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="pv3-wide"
              onClick={() => void ask(isZh ? '看看我这个月的钱：花在哪、哪些能省、家底怎么样，给我几条建议' : 'Review my money this month: where it went, what to cut, and how my net worth is doing')}
            >
              {isZh ? '帮我理理财' : 'Help me sort my money'}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
};

export default PilotMoneyPage;
