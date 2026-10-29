import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { FilePathChip } from '../FilePathChip';

export const ReadDocView: React.FC<{
  status: string;
  fileName?: string;
  chars?: number;
  sizeLabel?: string;
}> = ({ status, fileName, chars, sizeLabel }) => {
  void chars;
  const { isZh } = useI18n();
  const displayName = fileName ? fileName.split(/[/\\]/).pop() || fileName : (isZh ? '文档' : 'Document');
  /* fileName 可能是真路径 (toolArgs.path), 也可能是 file_id 截断 ("a1b2c3d4…") —
   * 只有带路径分隔符的才接文件交互原语, 其余保持纯文本. */
  const isRealPath = !!fileName && /[/\\]/.test(fileName);
  const ok = status === 'success';
  return (
    <div className="atl-readdoc">
      <span className={`atl-readdoc__icon${ok ? '' : ' is-err'}`} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 3h8.5L18 6.5V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V3z" />
          <path d="M14.5 3v3.5H18" />
          <path d="M9 13h6" /><path d="M9 16h4" />
        </svg>
      </span>
      <div className="atl-readdoc__info">
        {isRealPath ? (
          <FilePathChip path={fileName!} display={displayName} className="atl-readdoc__name" />
        ) : (
          <span className="atl-readdoc__name" title={fileName}>{displayName}</span>
        )}
        <span className="atl-readdoc__meta">
          {ok ? (isZh ? '读取成功' : 'Read succeeded') : (isZh ? '读取失败' : 'Read failed')}
          {sizeLabel && <> · {sizeLabel}</>}
        </span>
      </div>
      {ok && (
        <span className="atl-readdoc__badge" aria-hidden="true">
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 6.2L5 8.5L9.5 3.5" />
          </svg>
        </span>
      )}
    </div>
  );
};
