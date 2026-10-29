/**
 * TodoSurfaceViewer — 当下一茬清单 (结构化勾选)
 *
 * source.content 是 JSON.stringify({ items: TodoItem[] }).
 * agent 通过 update_todos 工具全量替换, 这里按 id 匹配做状态过渡动画.
 *
 * 视觉:
 *   - 顶部进度条(done / total, skipped 不算分母)
 *   - 每条: 状态图标 + 文本(done 划线) + 状态色
 *   - in_progress 那条左侧竖条 + 微呼吸动画 — 让用户一眼看到"现在做这个"
 */

import React, { useMemo } from 'react';
import type { Surface, TodoItem, TodoState, TodoStatus } from '../../../state/surfaceStore';
import { useI18n } from '../../../hooks/useI18n';
import { NeoxIllus } from '../../../media/illus';

interface Props {
  surface: Surface;
}

function parseTodos(content: string): TodoItem[] {
  try {
    const obj = JSON.parse(content);
    if (obj && Array.isArray(obj.items)) {
      return (obj.items as TodoItem[]).filter(
        (it) => it && typeof it.id === 'string' && typeof it.text === 'string',
      );
    }
  } catch { /* fall through */ }
  return [];
}

function getStatusLabel(isZh: boolean): Record<TodoStatus, string> {
  return isZh
    ? { pending: '待办', in_progress: '进行中', done: '完成', skipped: '跳过' }
    : { pending: 'Pending', in_progress: 'In progress', done: 'Done', skipped: 'Skipped' };
}

const StatusIcon: React.FC<{ status: TodoStatus }> = ({ status }) => {
  if (status === 'done') {
    return (
      <svg viewBox="0 0 18 18" width="18" height="18" fill="none" aria-hidden="true">
        <circle cx="9" cy="9" r="8" fill="currentColor" />
        <path d="M5.6 9.2 L7.9 11.4 L12.4 6.8" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === 'in_progress') {
    return (
      <svg viewBox="0 0 18 18" width="18" height="18" fill="none" aria-hidden="true">
        <circle cx="9" cy="9" r="7.2" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="9" cy="9" r="3.6" fill="currentColor" />
      </svg>
    );
  }
  if (status === 'skipped') {
    return (
      <svg viewBox="0 0 18 18" width="18" height="18" fill="none" aria-hidden="true">
        <circle cx="9" cy="9" r="8" fill="currentColor" opacity="0.16" />
        <path d="M5.8 9 H12.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  /* pending */
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="7.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
};

export const TodoSurfaceViewer: React.FC<Props> = ({ surface }) => {
  const { isZh } = useI18n();
  const STATUS_LABEL = getStatusLabel(isZh);
  const items = useMemo(() => {
    if (surface.source.type !== 'inline') return [];
    return parseTodos(surface.source.content);
  }, [surface.source, surface.updatedAt]);

  const stats = useMemo(() => {
    const tracked = items.filter(i => i.status !== 'skipped');
    const done = tracked.filter(i => i.status === 'done').length;
    const inProg = items.filter(i => i.status === 'in_progress').length;
    return { done, total: tracked.length, inProg };
  }, [items]);

  if (surface.source.type !== 'inline') {
    return (
      <div className="sfc-empty sfc-empty--error">
        <div className="sfc-empty__title">{isZh ? 'todo surface 仅支持 inline source' : 'Todo surfaces only support inline sources'}</div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      /* 只有"还没开始"这一种配插画 —— 上面那两个 sfc-empty 是报错和不支持的源,
       * 错误态挂一张画会显得在轻描淡写。跟 TeamPlanBoard 同一条规矩。 */
      <div className="sfc-empty">
        <img className="sfc-empty__art" src={NeoxIllus.task} alt="" aria-hidden draggable={false} />
        <div className="sfc-empty__title">{isZh ? '还没有任务项' : 'No tasks yet'}</div>
        <div className="sfc-empty__msg">{isZh ? 'Agent 开始拆任务后, 每一项都会列在这里' : 'Items appear here once the agent breaks the work down'}</div>
      </div>
    );
  }

  const pct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

  return (
    <div className="sfc-todo">
      <header className="sfc-todo__hdr">
        <div className="sfc-todo__progress">
          {/* v3: 先读 "2 / 5 完成" 大数, 进度条在下面一条细蓝线 */}
          <div className="sfc-todo__progress-meta">
            <span className="sfc-todo__progress-pct">{stats.done}<em> / {stats.total}</em></span>
            <span className="sfc-todo__progress-detail">
              {isZh
                ? `完成${stats.inProg > 0 ? ` · ${stats.inProg} 项进行中` : ''}`
                : `done${stats.inProg > 0 ? ` · ${stats.inProg} in progress` : ''}`}
            </span>
            {/* 只读说明 — 状态图标长得像 checkbox, 明确"点不动"是设计而非 bug */}
            <span
              className="sfc-todo__readonly"
              title={isZh
                ? '清单由 Agent 维护, 这里只读展示。想调整就直接在对话里告诉 Agent。'
                : 'This list is maintained by the agent and is read-only here. Ask the agent in chat to change it.'}
            >
              {isZh ? 'Agent 维护 · 只读' : 'Agent-managed · read-only'}
            </span>
          </div>
          <div className="sfc-todo__bar">
            <div className="sfc-todo__bar-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </header>
      <ul className="sfc-todo__list">
        {items.map((it) => (
          <li
            key={it.id}
            className={`sfc-todo__item is-${it.status}`}
            aria-label={`${STATUS_LABEL[it.status]} — ${it.text}`}
          >
            <span className="sfc-todo__icon" aria-hidden="true"><StatusIcon status={it.status} /></span>
            <span className="sfc-todo__text">{it.text}</span>
            <span className="sfc-todo__status">{STATUS_LABEL[it.status]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default TodoSurfaceViewer;
