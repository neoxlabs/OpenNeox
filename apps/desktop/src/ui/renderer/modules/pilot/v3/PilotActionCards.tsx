import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { fileOf } from './brandLogos';

interface Card {
  id: string; title: string; summary: string; options: string[];
  action: { tool: 'computer' | 'phone'; action: string; preview: string } | null;
  actionState: string | null;
}
interface Api {
  pilotActions?: (sessionId: string) => Promise<Card[]>;
  pilotReportAnswer?: (id: string, answer: string) => Promise<unknown>;
  onPilotReportsChanged?: (cb: () => void) => () => void;
}
const api = (): Api => ((window as unknown as { neox?: Api }).neox ?? {});

const S = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const PHONE = <svg {...S}><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" /></svg>;
const SMS = <svg {...S}><path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17H11l-4 3v-3H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5Z" /></svg>;

export const PilotActionCards: React.FC<{ sessionId: string | null; visible: boolean }> = ({ sessionId, visible }) => {
  const { isZh } = useI18n();
  const [cards, setCards] = useState<Card[]>([]);
  const [busy, setBusy] = useState<Record<string, 'yes' | 'no'>>({});

  const load = useCallback(async () => {
    if (!sessionId || !api().pilotActions) return;
    try { setCards((await api().pilotActions!(sessionId)) ?? []); } catch { /* 拿不到就不摆 */ }
  }, [sessionId]);

  useEffect(() => {
    if (!visible) return;
    void load();
    /* 手机上点了 / 它挂了新卡: 看着对话时 5 秒一刷; 有卡在办时更勤一点 */
    const t = setInterval(() => { void load(); }, cards.some((c) => c.actionState === 'approved') ? 3_000 : 5_000);
    const off = api().onPilotReportsChanged?.(() => { void load(); });
    return () => { clearInterval(t); off?.(); };
  }, [visible, load, cards]);

  if (!visible || cards.length === 0) return null;

  const decide = async (c: Card, yes: boolean) => {
    setBusy((b) => ({ ...b, [c.id]: yes ? 'yes' : 'no' }));
    const opts = c.options.length ? c.options : ['批准', '不要'];
    await api().pilotReportAnswer?.(c.id, yes ? opts[0] : (opts[1] ?? '不要')).catch(() => null);
    if (!yes) setCards((list) => list.filter((x) => x.id !== c.id));
    void load();
  };

  return (
    <div className="pv3-acts" role="region" aria-label={isZh ? '等你点头' : 'Waiting for your OK'}>
      {cards.map((c) => {
        const a = c.action?.action ?? '';
        const logo = a === 'send_imessage' ? fileOf('mac-messages') : null;
        const doing = c.actionState === 'approved' || busy[c.id] === 'yes';
        return (
          <div key={c.id} className={`pv3-act${doing ? ' is-doing' : ''}`}>
            <span className={`pv3-act__ic${logo ? ' is-logo' : ''}`}>{logo ? <img src={logo} alt="" /> : a === 'phone_call' ? PHONE : SMS}</span>
            <div className="pv3-act__body">
              <b>{c.title}</b>
              {c.summary && <p>{c.summary}</p>}
            </div>
            {doing ? (
              <span className="pv3-act__state">{isZh ? '正在办…' : 'Doing it…'}</span>
            ) : (
              <div className="pv3-act__btns">
                <button type="button" className="pv3-act__no" disabled={!!busy[c.id]} onClick={() => void decide(c, false)}>{isZh ? '不要' : 'No'}</button>
                <button type="button" className="pv3-act__yes" disabled={!!busy[c.id]} onClick={() => void decide(c, true)}>{isZh ? '批准' : 'Approve'}</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default PilotActionCards;
