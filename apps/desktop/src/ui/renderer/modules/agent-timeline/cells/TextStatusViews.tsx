import React from 'react';
import { useI18n } from '../../../hooks/useI18n';

/** 距底部这么近就算"在底部", 继续跟随新内容。 */
const THINKING_STICK_PX = 24;

export const ThinkingView: React.FC<{ text: string }> = ({ text }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const stickRef = React.useRef(true);
  /* 挂载时不动: 已结束的历史思考从头看; 只有内容在长 (流式) 时才跟底 */
  const mountedRef = React.useRef(false);
  const followRafRef = React.useRef<number | null>(null);
  const onScroll = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= THINKING_STICK_PX;
  }, []);
  React.useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    if (!stickRef.current || followRafRef.current !== null) return;
    followRafRef.current = requestAnimationFrame(() => {
      followRafRef.current = null;
      const el = ref.current;
      if (el && stickRef.current) el.scrollTop = el.scrollHeight;
    });
  }, [text]);
  React.useEffect(() => () => {
    if (followRafRef.current !== null) cancelAnimationFrame(followRafRef.current);
  }, []);
  return <div ref={ref} className="atl-thinking" onScroll={onScroll}>{text}</div>;
};

export const LogView: React.FC<{ level?: string; message: string }> = ({ level, message }) => {
  const { isZh } = useI18n();
  const norm = level === 'warn' ? 'warning' : (level ?? 'info');
  const lineCount = message.split(/\r?\n/).length;
  const rich = norm === 'warning' || norm === 'error' || message.length > 240 || lineCount > 3;

  const copyMessage = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void navigator.clipboard?.writeText(message);
  };

  if (!rich) {
    return <div className={`atl-log is-${norm}`}>{message}</div>;
  }

  const label = norm === 'error'
    ? (isZh ? '错误详情' : 'Error details')
    : norm === 'warning'
      ? (isZh ? '异常详情' : 'Warning details')
      : (isZh ? '日志详情' : 'Log details');

  return (
    <div className={`atl-log-card is-${norm}`}>
      <div className="atl-log-card__head">
        <span className="atl-log-card__label">{label}</span>
        <button
          type="button"
          className="atl-log-card__copy"
          onClick={copyMessage}
          title={isZh ? '复制完整内容' : 'Copy full content'}
        >
          {isZh ? '复制' : 'Copy'}
        </button>
      </div>
      <pre className="atl-log-card__body">{message}</pre>
    </div>
  );
};
