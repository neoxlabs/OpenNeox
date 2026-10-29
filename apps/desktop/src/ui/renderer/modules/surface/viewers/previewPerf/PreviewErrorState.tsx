/* 预览失败态 (S-12) —— 四个 viewer 共用。
 *
 * 用户看到的必须是三个出口:
 *   1. 原因 (人话)          —— previewError.ts 归类
 *   2. 重试                 —— 重新读盘 / 重新解析
 *   3. 用系统应用打开        —— 预览这条路走不通时至少能看到文件
 * 原始报错不丢, 但折成小字, 不再直接当标题甩给用户。
 */

import React from 'react';
import { briefErrorDetail, previewErrorCopy } from './previewError';
import './previewError.css';

interface Props {
  rawError: string | null | undefined;
  isZh: boolean;
  onRetry: () => void;
  onOpenExternal?: () => void;
  externalError?: string | null;
  retryLabel?: string;
}

export const PreviewErrorState: React.FC<Props> = ({
  rawError, isZh, onRetry, onOpenExternal, externalError, retryLabel,
}) => {
  const copy = previewErrorCopy(rawError, isZh);
  const detail = briefErrorDetail(rawError);
  return (
    <div className="sfc-empty sfc-empty--error sfc-preview-error" role="alert" data-error-kind={copy.kind}>
      <div className="sfc-empty__title">{copy.title}</div>
      <div className="sfc-preview-error__hint">{copy.hint}</div>
      {detail && <pre className="sfc-preview-error__raw" title={detail}>{detail}</pre>}
      {externalError && <pre className="sfc-preview-error__raw">{briefErrorDetail(externalError)}</pre>}
      <div className="sfc-empty__actions">
        <button type="button" className="sfc-empty__retry" onClick={onRetry}>
          {retryLabel || (isZh ? '重试' : 'Retry')}
        </button>
        {onOpenExternal && (
          <button type="button" className="sfc-empty__retry" onClick={onOpenExternal}>
            {isZh ? '用系统应用打开' : 'Open in system app'}
          </button>
        )}
      </div>
    </div>
  );
};

export default PreviewErrorState;
