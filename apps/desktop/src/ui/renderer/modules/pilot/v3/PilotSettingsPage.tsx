/**
 * Pilot · 设置 (稿 pl9 右栏): 通话记录 + 通话设置。
 * 通话中那块 (猫拿着电话 / 波形 / 挂断) 是单独的通话窗, 不在这页; 这页看打过哪些、改什么时候能打给你。
 * 原来左栏齿轮打开的来电设置 (PilotCallSettings) 从这里进。
 */
import React, { useEffect, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { PilotCallSettings } from '../PilotCallSettings';
import { usePilotState, type CallLogEntry } from '../pilotStore';

interface CallSettings {
  pilot: { maxUnaskedPerHour?: number; ringSeconds?: number };
  quietHours: { enabled: boolean; start: string; end: string };
}
const api = () => (window as unknown as { neox?: { pilotGetSettings?: () => Promise<CallSettings> } }).neox ?? {};

const S = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const PHONE = 'M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z';
const I = {
  in: <svg {...S}><path d={PHONE} /><path d="M20 4l-5 5M15 5v4h4" /></svg>,
  out: <svg {...S}><path d={PHONE} /><path d="M15 9l5-5M16 4h4v4" /></svg>,
  miss: <svg {...S}><path d={PHONE} /><path d="M15 4l5 5M20 4l-5 5" /></svg>,
  moon: <svg {...S}><path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z" /></svg>,
  bell: <svg {...S}><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" /></svg>,
  clock: <svg {...S}><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 2" /></svg>,
};

function when(ms: number, zh: boolean): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.floor((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (diff === 0) return zh ? `今天 ${hm}` : `Today ${hm}`;
  if (diff === 1) return zh ? `昨天 ${hm}` : `Yesterday ${hm}`;
  return zh ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}` : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm}`;
}
function duration(ms: number, zh: boolean): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return zh ? `${s} 秒` : `${s}s`;
  return zh ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
function outcomeText(e: CallLogEntry, zh: boolean): { text: string; bad: boolean } {
  if (e.outcome === 'answered') return { text: e.durationMs ? duration(e.durationMs, zh) : (zh ? '接了' : 'Answered'), bad: false };
  const map: Record<string, [string, string]> = {
    declined: ['你挂了', 'Declined'], missed: ['未接', 'Missed'], busy: ['你在忙，没打', 'Held: busy'],
    blocked: ['没打出去', 'Not placed'], snoozed: ['稍后再打', 'Snoozed'],
  };
  const [z, en] = map[e.outcome] ?? [e.outcome, e.outcome];
  return { text: zh ? z : en, bad: e.outcome === 'missed' || e.outcome === 'declined' };
}

export const PilotSettingsPage: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const { isZh } = useI18n();
  const { log } = usePilotState();
  const [s, setS] = useState<CallSettings | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { void api().pilotGetSettings?.().then((v) => setS(v ?? null)).catch(() => {}); }, [open]);
  const rows = [...log].sort((a, b) => b.at - a.at).slice(0, 30);

  return (
    <div className="pv3-room">
      <header>
        <h1 className="pv3-pagehead">{isZh ? '设置' : 'Settings'}</h1>
        <p className="pv3-pagesub">{isZh ? '它什么时候能打给你，打过哪些' : 'When it may call you, and the calls so far'}</p>
      </header>
      <div className="pv3-room__cols">
        <section className="pv3-box">
          <h2 className="pv3-box__title">{isZh ? '通话记录' : 'Calls'}</h2>
          {rows.length === 0 ? (
            <p className="pv3-box__empty">{isZh ? '还没打过电话。跟它说「明早八点叫我」试试' : 'No calls yet. Try "call me at 8am tomorrow"'}</p>
          ) : (
            <ul className="pv3-list pv3-list--ruled">
              {rows.map((e) => {
                const o = outcomeText(e, isZh);
                return (
                  <li key={e.id}>
                    <span className={`pv3-list__ic${o.bad ? ' is-bad' : ''}`}>{o.bad ? I.miss : e.direction === 'incoming' ? I.in : I.out}</span>
                    <span className="pv3-list__main">
                      <b>{when(e.at, isZh)} · {e.pilotName}</b>
                      <small>{e.reason || (e.direction === 'outgoing' ? (isZh ? '你打给它' : 'You called') : (isZh ? '它打给你' : 'It called'))}</small>
                    </span>
                    <span className={`pv3-list__amt pv3-list__amt--small${o.bad ? ' is-bad' : ''}`}>{o.text}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="pv3-box">
          <h2 className="pv3-box__title">{isZh ? '通话设置' : 'Call settings'}</h2>
          <ul className="pv3-list pv3-list--ruled">
            <li>
              <span className="pv3-list__ic">{I.moon}</span>
              <span className="pv3-list__main">
                <b>{isZh ? '勿扰' : 'Quiet hours'}</b>
                <small>{s ? (s.quietHours.enabled ? `${s.quietHours.start} – ${s.quietHours.end}` : (isZh ? '没开' : 'Off')) : '—'}</small>
              </span>
            </li>
            <li>
              <span className="pv3-list__ic">{I.bell}</span>
              <span className="pv3-list__main">
                <b>{isZh ? '没让它打的，每小时最多' : 'Unasked calls per hour'}</b>
                {/* 没设过就是默认值 (跟 PilotCallSettings 的 Stepper 同一个: 3 次 / 25 秒) */}
                <small>{s ? (isZh ? `${s.pilot.maxUnaskedPerHour ?? 3} 次` : `${s.pilot.maxUnaskedPerHour ?? 3}`) : '—'}</small>
              </span>
            </li>
            <li>
              <span className="pv3-list__ic">{I.clock}</span>
              <span className="pv3-list__main">
                <b>{isZh ? '响多久' : 'Ring for'}</b>
                <small>{s ? (isZh ? `${s.pilot.ringSeconds ?? 25} 秒` : `${s.pilot.ringSeconds ?? 25}s`) : '—'}</small>
              </span>
            </li>
          </ul>
          <button type="button" className="pv3-wide" onClick={() => setOpen(true)}>{isZh ? '改通话设置 · 试打一下' : 'Edit · test call'}</button>
        </section>
      </div>
      {open && <PilotCallSettings sessionId={sessionId} onClose={() => setOpen(false)} />}
    </div>
  );
};

export default PilotSettingsPage;
