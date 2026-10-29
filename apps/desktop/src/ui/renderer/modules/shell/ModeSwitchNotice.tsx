
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import './ModeSwitchNotice.css';

export type NoticeMode = 'work' | 'code' | 'pilot';

const SEEN_KEY = 'neox-mode-switch-notice-count';
/** 说明卡之后再出几次胶囊, 然后只剩高亮 */
const PILL_TIMES = 3;

export type NoticeKind = 'card' | 'pill' | 'none';

export function nextNoticeKind(): NoticeKind {
  let n = 0;
  try { n = Number(window.localStorage.getItem(SEEN_KEY) ?? '0') || 0; } catch { /* 读不到按第一次 */ }
  try { window.localStorage.setItem(SEEN_KEY, String(n + 1)); } catch { /* ignore */ }
  if (n === 0) return 'card';
  if (n <= PILL_TIMES) return 'pill';
  return 'none';
}

function modeName(m: NoticeMode, zh: boolean): string {
  if (m === 'pilot') return 'Pilot';
  if (m === 'code') return zh ? '代码' : 'Code';
  return zh ? '工作' : 'Work';
}

const FolderGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true">
    <path d="M2 4.5c0-.6.4-1 1-1h3l1.4 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" />
  </svg>
);
const CodeGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3M9 3.5 7 12.5" />
  </svg>
);
const BotGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="10" height="8" rx="2.5" />
    <path d="M8 5V3M6.2 9h.01M9.8 9h.01" />
  </svg>
);
const Sparkle = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 1.5c.4 3.2 1.3 4.1 4.5 4.5v.01c-3.2.4-4.1 1.3-4.5 4.5-.4-3.2-1.3-4.1-4.5-4.5 3.2-.4 4.1-1.3 4.5-4.5Z" fill="currentColor" transform="translate(0 2)" />
  </svg>
);

export const ModeSwitchNotice: React.FC<{
  kind: Exclude<NoticeKind, 'none'>;
  to: NoticeMode;
  from: NoticeMode;
  zh: boolean;
  /** 卡片锚点 (模式条的左下角) */
  anchor?: { top: number; left: number } | null;
  onUndo: () => void;
  onClose: () => void;
}> = ({ kind, to, from, zh, anchor, onUndo, onClose }) => {
  /* 胶囊自己收; 说明卡要用户点「知道了」(或 Esc), 不自己消失 —— 第一次的话得让人看完 */
  useEffect(() => {
    if (kind !== 'pill') return;
    const t = window.setTimeout(onClose, 3500);
    return () => window.clearTimeout(t);
  }, [kind, onClose, to]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (kind === 'pill') {
    return createPortal(
      <div className="msn-pill" role="status">
        <span className="msn-pill__spark"><Sparkle /></span>
        <span className="msn-pill__text">
          {zh
            ? <>已切到「{modeName(to, zh)}」· 原来的对话都在</>
            : <>Switched to {modeName(to, zh)} · your other chats are still there</>}
        </span>
        <button type="button" className="msn-pill__undo" onClick={onUndo}>
          {zh ? `切回${modeName(from, zh)}` : `Back to ${modeName(from, zh)}`}
        </button>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className="msn-card"
      role="dialog"
      aria-label={zh ? '模式说明' : 'About modes'}
      style={anchor ? { top: anchor.top, left: anchor.left } : undefined}
    >
      <div className="msn-card__chips" aria-hidden="true">
        <span className="msn-chip is-work"><FolderGlyph />{modeName('work', zh)}</span>
        <span className="msn-chip is-code"><CodeGlyph />{modeName('code', zh)}</span>
        <span className="msn-chip is-pilot"><BotGlyph />Pilot</span>
      </div>
      <div className="msn-card__body">
        <strong>{zh ? '每个模式有自己的会话和文件夹' : 'Each mode keeps its own chats and folder'}</strong>
        <p>
          {zh
            ? <>现在是「{modeName(to, zh)}」。原来在「{modeName(from, zh)}」的对话没有丢，切回去就在。</>
            : <>You're in {modeName(to, zh)} now. Your {modeName(from, zh)} chats aren't gone — switch back to see them.</>}
        </p>
        <div className="msn-card__acts">
          <button type="button" className="msn-card__undo" onClick={onUndo}>
            {zh ? `切回${modeName(from, zh)}` : `Back to ${modeName(from, zh)}`}
          </button>
          <button type="button" className="msn-card__ok" onClick={onClose}>{zh ? '知道了' : 'Got it'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default ModeSwitchNotice;
