import React from 'react';
import type { SearchHit } from '../types';
import { FilePathChip } from '../FilePathChip';
import { useI18n } from '../../../hooks/useI18n';

export const SearchView: React.FC<{
  pattern?: string;
  totalHits?: number;
  hits?: SearchHit[];
}> = ({ pattern, totalHits, hits }) => {
  const { isZh } = useI18n();
  const hasHits = !!hits && hits.length > 0;
  const hasHead = !!pattern || typeof totalHits === 'number';
  return (
    <div className={`atl-search${!hasHead && !hasHits ? ' is-empty' : ''}`}>
      {hasHead ? (
        <div className="atl-search__head">
          {pattern && (
            <>
              <span className="atl-search__label">pattern</span>
              <code className="atl-search__pattern">{pattern}</code>
            </>
          )}
          {typeof totalHits === 'number' && (
            <span className="atl-search__count">{isZh ? `${totalHits} 命中` : `${totalHits} hit${totalHits === 1 ? '' : 's'}`}</span>
          )}
        </div>
      ) : (
        <div className="atl-search__pending">
          <span className="atl-search__pending-dot" aria-hidden="true" />
          <span>{isZh ? '搜索中，等待匹配结果…' : 'Searching, waiting for matches…'}</span>
        </div>
      )}
      {hasHits && (
        <div className="atl-search__list">
          {hits.map((h, i) => (
            /* 稳定 key: file+line 唯一定位一条命中; 无行号才退回 index */
            <div key={typeof h.line === 'number' ? `${h.file}:${h.line}` : `${h.file}#${i}`} className="atl-search__hit">
              <FilePathChip path={h.file} display={h.file} className="atl-search__hit-file" />
              {typeof h.line === 'number' && (
                <span className="atl-search__hit-line">:{h.line}</span>
              )}
              {h.text && <span className="atl-search__hit-text">{h.text}</span>}
            </div>
          ))}
          {typeof totalHits === 'number' && totalHits > hits.length && (
            <div className="atl-search__more">{isZh ? `+${totalHits - hits.length} 条更多` : `+${totalHits - hits.length} more`}</div>
          )}
        </div>
      )}
    </div>
  );
};
