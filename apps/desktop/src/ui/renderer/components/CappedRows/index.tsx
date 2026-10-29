
import React, { useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import './CappedRows.css';

const INITIAL = 200;
const STEP = 500;

export function CappedRows<T>({ items, render }: { items: T[]; render: (item: T) => React.ReactNode }) {
  const { isZh } = useI18n();
  const [limit, setLimit] = useState(INITIAL);
  const shown = items.length > limit ? items.slice(0, limit) : items;
  const rest = items.length - shown.length;
  return (
    <>
      {shown.map(render)}
      {rest > 0 && (
        <button type="button" className="neox-capped-rows__more" onClick={() => setLimit((n) => n + STEP)}>
          {isZh
            ? `再显示 ${Math.min(STEP, rest)} 条 (还有 ${rest} 条)`
            : `Show ${Math.min(STEP, rest)} more (${rest} remaining)`}
        </button>
      )}
    </>
  );
}

/** 条目被截断 / 未跟踪目录被折叠时的一行说明 —— 不许假装列表就是全部 */
export function GitStatusLimitNote({ truncated, untrackedMode }: { truncated?: boolean; untrackedMode?: 'all' | 'normal' }) {
  const { isZh } = useI18n();
  if (!truncated && untrackedMode !== 'normal') return null;
  const text = truncated
    ? (isZh
      ? '改动超过 10000 条, 只列出了前 10000 条。多半是有目录没加进 .gitignore。'
      : 'More than 10,000 changes — only the first 10,000 are listed. A directory is probably missing from .gitignore.')
    : (isZh
      ? '未跟踪文件太多, 已按目录折叠显示。多半是有目录没加进 .gitignore。'
      : 'Too many untracked files — they are grouped by directory. A directory is probably missing from .gitignore.');
  return <div className="neox-git-limit-note" role="note">{text}</div>;
}
