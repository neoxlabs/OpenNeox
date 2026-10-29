import React, { useCallback, useState } from 'react';
import type { DataRecord } from '../dataResult';
import { useI18n } from '../../../hooks/useI18n';
import { CopyIconButton } from '../../../components/CopyIconButton';


function openLink(url: string): void {
  try {
    const opener = (window as any).neox?.openExternal as ((u: string) => Promise<void>) | undefined;
    if (typeof opener === 'function') void opener(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  } catch { /* 打不开就算了, 不影响卡片 */ }
}

export const DataResultView: React.FC<{
  records?: DataRecord[];
  total?: number;
  fields?: Array<{ k: string; v: string }>;
  raw: string;
}> = ({ records, total, fields, raw }) => {
  const { isZh } = useI18n();
  const [showRaw, setShowRaw] = useState(false);
  const toggleRaw = useCallback(() => setShowRaw((v) => !v), []);
  const more = records && typeof total === 'number' ? total - records.length : 0;

  return (
    <div className="atl-data">
      {records && (
        records.length > 0 ? (
          <ul className="atl-data__list">
            {records.map((r, i) => (
              <li key={i} className="atl-data__row">
                {r.ref && <span className="atl-data__ref">{r.ref}</span>}
                <span className="atl-data__title" title={r.title}>{r.title}</span>
                {r.when && <span className="atl-data__when">{r.when}</span>}
                {r.status && <span className="atl-data__status">{r.status}</span>}
                {r.link && (
                  <button
                    type="button"
                    className="atl-data__link"
                    onClick={() => openLink(r.link!)}
                    title={r.link}
                    aria-label={isZh ? '打开链接' : 'Open link'}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                      <path d="M9 3h4v4M13 3L7.5 8.5M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="atl-data__empty">{isZh ? '没有结果' : 'No results'}</div>
        )
      )}
      {more > 0 && (
        <div className="atl-data__more">{isZh ? `还有 ${more} 条` : `${more} more`}</div>
      )}
      {fields && fields.length > 0 && (
        <dl className="atl-data__fields">
          {fields.map((f) => (
            <div key={f.k} className="atl-data__field">
              <dt>{f.k}</dt>
              <dd>{f.v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="atl-data__foot">
        <button type="button" className="atl-data__raw-toggle" onClick={toggleRaw} aria-expanded={showRaw}>
          {showRaw ? (isZh ? '收起原始数据' : 'Hide raw data') : (isZh ? '原始数据' : 'Raw data')}
        </button>
        <CopyIconButton className="atl-data__copy" getText={() => raw} label={isZh ? '复制原始数据' : 'Copy raw'} />
      </div>
      {showRaw && <pre className="atl-data__raw">{raw}</pre>}
    </div>
  );
};
