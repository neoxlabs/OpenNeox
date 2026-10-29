import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSessionGlance } from './useSessionGlance';
import type { WorkbenchSession } from './SidebarWorkbench';
import clayNewchatArt from '../../media/clay/newchat-art.webp';
import projRocket from '../../media/clay/proj-rocket.webp';
import projCube from '../../media/clay/proj-cube.webp';
import projLeaf from '../../media/clay/proj-leaf.webp';
import projGear from '../../media/clay/proj-gear.webp';
import projCup from '../../media/clay/proj-cup.webp';
import projPlanet from '../../media/clay/proj-planet.webp';
import projBulb from '../../media/clay/proj-bulb.webp';
import projBox from '../../media/clay/proj-box.webp';
import './session-overview.css';

export interface OverviewGroup { key: string; name: string; sessions: WorkbenchSession[] }

interface Props {
  groups: OverviewGroup[];
  activeSessionId?: string | null;
  isRunning: (id: string) => boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  zh: boolean;
}

const CARD_LIMIT = 90;
const DAY = 86_400_000;
const WEEKS = 12;

const HUES = ['#c96f45', '#5b9a76', '#4a7fc0', '#c2923a', '#8467bd', '#be5a76', '#3d949d', '#7b8746'];
const EMBLEMS = [projRocket, projCube, projLeaf, projGear, projCup, projPlanet, projBulb, projBox];
function hashOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}
function hueOf(name: string): string { return HUES[hashOf(name) % HUES.length]; }
/* 徽记跟颜色错开取 (除以颜色数再取), 不然同色的永远同一个物件 */
function emblemOf(name: string): string { return EMBLEMS[Math.floor(hashOf(name) / HUES.length) % EMBLEMS.length]; }

const Monogram: React.FC<{ name: string; size?: 'lg' | 'sm' }> = ({ name, size = 'lg' }) => (
  <span className={`neox-ov-mono is-${size}`} style={{ ['--hue' as string]: hueOf(name) }} aria-hidden="true">
    <img src={emblemOf(name)} alt="" draggable={false} />
  </span>
);

/* 12 周活跃条: 每周开了几个会话 */
const Spark: React.FC<{ sessions: WorkbenchSession[]; hue: string }> = ({ sessions, hue }) => {
  const now = Date.now();
  const buckets = new Array(WEEKS).fill(0) as number[];
  for (const s of sessions) {
    const w = Math.floor((now - (s.ts ?? 0)) / (7 * DAY));
    if (w >= 0 && w < WEEKS) buckets[WEEKS - 1 - w]++;
  }
  const max = Math.max(1, ...buckets);
  /* 只在真有起伏时画 (至少两周有会话); 一根孤柱 + 一排空位看着像虚线, 不如不画 */
  if (buckets.filter((n) => n > 0).length < 2) return null;
  return (
    <span className="neox-ov-spark" style={{ ['--hue' as string]: hue }} aria-hidden="true">
      {buckets.map((n, i) => <i key={i} className={n === 0 ? 'is-empty' : undefined} style={n === 0 ? undefined : { height: `${5 + (n / max) * 15}px` }} />)}
    </span>
  );
};

export const SessionOverview: React.FC<Props> = ({ groups, activeSessionId, isRunning, onSelect, onClose, zh }) => {
  const [query, setQuery] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const [closing, setClosing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const now = Date.now();
  const total = groups.reduce((n, g) => n + g.sessions.length, 0);
  const latest = (g: OverviewGroup) => g.sessions[0]?.ts ?? 0;
  const sortedGroups = useMemo(() => [...groups].sort((a, b) => latest(b) - latest(a)), [groups]);
  const hot = sortedGroups.filter((g) => now - latest(g) < 14 * DAY);
  const cold = sortedGroups.filter((g) => now - latest(g) >= 14 * DAY);
  const weekCount = groups.reduce((n, g) => n + g.sessions.filter((s) => now - (s.ts ?? 0) < 7 * DAY).length, 0);

  const q = query.trim().toLowerCase();
  const openGroup = openKey ? groups.find((g) => g.key === openKey) : undefined;

  /* 现在墙上是什么: 搜索结果 / 某个项目的会话 (卡) / 项目 (大卡 + 小块) */
  const cards: Array<WorkbenchSession & { groupName?: string }> | null = useMemo(() => {
    if (q) {
      const out: Array<WorkbenchSession & { groupName?: string }> = [];
      for (const g of groups) {
        const gm = g.name.toLowerCase().includes(q);
        for (const s of g.sessions) if (gm || s.title.toLowerCase().includes(q)) out.push({ ...s, groupName: g.name });
      }
      return out.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, CARD_LIMIT);
    }
    if (openGroup) return openGroup.sessions.slice(0, CARD_LIMIT);
    return null;
  }, [q, openGroup, groups]);

  const projectOrder = [...hot, ...cold];
  const itemCount = cards ? cards.length : projectOrder.length;

  const glanceIds = useMemo(() => (cards
    ? cards.map((c) => c.id)
    : hot.flatMap((g) => g.sessions.slice(0, 3).map((s) => s.id))).slice(0, 160),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [cards, groups]);
  const glance = useSessionGlance(glanceIds);
  const statusOf = (id: string) => (isRunning(id) ? 'running' : glance[id]?.waiting ? 'waiting' : '');
  const runningCount = groups.reduce((n, g) => n + g.sessions.filter((s) => isRunning(s.id)).length, 0);
  const waitingCount = Object.values(glance).filter((g) => g.waiting && now - g.lastTs < 7 * DAY).length;

  useEffect(() => { setFocus(0); }, [q, openKey]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const close = () => { setClosing(true); window.setTimeout(onClose, 140); };
  const pick = (id: string) => { onSelect(id); close(); };
  const activate = (i: number) => {
    if (cards) { const c = cards[i]; if (c) pick(c.id); }
    else { const g = projectOrder[i]; if (g) setOpenKey(g.key); }
  };

  /* 方向键按屏幕位置走: 左右 = 前后一个; 上下 = 上/下一行里横向最近的那个 (跨大卡区和小块区) */
  const items = () => Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('[data-ov-item]') ?? []);
  const moveVert = (dir: 1 | -1) => {
    const els = items();
    const cur = els[focus]?.getBoundingClientRect();
    if (!cur) return;
    const cx = cur.left + cur.width / 2;
    let best = -1;
    let bestScore = Infinity;
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const dy = dir > 0 ? r.top - cur.bottom : cur.top - r.bottom;
      if (dy < -2) return;
      const score = dy * 4 + Math.abs(r.left + r.width / 2 - cx);
      if (score < bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0) setFocus(best);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (query) setQuery('');
      else if (openKey) setOpenKey(null);
      else close();
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setFocus((f) => Math.max(0, Math.min(itemCount - 1, f + (e.key === 'ArrowRight' ? 1 : -1))));
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveVert(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(focus);
    }
  };
  useLayoutEffect(() => { items()[focus]?.scrollIntoView({ block: 'nearest' }); }, [focus]);

  let idx = 0;
  const projectCard = (g: OverviewGroup) => {
    const i = idx++;
    const hue = hueOf(g.name);
    const live = g.sessions.filter((s) => isRunning(s.id)).length;
    const wait = g.sessions.slice(0, 3).filter((s) => glance[s.id]?.waiting).length;
    return (
      <button
        key={g.key}
        type="button"
        data-ov-item
        style={{ ['--i' as string]: Math.min(i, 20), ['--hue' as string]: hue }}
        className={`neox-ov-proj${i === focus ? ' is-focus' : ''}`}
        onClick={() => setOpenKey(g.key)}
        onMouseEnter={() => setFocus(i)}
      >
        <span className="neox-ov-proj__head">
          <Monogram name={g.name} />
          <span className="neox-ov-proj__id">
            <span className="neox-ov-proj__name">{g.name}</span>
            <span className="neox-ov-proj__meta">{zh ? `${g.sessions.length} 个会话` : `${g.sessions.length} chats`}</span>
          </span>
          <span className="neox-ov-proj__when">{g.sessions[0]?.timeText}</span>
        </span>
        <span className="neox-ov-proj__list">
          {g.sessions.slice(0, 3).map((s) => {
            const st = statusOf(s.id);
            return (
              <span key={s.id} className="neox-ov-proj__item">
                <span className={`neox-ov-mark is-${st || 'idle'}`} aria-hidden="true" />
                <span className="neox-ov-proj__title">{s.title}</span>
                <span className="neox-ov-proj__time">{s.timeText}</span>
              </span>
            );
          })}
        </span>
        <span className="neox-ov-proj__foot">
          {live > 0 && <i className="is-running">{zh ? `${live} 在跑` : `${live} running`}</i>}
          {wait > 0 && <i className="is-waiting">{zh ? `${wait} 等你` : `${wait} waiting`}</i>}
          {g.sessions.length > 3 && <span className="neox-ov-proj__more">{zh ? `还有 ${g.sessions.length - 3} 个 →` : `${g.sessions.length - 3} more →`}</span>}
          <Spark sessions={g.sessions} hue={hue} />
        </span>
      </button>
    );
  };
  const projectTile = (g: OverviewGroup) => {
    const i = idx++;
    return (
      <button
        key={g.key}
        type="button"
        data-ov-item
        style={{ ['--i' as string]: Math.min(i, 30) }}
        className={`neox-ov-tile${i === focus ? ' is-focus' : ''}`}
        onClick={() => setOpenKey(g.key)}
        onMouseEnter={() => setFocus(i)}
      >
        <Monogram name={g.name} size="sm" />
        <span className="neox-ov-tile__name">{g.name}</span>
        <span className="neox-ov-tile__meta">{g.sessions.length} · {g.sessions[0]?.timeText}</span>
      </button>
    );
  };

  return createPortal(
    <div className={`neox-ov${closing ? ' is-closing' : ''}`} onKeyDown={onKey}>
      <div className="neox-ov__panel" role="dialog" aria-label={zh ? '会话全景' : 'All chats'}>
        <header className="neox-ov__hero">
          <div className="neox-ov__hero-text">
            {openGroup && !q ? (
              <button type="button" className="neox-ov__crumb" onClick={() => setOpenKey(null)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
                {zh ? '全部项目' : 'All projects'}
              </button>
            ) : (
              <span className="neox-ov__eyebrow">{zh ? '会话全景' : 'Overview'}</span>
            )}
            <h1 className="neox-ov__title">
              {openGroup && !q ? <><Monogram name={openGroup.name} />{openGroup.name}</> : (zh ? '所有会话' : 'All chats')}
            </h1>
            <div className="neox-ov__stats">
              {runningCount > 0 && <span className="is-running"><b>{runningCount}</b>{zh ? '在跑' : 'running'}</span>}
              {waitingCount > 0 && <span className="is-waiting"><b>{waitingCount}</b>{zh ? '等你' : 'waiting'}</span>}
              {openGroup && !q
                ? <span><b>{openGroup.sessions.length}</b>{zh ? '个会话' : 'chats'}</span>
                : <>
                  <span><b>{weekCount}</b>{zh ? '本周' : 'this week'}</span>
                  <span><b>{groups.length}</b>{zh ? '个项目' : 'projects'}</span>
                  <span><b>{total}</b>{zh ? '个会话' : 'chats'}</span>
                </>}
            </div>
          </div>
          <img className="neox-ov__art" src={clayNewchatArt} alt="" aria-hidden="true" draggable={false} />
          <button type="button" className="neox-ov__close" onClick={close} aria-label={zh ? '关闭' : 'Close'} title="Esc">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>

        <div className="neox-ov__search">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={openGroup ? (zh ? `在「${openGroup.name}」里找…` : `Search in ${openGroup.name}…`) : (zh ? '找会话 — 输入标题或项目名' : 'Find a chat — title or project')}
            spellCheck={false}
          />
          {q ? <span className="neox-ov__search-count">{zh ? `${cards?.length ?? 0} 个` : `${cards?.length ?? 0}`}</span> : null}
          <span className="neox-ov__keys"><kbd>↑↓←→</kbd><kbd>↵</kbd><kbd>Esc</kbd></span>
        </div>

        <div ref={bodyRef} className="neox-ov__body" key={`${openKey ?? ''}-${q ? 'q' : ''}`}>
          {cards ? (
            <div className="neox-ov__cards">
              {cards.length === 0 && <div className="neox-ov__empty">{zh ? '没找到' : 'Nothing found'}</div>}
              {cards.map((s, i) => {
                const g = glance[s.id];
                const st = statusOf(s.id);
                const line = st === 'running' ? (g?.activity || (zh ? '正在处理…' : 'Working…')) : g?.waiting?.text || g?.lastLine || '';
                const gname = s.groupName ?? openGroup?.name ?? '';
                return (
                  <button
                    key={s.id}
                    type="button"
                    data-ov-item
                    style={{ ['--i' as string]: Math.min(i, 24), ['--hue' as string]: hueOf(gname) }}
                    className={`neox-ov-card${i === focus ? ' is-focus' : ''}${s.id === activeSessionId ? ' is-active' : ''}${st ? ` is-${st}` : ''}`}
                    onClick={() => pick(s.id)}
                    onMouseEnter={() => setFocus(i)}
                  >
                    <span className="neox-ov-card__head">
                      {st && <span className={`neox-ov-mark is-${st}`} aria-hidden="true" />}
                      <span className="neox-ov-card__title">{s.title}</span>
                    </span>
                    <span className="neox-ov-card__line">{line}</span>
                    <span className="neox-ov-card__foot">
                      {s.groupName && <span className="neox-ov-card__group"><Monogram name={s.groupName} size="sm" />{s.groupName}</span>}
                      <span className="neox-ov-card__time">{s.timeText}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              {hot.length > 0 && (
                <section className="neox-ov__section">
                  <h2>{zh ? '最近两周在忙' : 'Active lately'}<em>{hot.length}</em></h2>
                  <div className="neox-ov__projects">{hot.map(projectCard)}</div>
                </section>
              )}
              {cold.length > 0 && (
                <section className="neox-ov__section">
                  <h2>{zh ? '更早的项目' : 'Earlier projects'}<em>{cold.length}</em></h2>
                  <div className="neox-ov__tiles">{cold.map(projectTile)}</div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default SessionOverview;
