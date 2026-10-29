
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useDeferredValue,
} from 'react';
import { useEnterTransition } from '../../hooks/useEnterTransition';
import { createPortal } from 'react-dom';
import type { Session } from '../../../shared/ipc';
import { useI18n } from '../../hooks/useI18n';
import './session-search.css';
import { searchSessions, MAX_HITS as SHARED_MAX_HITS, type MatchHit as SharedMatchHit } from '../../../shared/sessionSearch';

interface SessionSearchPaletteProps {
  open: boolean;
  onClose: () => void;
  /** 当前 workspace 的全部 session (含 messages). 由 host 从 runtime.sessions 传入. */
  sessions: Session[];
  /** 用户点了结果 → 切 session. host 应 selectSession(id) + nav 到 agent. */
  onSelect: (sessionId: string) => void;
}

/* 命中项的形状由 shared/sessionSearch 定义 —— 主进程和这里必须是同一份,
 * 否则"主进程搜出来的"和"本地兜底搜出来的"两条路会长出两种结构。
 * messageRole 在共享类型里是 string (数据库里存什么就是什么), 这里按需窄化渲染。 */
type MatchHit = SharedMatchHit;
const MAX_HITS = SHARED_MAX_HITS;

function formatRelative(ts: number, zh: boolean): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (min < 1) return zh ? '刚刚' : 'just now';
  if (min < 60) return zh ? `${min} 分钟前` : plural(min, 'minute');
  const h = Math.floor(min / 60);
  if (h < 24) return zh ? `${h} 小时前` : plural(h, 'hour');
  const d = Math.floor(h / 24);
  if (d < 7) return zh ? `${d} 天前` : plural(d, 'day');
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export const SessionSearchPalette: React.FC<SessionSearchPaletteProps> = ({
  open,
  onClose,
  sessions,
  onSelect,
}) => {
  const { isZh } = useI18n();
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* useDeferredValue: 大量打字时让搜索过滤晚一拍跑, UI 输入永远跟手 */
  const deferredQuery = useDeferredValue(query);

  /* 重置 — 打开时清空, 关闭时也清 (下次开始一次新搜索) */
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
      /* 给 portal mount 一帧时间, 再 focus input */
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const [remoteHits, setRemoteHits] = useState<SharedMatchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!open) { setRemoteHits(null); setSearching(false); return; }
    const q = deferredQuery.trim();
    if (!q) { setRemoteHits([]); setSearching(false); return; }
    const api = (window as any).neox;
    if (typeof api?.searchSessions !== 'function') { setRemoteHits(null); setSearching(false); return; }
    let alive = true;
    setSearching(true);
    void api.searchSessions({ query: q })
      .then((res: { ok?: boolean; hits?: SharedMatchHit[] }) => {
        if (!alive) return;
        /* ok=false 表示主进程侧搜失败 —— 置 null 让下面回落本地, 而不是显示"没有结果" */
        setRemoteHits(res?.ok && Array.isArray(res.hits) ? res.hits : null);
        setSearching(false);
      })
      .catch(() => { if (alive) { setRemoteHits(null); setSearching(false); } });
    return () => { alive = false; };
  }, [open, deferredQuery]);

  const localHits = useMemo(
    () => (remoteHits === null ? searchSessions(sessions as never, deferredQuery) : []),
    [sessions, deferredQuery, remoteHits],
  );
  const hits = remoteHits ?? localHits;

  /* 选中越界 clamp */
  useEffect(() => {
    if (selectedIdx >= hits.length && hits.length > 0) {
      setSelectedIdx(0);
    }
  }, [hits.length, selectedIdx]);

  /* 选中变化时滚动到可视区 */
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-hit-idx="${selectedIdx}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIdx]);

  const handleConfirm = useCallback((hit: MatchHit | undefined) => {
    if (!hit) return;
    onSelect(hit.sessionId);
    onClose();
  }, [onSelect, onClose]);

  /* 全局键盘: Esc 关 / 方向键 / Enter (只在 palette 打开时绑定) */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(hits.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm(hits[selectedIdx]);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, hits, selectedIdx, handleConfirm, onClose]);

  /* 入场动画: motion-macos / motion-win32 */

  const entered = useEnterTransition();


  if (!open) return null;

  return createPortal(
    <div
      className="neox-sessionsearch-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className={`neox-sessionsearch nx-in nx-in--modal ${entered ? 'is-in' : ''}`}
        role="dialog"
        aria-label={isZh ? '搜索会话' : 'Search chats'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="neox-sessionsearch__input-wrap">
          <input
            ref={inputRef}
            type="text"
            className="neox-sessionsearch__input"
            placeholder={isZh ? '搜索之前会话里的消息内容…' : 'Search messages across your chats…'}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIdx(0); }}
            autoComplete="off"
            spellCheck={false}
          />
          {query.length > 0 && (
            <span className="neox-sessionsearch__count">
              {(() => {
                const n = hits.length === MAX_HITS ? `${MAX_HITS}+` : String(hits.length);
                return isZh ? `${n} 条结果` : `${n} result${hits.length === 1 ? '' : 's'}`;
              })()}
            </span>
          )}
        </div>
        <div ref={listRef} className="neox-sessionsearch__list">
          {!query.trim() && (
            <div className="neox-sessionsearch__empty">
              <p>{isZh ? '输入关键词搜索所有会话里的消息.' : 'Type to search messages across all your chats.'}</p>
              <p className="neox-sessionsearch__hint">
                {isZh ? '↑↓ 切换 · Enter 打开所在会话 · Esc 关闭' : '↑↓ navigate · Enter open · Esc close'}
              </p>
            </div>
          )}
          {/* pending 还要算上 useDeferredValue 的滞后期 —— 用户已经敲了新字但 effect 还没
            * 拿到新的 deferredQuery, 那一小段里 searching 还是 false, 光靠它仍会闪一下"未找到"。 */}
          {query.trim() && hits.length === 0 && (searching || query.trim() !== deferredQuery.trim()) && (
            <div className="neox-sessionsearch__empty" role="status" aria-busy="true">
              <p className="neox-text-shimmer">{isZh ? '搜索中…' : 'Searching…'}</p>
            </div>
          )}
          {query.trim() && hits.length === 0 && !searching && query.trim() === deferredQuery.trim() && (
            <div className="neox-sessionsearch__empty">
              <p>{isZh ? `未找到包含 “${query}” 的消息.` : `No messages matching “${query}”.`}</p>
            </div>
          )}
          {hits.map((hit, idx) => (
            <button
              key={`${hit.sessionId}::${hit.messageId}::${idx}`}
              type="button"
              data-hit-idx={idx}
              className={`neox-sessionsearch__row${idx === selectedIdx ? ' is-active' : ''}`}
              onClick={() => handleConfirm(hit)}
              onMouseEnter={() => setSelectedIdx(idx)}
            >
              <div className="neox-sessionsearch__row-head">
                <span className={`neox-sessionsearch__role neox-sessionsearch__role--${hit.messageRole}`}>
                  {hit.messageRole === 'user' ? (isZh ? '你' : 'You') : hit.messageRole === 'assistant' ? 'AI' : 'sys'}
                </span>
                <span className="neox-sessionsearch__row-title">
                  {hit.sessionName || (isZh ? '未命名会话' : 'Untitled chat')}
                </span>
                <time className="neox-sessionsearch__row-time">{formatRelative(hit.messageTimestamp, isZh)}</time>
              </div>
              <div className="neox-sessionsearch__row-snippet">
                {hit.snippet.slice(0, hit.matchStart)}
                <mark>{hit.snippet.slice(hit.matchStart, hit.matchEnd)}</mark>
                {hit.snippet.slice(hit.matchEnd)}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default SessionSearchPalette;
