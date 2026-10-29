/**
 * Pilot · 生活 (稿 pl6)。家、车、账单 —— 到期之前它会提醒; 下面一条「关于你」是它记得的你。
 *
 *   账单: 这期各项 (电 / 水 / 燃气 / 宽带 …) + 到期日, 没交的标出来 · 问问为啥这么贵
 *   车:   每辆车的年检 / 保险 / 保养, 还剩几天, 过了标红 · 帮我办
 *   家:   城市 + 地址 · 跟它说家在哪
 *   关于你: 档案里 me.* 那些 (工作 / 口味 / 证件 …) · 它还该知道什么
 */
import React, { useEffect, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { dispatchHint, dispatchOpFailed } from '../../../components/notifyEvents';
import { useAgenda } from '../board/AgendaSection';
import { usePilotOverview, yuan } from './pilotData';
import { useInsightRunner } from './useInsightRunner';
import lifeBill from '../../../media/pilot/life-bill.webp';
import lifeCar from '../../../media/pilot/life-car.webp';
import lifeHouse from '../../../media/pilot/life-house.webp';
import lookPlain from '../../../media/pilot/look-plain.webp';

const S = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const I = {
  bolt: <svg {...S}><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" /></svg>,
  drop: <svg {...S}><path d="M12 3.5s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" /></svg>,
  flame: <svg {...S}><path d="M12 21a6 6 0 0 0 6-6c0-4-3.5-6-3.5-10-2 1.5-3 3.5-3 5.5C10 9.5 9 8.5 9 7c-2 2-3 4.5-3 8a6 6 0 0 0 6 6Z" /></svg>,
  wifi: <svg {...S}><path d="M3.5 9.5a12 12 0 0 1 17 0M6.5 12.5a7.5 7.5 0 0 1 11 0M9.5 15.5a3.2 3.2 0 0 1 5 0M12 18.5h.01" /></svg>,
  bill: <svg {...S}><path d="M6 3.5h12v17l-3-1.5-3 1.5-3-1.5-3 1.5zM9 8h6M9 11.5h6" /></svg>,
  cal: <svg {...S}><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 9.5h16M8.5 3v4M15.5 3v4" /></svg>,
  wrench: <svg {...S}><path d="M14.5 5.5a4 4 0 0 0 4.9 4.9L20.5 12l-8 8a2.1 2.1 0 0 1-3-3l8-8-1.1-1.1a4 4 0 0 0-1.9-2.4" /></svg>,
  pin: <svg {...S}><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.2" /></svg>,
  food: <svg {...S}><path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 21V3c-2 1.5-3 4-3 7v3h3" /></svg>,
  job: <svg {...S}><rect x="3.5" y="7" width="17" height="12" rx="2" /><path d="M9 7V5h6v2" /></svg>,
  moon: <svg {...S}><path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z" /></svg>,
  target: <svg {...S}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r=".8" /></svg>,
  card: <svg {...S}><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><circle cx="8.5" cy="12" r="2" /><path d="M13 10.5h4.5M13 13.5h3" /></svg>,
  dot: <svg {...S}><circle cx="12" cy="12" r="2" /></svg>,
  walk: <svg {...S}><circle cx="13" cy="4.5" r="1.8" /><path d="M10.5 21l2-6 3 3v3M9 12l2-4 4 2.5 3 1M11 8l-3 1-1.5 3.5" /></svg>,
};
const BILL_ICON: Record<string, React.ReactNode> = { electric: I.bolt, water: I.drop, gas: I.flame, internet: I.wifi };

/** 档案里关于你的那几条 → 图标 + 一个词; 不认识的 key 去掉 me. 前缀照写 */
function factMeta(key: string, zh: boolean): { icon: React.ReactNode; label: string } {
  const k = key.replace(/^me\./, '');
  if (/food|taste|口味/.test(k)) return { icon: I.food, label: zh ? '口味' : 'Taste' };
  if (/^likes/.test(k)) return { icon: I.food, label: zh ? '喜欢' : 'Likes' };
  if (/job|work|title/.test(k)) return { icon: I.job, label: zh ? '工作' : 'Work' };
  if (/sleep|作息/.test(k)) return { icon: I.moon, label: zh ? '作息' : 'Sleep' };
  if (/goal|目标/.test(k)) return { icon: I.target, label: zh ? '目标' : 'Goal' };
  if (/passport/.test(k)) return { icon: I.card, label: zh ? '护照到期' : 'Passport expires' };
  if (/birthday/.test(k)) return { icon: I.cal, label: zh ? '生日' : 'Birthday' };
  return { icon: I.dot, label: k };
}

const md = (day: string) => day.slice(5).replace('-', '/');

interface Props {
  sessionId: string | null;
  onGoChat: () => void;
}

export const PilotLifePage: React.FC<Props> = ({ sessionId, onGoChat }) => {
  const { isZh } = useI18n();
  const { data } = usePilotOverview();
  const { ask, runtime } = useInsightRunner(sessionId, onGoChat);
  const agenda = useAgenda(sessionId, 0);
  const walkRow = agenda.rows.find((r) => /下楼走走|散步|walk/i.test(r.title));
  const [walkPending, setWalkPending] = useState<boolean | null>(null);
  const [walkBusy, setWalkBusy] = useState(false);
  const walkOn = walkPending ?? !!walkRow;
  const toggleWalk = async () => {
    if (!sessionId || walkBusy) return;
    setWalkBusy(true);
    try {
      if (walkRow) {
        setWalkPending(false);
        await agenda.cancel(walkRow.id);
        dispatchHint(isZh ? '好，不再叫你下楼走走' : 'Walk reminder off', 'success');
      } else {
        /* 账本的加提醒接口只能一次性的; 每天重复的交给它用自己的提醒工具设 (它会回一句设好了) */
        setWalkPending(true);
        await runtime?.sendPrompt?.(isZh
          ? '帮我设一个每天重复的提醒：每天下午 5 点叫我下楼走走，标题写「下楼走走」，到点打电话。设好回一句就行。'
          : 'Set a daily repeating reminder at 5pm titled "Take a walk" that calls me. Just confirm when done.');
        dispatchHint(isZh ? '交给它设了，每天 5 点叫你' : 'Asked it to set a daily 5pm reminder', 'success');
      }
    } catch (e) {
      setWalkPending(null);
      dispatchOpFailed({ op: isZh ? '下楼走走' : 'Walk reminder', message: (e as Error).message });
    } finally {
      setWalkBusy(false);
    }
  };
  /* 提醒单刷出来以后以它为准 */
  useEffect(() => { setWalkPending(null); }, [walkRow?.id]);
  const h = data?.rooms.home;
  const facts = (data?.rooms.me?.facts ?? []).filter((f) => !/^me\.(name|nickname)$/.test(f.key)).slice(0, 6);
  const bills = h?.bills ?? [];
  const unpaid = bills.filter((b) => b.paid === false);
  const priciest = [...bills].sort((a, b) => b.amount - a.amount)[0];

  return (
    <div className="pv3-room" data-loading={data ? undefined : ''}>
      <header>
        <h1 className="pv3-pagehead">{isZh ? '生活' : 'Life'}</h1>
        <p className="pv3-pagesub">{isZh ? '家、车、账单 —— 到期之前它会提醒' : 'Home, car, bills — it reminds you before anything is due'}</p>
      </header>

      <div className="pv3-life">
        <section className="pv3-box pv3-life__card">
          <div className="pv3-life__head"><img src={lifeBill} alt="" draggable={false} /><h2>{isZh ? '账单' : 'Bills'}</h2></div>
          {bills.length === 0 ? (
            <p className="pv3-box__empty">{isZh ? '把账单截图发给它，就记在这里' : 'Send it a screenshot of a bill to track it here'}</p>
          ) : (
            <ul className="pv3-life__rows">
              {bills.map((b) => (
                <li key={b.kind}>
                  <span className="pv3-life__ic">{BILL_ICON[b.kind] ?? I.bill}</span>
                  <span className="pv3-life__what">{b.label}<small> · {isZh ? `${Number(b.period.slice(5))}月` : b.period}</small></span>
                  <span className="pv3-life__val">
                    {yuan(b.amount)}
                    {b.paid === false && b.due && <em>{isZh ? `${md(b.due)} 前交` : `due ${md(b.due)}`}</em>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {priciest && (
            <button
              type="button"
              className="pv3-pill pv3-pill--soft pv3-life__act"
              onClick={() => void ask(isZh
                ? `看看我这期的账单${unpaid.length ? `（还有 ${unpaid.length} 项没交）` : ''}，${priciest.label} ${yuan(priciest.amount)} 是不是偏贵，怎么省`
                : `Look at my bills — is ${priciest.label} at ${yuan(priciest.amount)} high, and how can I cut it?`)}
            >
              {isZh ? '问问为啥这么贵' : 'Why so high?'}
            </button>
          )}
        </section>

        <section className="pv3-box pv3-life__card">
          {(h?.vehicles.length ?? 0) === 0 ? (
            <>
              <div className="pv3-life__head"><img src={lifeCar} alt="" draggable={false} /><h2>{isZh ? '车' : 'Car'}</h2></div>
              <p className="pv3-box__empty">{isZh ? '告诉它你开什么车，年检保险它来盯' : 'Tell it about your car and it tracks inspection and insurance'}</p>
            </>
          ) : h!.vehicles.map((v) => {
            const urgent = [...v.items].sort((a, b) => a.days - b.days)[0];
            return (
              <React.Fragment key={v.name}>
                <div className="pv3-life__head"><img src={lifeCar} alt="" draggable={false} /><h2>{v.name}{v.model ? <small> · {v.model}</small> : null}</h2></div>
                <ul className="pv3-life__rows">
                  {v.items.map((it) => (
                    <li key={it.what}>
                      <span className="pv3-life__ic">{/保养|维修/.test(it.what) ? I.wrench : I.cal}</span>
                      <span className="pv3-life__what">{it.what}<small> · {it.due}</small></span>
                      <span className={`pv3-life__val${it.days < 0 ? ' is-late' : it.days <= 30 ? ' is-soon' : ''}`}>
                        {it.days < 0 ? (isZh ? '已过期' : 'Overdue') : isZh ? `${it.days} 天` : `${it.days}d`}
                      </span>
                    </li>
                  ))}
                </ul>
                {urgent && (
                  <button
                    type="button"
                    className={`pv3-life__act ${urgent.days <= 30 ? 'pv3-drawer__save' : 'pv3-pill pv3-pill--soft'}`}
                    onClick={() => void ask(isZh
                      ? `我的车${v.model ? `（${v.model}）` : ''}${urgent.what} ${urgent.due} 到期，帮我看看怎么办最省事，要准备什么`
                      : `My car's ${urgent.what} is due ${urgent.due} — what's the easiest way to get it done?`)}
                  >
                    {isZh ? `帮我办${urgent.what}` : `Handle ${urgent.what}`}
                  </button>
                )}
              </React.Fragment>
            );
          })}
        </section>

        <section className="pv3-box pv3-life__card">
          <div className="pv3-life__head"><img src={lifeHouse} alt="" draggable={false} /><h2>{isZh ? '家' : 'Home'}</h2></div>
          <ul className="pv3-life__rows">
            <li>
              <span className="pv3-life__ic">{I.pin}</span>
              <span className="pv3-life__what">{h?.city || h?.address ? [h.city, h.address].filter(Boolean).join(' · ') : (isZh ? '还不知道家在哪' : 'Home not set yet')}</span>
            </li>
            {/* 稿 pl6: 「下午 5 点叫你下楼走走」—— 开 = 交给它设一条每天重复的提醒, 关 = 把那条取消; 开没开看提醒单里有没有它 */}
            <li>
              <span className="pv3-life__ic">{I.walk}</span>
              <span className="pv3-life__what">{isZh ? '每天下午 5 点叫你下楼走走' : 'Walk reminder at 5pm daily'}</span>
              <button
                type="button"
                role="switch"
                aria-checked={walkOn}
                disabled={!sessionId || walkBusy}
                className={`pv3-switchbtn${walkOn ? ' is-on' : ''}`}
                onClick={() => void toggleWalk()}
              ><i /></button>
            </li>
            {h && h.monthBills > 0 && (
              <li>
                <span className="pv3-life__ic">{I.bill}</span>
                <span className="pv3-life__what">{isZh ? '这个月家里的账单' : 'Household bills this month'}</span>
                <span className="pv3-life__val">{yuan(h.monthBills)}</span>
              </li>
            )}
          </ul>
          <button
            type="button"
            className="pv3-pill pv3-pill--soft pv3-life__act"
            onClick={() => void ask(isZh ? '我想告诉你我家在哪，你记一下（我接着说地址）' : "I'll tell you where home is — please remember it")}
          >
            {isZh ? '改家的位置' : 'Change home'}
          </button>
        </section>
      </div>

      <section className="pv3-box pv3-aboutme">
        <img src={lookPlain} alt="" draggable={false} />
        <div className="pv3-aboutme__body">
          <h2>{isZh ? '关于你' : 'About you'}</h2>
          {facts.length === 0 ? (
            <p className="pv3-box__empty">{isZh ? '多跟它聊聊，它会慢慢记住你的口味、作息和在忙的事' : 'Chat with it and it will remember your tastes, routine and what you are working on'}</p>
          ) : (
            <ul>
              {facts.map((f) => {
                const m = factMeta(f.key, isZh);
                return <li key={f.key}>{m.icon}<small>{m.label}</small><span>{f.value}</span></li>;
              })}
            </ul>
          )}
        </div>
        <button type="button" className="pv3-pill pv3-pill--soft" onClick={() => void ask(isZh ? '你还想知道我哪些事？问我几个问题，我答了你记下来' : 'What else should you know about me? Ask me a few questions and remember my answers')}>
          {isZh ? '它还该知道什么' : 'What else should it know'}
        </button>
      </section>
    </div>
  );
};

export default PilotLifePage;
