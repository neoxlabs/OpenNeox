/**
 * Pilot · 对话页的头 (稿 pl1): 头像 + 名字 + 一行分工 · 「换个分身」下拉 · 黑色圆形通话键。
 * 点名字 / 头像 = 改它 (名字 / 形象 / 分工); 下拉里列所有分身, 底下一行「新建分身」。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { pilotApi, type PilotCall, type PilotProfile } from '../pilotStore';
import type { PilotContact } from '../PilotSidebar';
import { lookOf } from './pilotLooks';

export const avatarStill = (p: PilotProfile | undefined): string => lookOf(p).src;

interface Props {
  sessionId: string;
  profiles: Record<string, PilotProfile>;
  contacts: PilotContact[];
  call: PilotCall | null;
  onEdit: () => void;
  onSwitch: (id: string) => void;
  onCreate: () => void;
}

export const PilotChatHeader: React.FC<Props> = ({ sessionId, profiles, contacts, call, onEdit, onSwitch, onCreate }) => {
  const { isZh } = useI18n();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const profile = profiles[sessionId];
  const name = profile?.name || contacts.find((c) => c.id === sessionId)?.title || 'Pilot';
  const inThisCall = call?.sessionId === sessionId && call.phase === 'active';
  const ringing = call?.sessionId === sessionId && call.phase === 'ringing';
  const busyElsewhere = !!call && call.sessionId !== sessionId;

  /* 点外面 / Esc 收起下拉 */
  useEffect(() => {
    if (!open) return undefined;
    const down = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  const startCall = async () => {
    const r = await pilotApi().pilotCallStartOutgoing?.(sessionId).catch(() => null);
    if (r?.ok && r.call) window.dispatchEvent(new CustomEvent('neox:pilot-call-connect', { detail: r.call }));
  };

  return (
    <header className="pv3-chathead">
      <button type="button" className="pv3-chathead__who" onClick={onEdit} title={isZh ? '改名字 / 形象 / 分工' : 'Edit name, look and role'}>
        <img className="pv3-chathead__face" src={avatarStill(profile)} alt="" draggable={false} />
        <span className="pv3-chathead__text">
          <b>{name}</b>
          <span>
            {inThisCall ? (isZh ? '通话中' : 'In call')
              : ringing ? (isZh ? '正在呼叫你…' : 'Calling you…')
              : profile?.persona?.split('\n')[0] || (isZh ? '点这里写上它负责什么' : 'Click to give it a role')}
          </span>
        </span>
      </button>
      <div className="pv3-chathead__acts">
        <div className="pv3-switch" ref={menuRef}>
          <button type="button" className="pv3-switch__btn" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)}>
            {isZh ? '换个分身' : 'Switch'}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
          </button>
          {open && (
            <div className="pv3-switch__menu" role="menu">
              {contacts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={c.id === sessionId}
                  className={`pv3-switch__item${c.id === sessionId ? ' is-on' : ''}`}
                  onClick={() => { setOpen(false); if (c.id !== sessionId) onSwitch(c.id); }}
                >
                  <img src={avatarStill(profiles[c.id])} alt="" draggable={false} />
                  <span className="pv3-switch__name">{profiles[c.id]?.name || c.title}</span>
                  {c.id === sessionId && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
                  )}
                </button>
              ))}
              <div className="pv3-switch__sep" />
              <button type="button" role="menuitem" className="pv3-switch__item pv3-switch__item--new" onClick={() => { setOpen(false); onCreate(); }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
                <span className="pv3-switch__name">{isZh ? '新建分身' : 'New'}</span>
              </button>
            </div>
          )}
        </div>
        {!inThisCall && (
          <button
            type="button"
            className="pv3-chathead__call"
            disabled={busyElsewhere || ringing}
            onClick={() => void startCall()}
            title={busyElsewhere ? (isZh ? '正在跟别的分身通话' : 'In another call') : (isZh ? '打给它, 连续聊' : 'Call — hands-free')}
            aria-label={isZh ? '通话' : 'Call'}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" />
            </svg>
          </button>
        )}
      </div>
    </header>
  );
};

export default PilotChatHeader;
