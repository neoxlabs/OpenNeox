/**
 * 通话 —— 你打给它 / 它打给你的记录。连着几次一样的合成一行 (以前三行「你打给它」一模一样),
 * 点开看结果、时长、它为什么打来; 「打给它」随时回拨。
 */
import React, { useMemo, useState } from 'react';
import { StageIcon } from '../stage/StageCards';
import { formatSessionTime } from '../../../app/sessionItemMapping';
import { pilotApi, type CallLogEntry } from '../pilotStore';
import { SectionHead } from './boardKit';
import { ART } from './art';

const OUTCOME: Record<CallLogEntry['outcome'], { zh: string; en: string }> = {
  answered: { zh: '已接通', en: 'Answered' },
  declined: { zh: '已拒接', en: 'Declined' },
  missed: { zh: '未接', en: 'Missed' },
  busy: { zh: '没打 · 你在忙', en: 'Held · busy' },
  blocked: { zh: '没打', en: 'Not placed' },
  snoozed: { zh: '稍后再打', en: 'Snoozed' },
};

interface Group { key: string; first: CallLogEntry; items: CallLogEntry[] }

function groupCalls(calls: CallLogEntry[]): Group[] {
  const out: Group[] = [];
  for (const c of calls) {
    const sig = `${c.direction}|${c.reason}|${c.outcome}`;
    const last = out[out.length - 1];
    if (last && `${last.first.direction}|${last.first.reason}|${last.first.outcome}` === sig) last.items.push(c);
    else out.push({ key: c.id, first: c, items: [c] });
  }
  return out;
}

function fmtDuration(ms: number | undefined, isZh: boolean): string {
  if (!ms || ms < 1000) return '';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return isZh ? (m ? `${m} 分 ${s % 60} 秒` : `${s} 秒`) : (m ? `${m}m ${s % 60}s` : `${s}s`);
}

export const CallsSection: React.FC<{ sessionId: string | null; log: CallLogEntry[]; isZh: boolean }> = ({ sessionId, log, isZh }) => {
  const t = (zh: string, en: string) => (isZh ? zh : en);
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => groupCalls(log.filter((e) => e.sessionId === sessionId).slice(0, 20)).slice(0, 5), [log, sessionId]);
  if (!sessionId) return null;
  const callNow = () => { void pilotApi().pilotCallStartOutgoing?.(sessionId); };

  return (
    <section className="pb-sec is-calls">
      <SectionHead
        art={ART.calls}
        title={t('通话', 'Calls')}
        action={{ label: t('打给它', 'Call it'), icon: <StageIcon name="phone" size={13} />, onClick: callNow }}
      />
      {groups.map((g) => {
        const c = g.first;
        const isOpen = open === g.key;
        const tone = c.outcome === 'missed' || c.outcome === 'declined' ? ' is-bad' : c.outcome === 'answered' ? ' is-ok' : '';
        return (
          <div key={g.key} className={`pb-call${tone}${isOpen ? ' is-open' : ''}`}>
            <button type="button" className="pb-call__row" onClick={() => setOpen(isOpen ? null : g.key)} aria-expanded={isOpen}>
              <span className="pb-call__icon" aria-hidden><StageIcon name="phone" size={13} /></span>
              <span className="pb-call__what">
                {c.direction === 'outgoing' ? t('你打给它', 'You called') : (c.reason || t('它打给你', 'It called you'))}
              </span>
              {g.items.length > 1 && <span className="pb-report__times">×{g.items.length}</span>}
              <span className="pb-report__meta">{formatSessionTime(c.at)}</span>
            </button>
            {isOpen && (
              <div className="pb-call__body">
                {g.items.map((it) => (
                  <div key={it.id} className="pb-call__line">
                    <span>{new Date(it.at).toLocaleString(isZh ? 'zh-CN' : undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                    <span>{isZh ? OUTCOME[it.outcome].zh : OUTCOME[it.outcome].en}</span>
                    {fmtDuration(it.durationMs, isZh) && <span>{fmtDuration(it.durationMs, isZh)}</span>}
                    {it.detail && <span className="pb-call__detail">{it.detail}</span>}
                  </div>
                ))}
                <div className="pb-form__row pb-form__row--start">
                  <button type="button" className="pb-btn pb-btn--primary" onClick={callNow}>
                    <StageIcon name="phone" size={13} />{t('打给它', 'Call it')}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
};
