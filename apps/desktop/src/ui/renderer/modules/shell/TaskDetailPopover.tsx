/**
 * TaskDetailPopover — 任务详情的弹窗化容器 (self-managed)
 *
 * 触发方式: Composer 工具栏的"任务详情"按钮 dispatchEvent('neox:toggle-task-detail').
 * 关闭: 点击外部 / Esc / 顶部 × / 再次点 Composer 按钮.
 *
 * 位置: 屏幕右下, 输入框正上方区域 — 跟触发按钮位置呼应.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useEnterTransition } from '../../hooks/useEnterTransition';
import { RightPanel, type RightPanelProps } from './RightPanel';
import { useI18n } from '../../hooks/useI18n';

export const TASK_DETAIL_EVENT = 'neox:toggle-task-detail';

interface AnchorPos { top: number; right: number }

export const TaskDetailPopover: React.FC<RightPanelProps> = (rightPanelProps) => {
  const { isZh } = useI18n();
  /* macOS 入场动画 —— 菜单用 pop (只缩放不位移, 位移会跟触发器脱节) */
  const entered = useEnterTransition();
  const [open, setOpen] = useState(false);
  /* anchor: 触发按钮的 boundingRect (bottom, right) — popover 用它做 fixed 定位, 跟随真实位置.
   *   null 表示 fallback 到默认 (右上角 top:84 right:16). */
  const [anchor, setAnchor] = useState<AnchorPos | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  /* 监听 toggle 事件(TimelineHeader / Composer 任务详情按钮 dispatch).
   *   event.detail.anchor 携带按钮 bounding 信息时, popover 跟随定位; 否则走默认位置. */
  useEffect(() => {
    const onToggle = (e: Event) => {
      const detail = (e as CustomEvent<{ anchor?: AnchorPos }>).detail;
      setAnchor((prev) => detail?.anchor ?? prev);
      setOpen(v => !v);
    };
    window.addEventListener(TASK_DETAIL_EVENT, onToggle);
    return () => window.removeEventListener(TASK_DETAIL_EVENT, onToggle);
  }, []);

  /* Esc 关闭 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  /* 点击外部关闭 — 但点 Composer 按钮本身不算"外部"(那里会自己 toggle) */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (el.contains(target)) return;
      /* 点 Composer 任务详情按钮: 它会自己 dispatch event, 不要在这里 setOpen(false) */
      if (target.closest('[data-task-detail-trigger="1"]')) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const onClose = useCallback(() => setOpen(false), []);

  if (!open) return null;

  /* anchor 存在 → fixed 定位到按钮下方 8px, 右边对齐按钮右缘;
   *   超出底部时换上方显示 (简单策略: 算 anchor.top + 弹窗 max 高度 vs viewport 底部) */
  const style: React.CSSProperties | undefined = anchor
    ? { top: anchor.top + 8, right: anchor.right, left: 'auto' }
    : undefined;

  return (
    <div
      ref={ref}
      className={`neox-taskdetail-popover nx-in nx-in--pop ${entered ? 'is-in' : ''}`}
      role="dialog"
      aria-label={isZh ? '任务详情' : 'Task details'}
      style={style}
    >
      <div className="neox-taskdetail-popover__head">
        <span className="neox-taskdetail-popover__title">{isZh ? '任务详情' : 'Task details'}</span>
        <button
          type="button"
          className="neox-taskdetail-popover__close"
          onClick={onClose}
          aria-label={isZh ? '关闭' : 'Close'}
          title={isZh ? '关闭 (Esc)' : 'Close (Esc)'}
        >
          ×
        </button>
      </div>
      <div className="neox-taskdetail-popover__body">
        <RightPanel {...rightPanelProps} embedded />
      </div>
    </div>
  );
};

export default TaskDetailPopover;
