import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconAgent } from './shellIcons';
import { useI18n } from '../../hooks/useI18n';
import { useExclusivePopover } from '../../hooks/useExclusivePopover';
import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';

const POPOVER_WIDTH = 340;

const projectLabel = (workspacePath?: string | null): string => {
  if (!workspacePath) return '';
  const parts = workspacePath.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || workspacePath;
};

export const RunningSessionsPeek: React.FC = () => {
  const runtime = useNeoxRuntimeOptional();
  const { isZh } = useI18n();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const running = useMemo(() => {
    if (!runtime) return [];
    const ids = runtime.runningSessionIds;
    return runtime.sessions.filter((s) => ids.has(s.id));
  }, [runtime?.sessions, runtime?.runningSessionIds]);   // eslint-disable-line react-hooks/exhaustive-deps

  const openPopover = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ x: rect.right - POPOVER_WIDTH, y: rect.bottom + 6 });
  }, []);
  const closePopover = useCallback(() => setAnchor(null), []);
  useExclusivePopover('running-sessions', anchor !== null, closePopover);

  /* 跑完最后一个就自动收起 —— 弹层留着指向一张空表没有意义 */
  useEffect(() => { if (running.length === 0) setAnchor(null); }, [running.length]);

  if (!runtime || running.length === 0) return null;
  const count = running.length;
  const label = isZh ? `${count} 个会话在跑 · 点开看是谁` : `${count} session${count === 1 ? '' : 's'} running · click to see`;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="neox-topbar__services-peek neox-topbar__running-peek"
        title={label}
        aria-label={label}
        onClick={anchor ? closePopover : openPopover}
      >
        <span className="neox-topbar__services-peek__icon-wrap">
          <IconAgent />
          <span className="neox-topbar__services-peek__dot neox-topbar__running-peek__dot" aria-hidden="true" />
        </span>
        <span className="neox-topbar__services-peek__count">{count}</span>
      </button>
      {anchor && (
        <RunningPopover
          anchor={anchor}
          onClose={closePopover}
          rows={running.map((s) => ({
            id: s.id,
            title: s.name || (isZh ? '未命名会话' : 'Untitled session'),
            project: projectLabel(s.workspacePath),
            active: s.id === runtime.activeSession?.id,
          }))}
          onPick={(id) => { runtime.selectSession(id); closePopover(); }}
        />
      )}
    </>
  );
};

const RunningPopover: React.FC<{
  anchor: { x: number; y: number };
  rows: Array<{ id: string; title: string; project: string; active: boolean }>;
  onClose: () => void;
  onPick: (id: string) => void;
}> = ({ anchor, rows, onClose, onPick }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const { isZh } = useI18n();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* 外点关 —— 同 NotificationMenu: 不用全屏 backdrop (会吃掉下层所有 click) */
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!panelRef.current) return;
      if (!panelRef.current.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => window.addEventListener('mousedown', onMouseDown), 0);
    return () => { clearTimeout(t); window.removeEventListener('mousedown', onMouseDown); };
  }, [onClose]);

  return createPortal(
    <div
      ref={panelRef}
      className="neox-notif-popover neox-running-popover"
      style={{ left: Math.max(8, anchor.x), top: anchor.y, width: POPOVER_WIDTH }}
      role="dialog"
      aria-label={isZh ? '正在运行的会话' : 'Running sessions'}
    >
      <div className="neox-notif-popover__header">
        <h3>{isZh ? `正在运行 · ${rows.length}` : `Running · ${rows.length}`}</h3>
      </div>
      <div className="neox-notif-popover__body">
        {rows.map((r) => (
          <div
            key={r.id}
            className={`neox-notif-row is-clickable neox-running-row${r.active ? ' is-active' : ''}`}
            onClick={() => onPick(r.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(r.id); } }}
          >
            <span className="neox-running-row__pulse" aria-hidden="true" />
            <div className="neox-notif-row__body">
              <div className="neox-running-row__title">{r.title}</div>
              <div className="neox-running-row__meta">
                {r.project && <span>{r.project}</span>}
                {r.active && <span className="neox-running-row__here">{isZh ? '当前' : 'current'}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
};

export default RunningSessionsPeek;
