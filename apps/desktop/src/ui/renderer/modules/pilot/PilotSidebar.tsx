import React, { useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { PilotFace } from './PilotAvatar';
import { PilotCallSettings } from './PilotCallSettings';
import { usePilotReports } from './usePilotReports';
import type { CallLogEntry, PilotCall, PilotProfile } from './pilotStore';

export interface PilotContact {
  id: string;
  title: string;
  subtitle?: string;
  timeText?: string;
  ts?: number;
}

interface Props {
  contacts: PilotContact[];
  profiles: Record<string, PilotProfile>;
  activeId: string | null;
  runningIds: ReadonlySet<string> | string[];
  call: PilotCall | null;
  log: CallLogEntry[];
  onSelect: (id: string) => void;
  onNew: () => void;
}

const SEEN_KEY = 'neox-pilot-seen';
function lastSeen(id: string): number {
  try { return (JSON.parse(window.localStorage.getItem(SEEN_KEY) || '{}') as Record<string, number>)[id] ?? 0; } catch { return 0; }
}
export function markPilotSeen(id: string): void {
  try {
    const map = JSON.parse(window.localStorage.getItem(SEEN_KEY) || '{}') as Record<string, number>;
    map[id] = Date.now();
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(map));
  } catch { /* 记不住就一直显示未接, 无害 */ }
}

export const PilotRail: React.FC<Props> = ({ contacts, profiles, activeId, runningIds, call, log, onSelect, onNew }) => {
  const { isZh } = useI18n();
  const [menu, setMenu] = useState(false);
  const [callSettings, setCallSettings] = useState(false);
  const running = runningIds instanceof Set ? runningIds : new Set(runningIds);
  const reports = usePilotReports();
  /* 角标 = 没接的电话 + 没读的汇报 (正在看的那个不算) */
  const missedFor = (id: string) => {
    if (id === activeId) return 0;
    const seen = lastSeen(id);
    return log.filter((e) => e.sessionId === id && e.outcome === 'missed' && e.at > seen).length
      + reports.filter((r) => r.sessionId === id && !r.readAt).length;
  };

  return (
    <nav className="pilot-rail" aria-label="Pilots">
      <div className="pilot-rail__list">
        {contacts.map((c) => {
          const p = profiles[c.id];
          const name = p?.name || c.title || 'Pilot';
          const inCall = call?.sessionId === c.id ? (call.phase === 'ringing' ? 'ringing' : 'live') : null;
          const missed = missedFor(c.id);
          const busy = running.has(c.id);
          return (
            <button
              key={c.id}
              type="button"
              className={`pilot-rail__it${c.id === activeId ? ' is-active' : ''}`}
              title={p?.persona?.split('\n')[0] ? `${name} · ${p.persona.split('\n')[0]}` : name}
              onClick={() => { markPilotSeen(c.id); onSelect(c.id); }}
            >
              <span className="pilot-rail__face">
                <PilotFace kind={p?.avatar ?? 'cat'} size={40} ring={inCall} />
                {missed > 0
                  ? <span className="pilot-rail__badge" title={isZh ? '没接的电话 / 没看的汇报' : 'Missed calls / unread reports'}>{missed}</span>
                  : busy && <span className="pilot-rail__busy" title={isZh ? '在办事' : 'Working'} />}
              </span>
              <span className="pilot-rail__name">{name}</span>
            </button>
          );
        })}
        <button type="button" className="pilot-rail__new" onClick={onNew} title={isZh ? '新建 Pilot' : 'New Pilot'}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
        </button>
      </div>
      <div className="pilot-rail__menuwrap">
        <button
          type="button"
          className={`pilot-rail__tool${menu ? ' is-on' : ''}`}
          onClick={() => setMenu((v) => !v)}
          title={isZh ? '设置' : 'Settings'}
          aria-label={isZh ? '设置' : 'Settings'}
          aria-expanded={menu}
        >
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="10" cy="10" r="2.6" />
            <path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7" />
          </svg>
        </button>
        {menu && (
          <>
            <div className="pilot-rail__scrim" onMouseDown={() => setMenu(false)} />
            <div className="pilot-rail__menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenu(false); setCallSettings(true); }}>
                {isZh ? '来电设置' : 'Call settings'}
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenu(false); window.dispatchEvent(new CustomEvent('neox:open-settings')); }}>
                {isZh ? '全部设置' : 'All settings'}
              </button>
            </div>
          </>
        )}
      </div>
      {callSettings && <PilotCallSettings sessionId={activeId} onClose={() => setCallSettings(false)} />}
    </nav>
  );
};
