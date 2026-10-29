import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import './sidebar-peek.css';
import {
  loadKnowledge, loadMcp, loadSkills, setMcpAllEnabled, setMcpServerEnabled,
  type KbCardRow, type McpRow, type SkillRow,
} from './sidebarDockActions';
import { requestOpenKbCard } from '../knowledge-base/kbOpenCard';

/* 知识卡片: 一张带折角的卡; 「始终带上」的卡换成图钉 */
const IconCard: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h4" />
  </svg>
);
const IconPin: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 17v4" />
    <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3Z" />
  </svg>
);

export const PEEK_TOOLS = new Set(['mcp', 'skills', 'knowledge']);

interface Props {
  toolId: string;
  title: string;
  anchor: DOMRect;
  zh: boolean;
  onManage: () => void;
  onClose: () => void;
  onEnter: () => void;
  onLeave: () => void;
  /** 面板里改了东西 (开关 MCP), 托盘角标跟着刷新 */
  onChanged: () => void;
}

const Switch: React.FC<{ on: boolean; onChange: (v: boolean) => void; label: string }> = ({ on, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    className={`neox-peek__switch${on ? ' is-on' : ''}`}
    onClick={(e) => { e.stopPropagation(); onChange(!on); }}
  />
);

export const SidebarToolPeek: React.FC<Props> = ({ toolId, title, anchor, zh, onManage, onClose, onEnter, onLeave, onChanged }) => {
  const [mcp, setMcp] = useState<{ on: boolean; rows: McpRow[] } | null>(null);
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [cards, setCards] = useState<KbCardRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    if (toolId === 'mcp') void loadMcp().then((r) => { if (alive) setMcp(r); });
    if (toolId === 'skills') void loadSkills().then((r) => { if (alive) setSkills(r); });
    if (toolId === 'knowledge') void loadKnowledge().then((r) => { if (alive) setCards(r); });
    return () => { alive = false; };
  }, [toolId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const width = 252;
  const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 8));
  const bottom = window.innerHeight - anchor.top + 10;
  const loading = <div className="neox-peek__empty neox-text-shimmer">{zh ? '读取中…' : 'Loading…'}</div>;

  let body: React.ReactNode = null;
  let headRight: React.ReactNode = null;
  if (toolId === 'mcp') {
    headRight = mcp && (
      <Switch on={mcp.on} label={zh ? 'MCP 总开关' : 'MCP master switch'} onChange={async (v) => {
        setMcp({ ...mcp, on: v });
        await setMcpAllEnabled(v);
        setMcp(await loadMcp());
        onChanged();
      }} />
    );
    body = !mcp ? loading : mcp.rows.length === 0
      ? <div className="neox-peek__empty">{zh ? '还没有 MCP 服务' : 'No MCP servers yet'}</div>
      : mcp.rows.map((r) => (
        <div key={r.id} className={`neox-peek__row${!mcp.on || !r.enabled ? ' is-off' : ''}`}>
          <span className={`neox-peek__dot${r.ok === true ? ' is-ok' : r.ok === false ? ' is-bad' : ''}`} aria-hidden="true" />
          <span className="neox-peek__name" title={r.name}>{r.name}</span>
          <span className="neox-peek__meta">
            {!mcp.on || !r.enabled ? (zh ? '已关' : 'off') : r.ok === false ? (zh ? '连不上' : 'error') : r.ok ? (zh ? `${r.tools} 个工具` : `${r.tools} tools`) : ''}
          </span>
          <Switch on={r.enabled} label={r.name} onChange={async (v) => {
            setMcp({ ...mcp, rows: mcp.rows.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)) });
            await setMcpServerEnabled(r, v);
            setMcp(await loadMcp());
            onChanged();
          }} />
        </div>
      ));
  } else if (toolId === 'skills') {
    body = !skills ? loading : skills.length === 0
      ? <div className="neox-peek__empty">{zh ? '还没有技能' : 'No skills yet'}</div>
      : skills.slice(0, 6).map((s) => (
        <button
          key={s.id}
          type="button"
          className="neox-peek__row is-action"
          title={s.description || s.name}
          onClick={() => {
            /* 点技能 = 在输入框里起个头「/技能名 」, 接着写要它干什么 */
            window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text: `/${s.name} `, focus: true } }));
            onClose();
          }}
        >
          <span className="neox-peek__slash" aria-hidden="true">/</span>
          <span className="neox-peek__stack">
            <span className="neox-peek__name">{s.name}</span>
            {s.description && <span className="neox-peek__desc">{s.description}</span>}
          </span>
        </button>
      ));
  } else if (toolId === 'knowledge') {
    body = !cards ? loading : (
      <>
        {cards.length === 0
          ? <div className="neox-peek__empty">{zh ? '还没有知识卡片' : 'No cards yet'}</div>
          : cards.slice(0, 5).map((c) => (
            <button
              key={c.id}
              type="button"
              className="neox-peek__row is-action"
              title={c.description || c.title}
              onClick={() => { requestOpenKbCard(c.id); onClose(); onManage(); }}
            >
              <span className={`neox-peek__glyph${c.always ? ' is-pin' : ''}`} aria-hidden="true">{c.always ? <IconPin /> : <IconCard />}</span>
              <span className="neox-peek__stack">
                <span className="neox-peek__name">
                  {c.title}
                  {c.draft && <i className="neox-peek__tag">{zh ? '待确认' : 'draft'}</i>}
                </span>
                {c.description && <span className="neox-peek__desc">{c.description}</span>}
              </span>
            </button>
          ))}
        <div className="neox-peek__tip">{zh ? '把会话或文件拖到知识库图标上, 就能存进来' : 'Drop a chat or file on the icon to save it'}</div>
      </>
    );
  }

  const count = toolId === 'skills' ? skills?.length : toolId === 'knowledge' ? cards?.length : mcp?.rows.length;

  return createPortal(
    <div
      className="neox-peek"
      style={{ left, bottom, width }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      role="dialog"
      aria-label={title}
    >
      <div className="neox-peek__head">
        <span className="neox-peek__title">{title}{count != null && count > 0 ? <em>{count}</em> : null}</span>
        {headRight}
      </div>
      <div className="neox-peek__body">{body}</div>
      <button type="button" className="neox-peek__manage" onClick={() => { onClose(); onManage(); }}>
        {toolId === 'skills' && skills && skills.length > 6
          ? (zh ? `全部 ${skills.length} 个` : `All ${skills.length}`)
          : (zh ? '管理全部' : 'Manage all')}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </button>
    </div>,
    document.body,
  );
};

export default SidebarToolPeek;
