import React, { useMemo, useState } from 'react';
import type { DiffLine } from '../types';
import { useI18n } from '../../../hooks/useI18n';


const PREVIEW_LINES = 12;
const EXPAND_STEP = 200;

export const SimpleDiff: React.FC<{
  lines: DiffLine[];
  streaming?: boolean;
  /** 卡内右上角的悬停动作 (回退/查看) —— 由调用方给, 这里只负责摆位置 */
  actions?: React.ReactNode;
}> = ({ lines, streaming, actions }) => {
  const { isZh } = useI18n();
  const [shown, setShown] = useState(PREVIEW_LINES);

  const visible = useMemo(() => {
    if (lines.length <= shown) return lines;
    return lines.slice(0, shown);
  }, [lines, shown]);

  const rest = lines.length - visible.length;

  return (
    <div className={`nx-diff${streaming ? ' is-streaming' : ''}`}>
      {actions}
      {visible.map((l, i) => {
        if (l.kind === 'gap') {
          return (
            <div key={`g${i}`} className="nx-diff__gap">
              {isZh ? `未改动 ${Math.max(1, (l.newNo ?? 0) - (l.oldNo ?? 0) + 1)} 行` : `${Math.max(1, (l.newNo ?? 0) - (l.oldNo ?? 0) + 1)} unchanged`}
            </div>
          );
        }
        if (l.kind === 'more') {
          return null;
        }
        if (l.kind === 'hunk') {
          return null;
        }
        const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : '';
        return (
          <div key={`l${i}`} className={`nx-diff__line is-${l.kind}`}>
            <span className="nx-diff__no">{l.newNo ?? l.oldNo ?? ''}</span>
            <code className="nx-diff__code"><span className="nx-diff__sign">{sign || ' '}</span>{l.text}</code>
          </div>
        );
      })}
      {rest > 0 && (
        <button
          type="button"
          className="nx-diff__more"
          onClick={(e) => { e.stopPropagation(); setShown((n) => n + EXPAND_STEP); }}
        >
          {isZh ? `还有 ${rest} 行` : `${rest} more lines`}
        </button>
      )}
    </div>
  );
};
