import React, { useMemo, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { usePilotReports } from '../usePilotReports';
import { useAgenda } from '../board/AgendaSection';
import { usePilotRecords } from './pilotData';

const api = () => (window as unknown as { neox?: { pilotReportAnswer?: (id: string, a: string) => Promise<unknown> } }).neox ?? {};

function hm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const PilotBrief: React.FC<{ sessionId: string | null; onGoChat: () => void }> = ({ sessionId, onGoChat }) => {
  const { isZh } = useI18n();
  const reports = usePilotReports();
  const { rows } = useAgenda(sessionId, 0);
  const [answered, setAnswered] = useState<Record<string, string>>({});

  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = dayStart + 86_400_000;
  const events = usePilotRecords(['event.calendar'], { from: dayStart, limit: 30 });

  const mine = (r: { sessionId: string | null }) => !sessionId || !r.sessionId || r.sessionId === sessionId;
  const waiting = reports.filter((r) => mine(r) && r.status === 'blocked' && !r.answer && !answered[r.id]).slice(0, 4);
  const done = reports.filter((r) => mine(r) && r.status === 'done' && r.at >= Date.now() - 86_400_000).slice(0, 4);

  const agenda = useMemo(() => {
    const list: Array<{ key: string; at: number; title: string; kind: 'event' | 'remind' }> = [];
    for (const e of events.data?.records ?? []) {
      if (e.occurred_at >= dayStart && e.occurred_at < dayEnd) list.push({ key: e.id, at: e.occurred_at, title: String(e.data.title ?? e.title), kind: 'event' });
    }
    for (const r of rows) {
      const at = r.scheduledAt ?? 0;
      if (at >= Date.now() - 60_000 && at < dayEnd) list.push({ key: r.id, at, title: r.title, kind: 'remind' });
    }
    return list.sort((a, b) => a.at - b.at).slice(0, 6);
  }, [events.data, rows, dayStart, dayEnd]);

  const answer = async (id: string, a: string) => {
    setAnswered((m) => ({ ...m, [id]: a }));
    await api().pilotReportAnswer?.(id, a)?.catch?.(() => null);
  };

  return (
    <div className="pv3-brief">
      <section className="pv3-brief__col">
        <h3>{isZh ? '等你点头' : 'Waiting for you'}{waiting.length > 0 && <i>{waiting.length}</i>}</h3>
        {waiting.length === 0 ? (
          <p className="pv3-brief__empty">{isZh ? '没有要你拍板的' : 'Nothing to decide'}</p>
        ) : (
          <ul>
            {waiting.map((r) => {
              const opts = (r.options?.length ? r.options : [isZh ? '好' : 'OK']).slice(0, 2);
              return (
                <li key={r.id}>
                  <b>{r.title}</b>
                  {r.summary && <span>{r.summary}</span>}
                  <div className="pv3-brief__btns">
                    {opts.map((o, i) => (
                      <button key={o} type="button" className={i === 0 ? 'is-main' : undefined} onClick={() => void answer(r.id, o)}>{o}</button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="pv3-brief__col">
        <h3>{isZh ? '它办了' : 'Done for you'}</h3>
        {done.length === 0 ? (
          <p className="pv3-brief__empty">{isZh ? '今天还没办什么' : 'Nothing yet today'}</p>
        ) : (
          <ul>
            {done.map((r) => (
              <li key={r.id}>
                <b>{r.title}</b>
                <span>{hm(r.at)}{r.summary ? ` · ${r.summary}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="pv3-brief__col">
        <h3>{isZh ? '今天安排' : 'Today'}</h3>
        {agenda.length === 0 ? (
          <p className="pv3-brief__empty">
            {isZh ? '今天没排什么。' : 'Nothing scheduled. '}
            <button type="button" className="pv3-connect__link" onClick={onGoChat}>{isZh ? '跟它说一句' : 'Tell it'}</button>
          </p>
        ) : (
          <ul>
            {agenda.map((a) => (
              <li key={a.key} className="pv3-brief__agenda">
                <time>{hm(a.at)}</time>
                <b>{a.title}</b>
                {a.kind === 'remind' && <em>{isZh ? '提醒' : 'reminder'}</em>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

export default PilotBrief;
