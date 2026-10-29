import React from 'react';
import { useI18n } from '../hooks/useI18n';

export interface ErrorCardProps {
  code: string;
  message: string;
  suggestion?: string;
  retryable?: boolean;
  category?: string;
  /** P2-35: 可选重试 callback — 传了才显"重试"按钮 */
  onRetry?: () => void;
  /** P2-35: 可选关闭 callback — 传了才显"×"按钮 */
  onDismiss?: () => void;
}

const ErrorCard: React.FC<ErrorCardProps> = ({
  code,
  message,
  suggestion,
  retryable,
  category,
  onRetry,
  onDismiss,
}) => {
  const { isZh } = useI18n();
  const severityClass = retryable ? 'warning' : 'error';

  return (
    <div className={`error-bar ${severityClass}`}>
      <div className="error-bar-content">
        <div className="error-bar-header">
          <span className="error-bar-code">{code}</span>
          {category && <span className="error-bar-category">{category}</span>}
        </div>
        <p className="error-bar-message">{message}</p>
        {suggestion && (
          <p className="error-bar-suggestion">💡 {suggestion}</p>
        )}
        {(onRetry || onDismiss) && (
          <div className="error-bar-actions">
            {onRetry && retryable && (
              <button type="button" className="error-bar-action error-bar-action--retry" onClick={onRetry}>
                {isZh ? '重试' : 'Retry'}
              </button>
            )}
            {onDismiss && (
              <button type="button" className="error-bar-action error-bar-action--dismiss" onClick={onDismiss}>
                {isZh ? '关闭' : 'Close'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ErrorCard;
