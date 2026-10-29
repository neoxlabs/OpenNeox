import React, { useEffect, useMemo, useState } from 'react';
import { SPECIALISTS, briefEnabled, briefTimeOf } from '@neoxlabs/pilot-data-sdk';
import { useI18n } from '../../../hooks/useI18n';
import { deletePilotRecord, putPilotRecords, setPilotFact, usePilotFacts, usePilotRecords, type PilotRecordRow } from './pilotData';

interface ReminderRow { id: string; title: string; scheduledAt: number; ring?: boolean }
interface Api {
  pilotReminders?: (sessionId: string) => Promise<{ cloud: boolean; reminders: ReminderRow[] }>;
  pilotCancelReminder?: (id: string) => Promise<unknown>;
}
const api = (): Api => ((window as unknown as { neox?: Api }).neox ?? {});

const S = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const I = {
  sun: <svg {...S}><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></svg>,
  repeat: <svg {...S}><path d="M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4" /></svg>,
  pin: <svg {...S}><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.2" /></svg>,
  person: <svg {...S}><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>,
  cake: <svg {...S}><path d="M4 20h16M5 20v-6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6M12 12V8M12 5.5v.01" /></svg>,
  bell: <svg {...S}><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" /></svg>,
};

const WEEK_ZH = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WEEK_EN = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** 一条规则说成人话: 「每年 3 月 8 日 09:00」「每周日 20:00」「到了 公司」「见到 张姐」 */
function ruleWhen(d: Record<string, unknown>, zh: boolean): string {
  const time = typeof d.time === 'string' ? d.time : '09:00';
  const lead = typeof d.leadDays === 'number' && d.leadDays > 0 ? (zh ? ` · 提前 ${d.leadDays} 天` : ` · ${d.leadDays}d ahead`) : '';
  const date = String(d.date ?? '');
  switch (d.when) {
    case 'yearly': {
      const [m, day] = date.split('-').map(Number);
      return (zh ? `每年 ${m} 月 ${day} 日 ${time}` : `Every year ${m}/${day} ${time}`) + lead;
    }
    case 'date': return (zh ? `${date} ${time}` : `${date} ${time}`) + lead;
    case 'weekly': { const w = Number(d.weekday) || 1; return zh ? `每${WEEK_ZH[w]} ${time}` : `Every ${WEEK_EN[w]} ${time}`; }
    case 'place': return zh ? `${d.on === 'leave' ? '离开' : '到了'} ${String(d.place ?? '')}` : `${d.on === 'leave' ? 'Leaving' : 'Arriving at'} ${String(d.place ?? '')}`;
    case 'person': return zh ? `见到 ${String(d.who ?? '')}` : `Meeting ${String(d.who ?? '')}`;
    default: return '';
  }
}

function at(ms: number, zh: boolean): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return zh ? `今天 ${hm}` : `Today ${hm}`;
  if (diff === 1) return zh ? `明天 ${hm}` : `Tomorrow ${hm}`;
  return zh ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}` : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm}`;
}

const Switch: React.FC<{ on: boolean; label: string; onToggle: () => void; disabled?: boolean }> = ({ on, label, onToggle, disabled }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`pv3-switchbtn${on ? ' is-on' : ''}`} onClick={onToggle}><i /></button>
);

export const PilotAutoPage: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const { isZh } = useI18n();
  const facts = usePilotFacts();
  const rules = usePilotRecords(['trigger'], { limit: 100 });
  const [reminders, setReminders] = useState<ReminderRow[] | null>(null);
  /* 点了马上变, 回来的数再覆盖 (开关不等网络) */
  const [local, setLocal] = useState<Record<string, unknown>>({});
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) { setReminders([]); return; }
    let alive = true;
    void api().pilotReminders?.(sessionId).then((r) => { if (alive) setReminders(r?.reminders ?? []); }).catch(() => { if (alive) setReminders([]); });
    return () => { alive = false; };
  }, [sessionId]);

  const fact = useMemo(() => {
    const m: Record<string, unknown> = {};
    for (const f of facts.data?.facts ?? []) m[f.key] = f.value;
    return { ...m, ...local };
  }, [facts.data, local]);

  const toggleFact = async (key: string, on: boolean) => {
    setLocal((l) => ({ ...l, [key]: on ? 'on' : 'off' }));
    try { await setPilotFact(key, on ? 'on' : 'off'); } catch { setLocal((l) => { const n = { ...l }; delete n[key]; return n; }); }
  };

  const pauseRule = async (r: PilotRecordRow, paused: boolean) => {
    setLocal((l) => ({ ...l, [`rule:${r.id}`]: paused }));
    try {
      /* 沿用原来的时间 —— 按「现在」记的话列表按时间排, 一点开关这条就跳到最上面 */
      await putPilotRecords([{ type: 'trigger', occurred_at: r.occurred_at, source: 'desktop', supersedes: r.id, data: { ...r.data, paused } }]);
      rules.reload();
    } catch { setLocal((l) => { const n = { ...l }; delete n[`rule:${r.id}`]; return n; }); }
  };

  const removeRule = async (id: string) => {
    if (armed !== id) { setArmed(id); return; }
    setArmed(null);
    setGone((g) => new Set(g).add(id));
    await deletePilotRecord(id).catch(() => undefined);
    rules.reload();
  };

  const cancelReminder = async (id: string) => {
    if (armed !== id) { setArmed(id); return; }
    setArmed(null);
    setGone((g) => new Set(g).add(id));
    await api().pilotCancelReminder?.(id)?.catch?.(() => undefined);
  };

  const briefOn = briefEnabled(fact);
  const briefTime = briefTimeOf(fact);
  const scheduled = SPECIALISTS.filter((s) => s.schedule);
  const ruleRows = (rules.data?.records ?? []).filter((r) => !gone.has(r.id));
  const birthdays = Object.keys(fact).filter((k) => /^person\..+\.birthday$/.test(k)).length;
  const remRows = (reminders ?? []).filter((r) => !gone.has(r.id) && r.scheduledAt > Date.now() - 60_000).sort((a, b) => a.scheduledAt - b.scheduledAt);
  const loading = facts.loading && !facts.data;

  /* 删要点两下: 第一下变「再点一次删掉」 */
  const del = (id: string, kind: 'rule' | 'reminder') => (
    <button type="button" className={`pv3-connect__link${armed === id ? ' is-bad' : ''}`} onClick={() => void (kind === 'reminder' ? cancelReminder(id) : removeRule(id))} onBlur={() => setArmed((a) => (a === id ? null : a))}>
      {armed === id ? (isZh ? '再点一次删掉' : 'Click again') : (isZh ? '删除' : 'Delete')}
    </button>
  );

  return (
    <div className="pv3-room" data-loading={loading ? '' : undefined}>
      <header>
        <h1 className="pv3-pagehead">{isZh ? '自动化' : 'Automations'}</h1>
        <p className="pv3-pagesub">{isZh ? '到点、到地方它会自己动的，都在这。跟它说一句就能加一条' : 'Everything it does on its own, by time or place. Ask it to add one'}</p>
      </header>
      <div className="pv3-room__cols">
        <section className="pv3-box">
          <h2 className="pv3-box__title">{isZh ? '它定期替你做的' : 'On a schedule'}</h2>
          <ul className="pv3-list pv3-list--ruled">
            <li>
              <span className="pv3-list__ic">{I.sun}</span>
              <span className="pv3-list__main">
                <b>{isZh ? '早上简报' : 'Morning brief'}</b>
                <small>{isZh ? `每天 ${briefTime} · 今天的安排、夜里攒下的、该留意的` : `Daily ${briefTime} · today, overnight, what to watch`}</small>
              </span>
              <Switch on={briefOn} label={isZh ? '早上简报' : 'Morning brief'} disabled={loading} onToggle={() => void toggleFact('pilot.brief', !briefOn)} />
            </li>
            {scheduled.map((s) => {
              const key = `team.${s.id}`;
              const on = fact[key] !== 'off';
              const t = typeof fact[`${key}.time`] === 'string' ? String(fact[`${key}.time`]) : s.schedule!.time;
              return (
                <li key={s.id}>
                  <span className="pv3-list__ic">{I.repeat}</span>
                  <span className="pv3-list__main">
                    <b>{s.schedule!.label}</b>
                    <small>{s.name} · {t}</small>
                  </span>
                  <Switch on={on} label={s.schedule!.label} disabled={loading} onToggle={() => void toggleFact(key, !on)} />
                </li>
              );
            })}
          </ul>
        </section>
        <section className="pv3-box">
          <h2 className="pv3-box__title">{isZh ? '你让它记着的' : 'Rules you set'}</h2>
          {ruleRows.length === 0 && !rules.loading ? (
            <p className="pv3-box__empty">{isZh ? '还没有。跟它说「每周日晚上八点提醒我给爸妈打电话」「到了公司提醒我拿快递」' : 'None yet. Try "remind me to call my parents every Sunday 8pm"'}</p>
          ) : (
            <ul className="pv3-list pv3-list--ruled">
              {ruleRows.map((r) => {
                const paused = (local[`rule:${r.id}`] as boolean | undefined) ?? r.data.paused === true;
                const w = r.data.when;
                return (
                  <li key={r.id} className={paused ? 'is-paused' : undefined}>
                    <span className="pv3-list__ic">{w === 'place' ? I.pin : w === 'person' ? I.person : I.repeat}</span>
                    <span className="pv3-list__main">
                      <b>{String(r.data.text ?? r.title)}</b>
                      <small>{ruleWhen(r.data, isZh)}{paused ? (isZh ? ' · 已暂停' : ' · paused') : ''}</small>
                      {del(r.id, 'rule')}
                    </span>
                    <Switch on={!paused} label={String(r.data.text ?? r.title)} onToggle={() => void pauseRule(r, !paused)} />
                  </li>
                );
              })}
            </ul>
          )}
          {birthdays > 0 && (
            <p className="pv3-auto__note">{I.cake}<span>{isZh ? `${birthdays} 个人的生日会提前 3 天和当天提醒你（在「关系」里改）` : `${birthdays} birthdays: reminded 3 days ahead and on the day`}</span></p>
          )}
          <h3 className="pv3-connect__sub">{isZh ? '定好的提醒' : 'Reminders'}</h3>
          {reminders && remRows.length === 0 ? (
            <p className="pv3-box__empty">{isZh ? '没有挂着的提醒' : 'No reminders pending'}</p>
          ) : (
            <ul className="pv3-list pv3-list--ruled">
              {remRows.map((r) => (
                <li key={r.id}>
                  <span className="pv3-list__ic">{I.bell}</span>
                  <span className="pv3-list__main">
                    <b>{r.title}</b>
                    <small>{at(r.scheduledAt, isZh)}{r.ring ? (isZh ? ' · 到点打电话' : ' · call') : ''}</small>
                    {del(r.id, 'reminder')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};

export default PilotAutoPage;
