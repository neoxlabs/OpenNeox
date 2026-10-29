import React, { useEffect, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';

function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

export const WakeupView: React.FC<{
  status: 'scheduled' | 'skipped' | 'invalid';
  reason?: string;
  prompt?: string;
  delaySeconds?: number;
  dueAtMs?: number;
  dueAtIso?: string;
  clamped?: boolean;
  message?: string;
}> = ({ status, reason, prompt, delaySeconds, dueAtMs, dueAtIso, clamped, message }) => {
  const { isZh } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== 'scheduled' || !dueAtMs) return;
    if (dueAtMs <= Date.now()) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [status, dueAtMs]);

  const ClockIcon = (
    <svg className="atl-wakeup__svg" viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" />
      <path d="M7 4 V7 L9 8.4" />
    </svg>
  );
  const SkippedIcon = (
    <svg className="atl-wakeup__svg" viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" />
      <path d="M3.4 3.4 L10.6 10.6" />
    </svg>
  );
  const WarnIcon = (
    <svg className="atl-wakeup__svg" viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 1.5 L12.6 11.5 H1.4 Z" />
      <path d="M7 5.5 V8" />
      <circle cx="7" cy="10" r=".7" fill="currentColor" stroke="none" />
    </svg>
  );

  if (status === 'skipped') {
    return (
      <div className="atl-wakeup atl-wakeup--skipped">
        <span className="atl-wakeup__rail" aria-hidden="true" />
        <div className="atl-wakeup__inner">
          <div className="atl-wakeup__head">
            {SkippedIcon}
            <span className="atl-wakeup__title">{isZh ? '未登记唤醒' : 'Wakeup not scheduled'}</span>
          </div>
          {(message || reason) && (
            <div className="atl-wakeup__msg">{message || reason}</div>
          )}
        </div>
      </div>
    );
  }

  if (status === 'invalid') {
    return (
      <div className="atl-wakeup atl-wakeup--invalid">
        <span className="atl-wakeup__rail" aria-hidden="true" />
        <div className="atl-wakeup__inner">
          <div className="atl-wakeup__head">
            {WarnIcon}
            <span className="atl-wakeup__title">{isZh ? '参数无效' : 'Invalid parameters'}</span>
          </div>
          {message && <div className="atl-wakeup__msg">{message}</div>}
        </div>
      </div>
    );
  }

  /* scheduled */
  const remainMs = dueAtMs ? Math.max(0, dueAtMs - now) : (delaySeconds ?? 0) * 1000;
  const fired = remainMs <= 0;
  const remainStr = formatDuration(remainMs);
  const totalStr = delaySeconds ? formatDuration(delaySeconds * 1000) : undefined;
  const timeLocale = isZh ? 'zh-CN' : 'en-US';
  const dueLabel = dueAtIso
    ? new Date(dueAtIso).toLocaleTimeString(timeLocale, { hour12: false })
    : (dueAtMs ? new Date(dueAtMs).toLocaleTimeString(timeLocale, { hour12: false }) : undefined);
  /* 0..1 进度: 已经流逝多少;仅在已知 delaySeconds 时计算 */
  const progress = delaySeconds && delaySeconds > 0
    ? Math.min(1, Math.max(0, 1 - remainMs / (delaySeconds * 1000)))
    : 0;

  return (
    <div className={`atl-wakeup atl-wakeup--scheduled${fired ? ' is-fired' : ''}`}>
      <span className="atl-wakeup__rail" aria-hidden="true" />
      <div className="atl-wakeup__inner">
        <div className="atl-wakeup__head">
          {ClockIcon}
          <span className="atl-wakeup__title">
            {fired ? (isZh ? '唤醒已触发' : 'Wakeup fired') : (isZh ? '已登记定时唤醒' : 'Wakeup scheduled')}
          </span>
          {clamped && (
            <span
              className="atl-wakeup__chip"
              title={isZh ? 'delaySeconds 被 clamp 到 [60, 3600]' : 'delaySeconds clamped to [60, 3600]'}
            >{isZh ? '已校准' : 'Adjusted'}</span>
          )}
        </div>

        {!fired && (
          <div className="atl-wakeup__count" aria-live="polite">
            <span className="atl-wakeup__count-val">{remainStr}</span>
            {totalStr && totalStr !== remainStr && (
              <span className="atl-wakeup__count-total">{isZh ? '剩余' : 'left'} / {totalStr}</span>
            )}
            {delaySeconds && delaySeconds > 0 && (
              <div className="atl-wakeup__bar" aria-hidden="true">
                <div className="atl-wakeup__bar-fill" style={{ width: `${(progress * 100).toFixed(1)}%` }} />
              </div>
            )}
          </div>
        )}

        <div className="atl-wakeup__rows">
          {reason && (
            <div className="atl-wakeup__row">
              <span className="atl-wakeup__k">{isZh ? '原因' : 'Reason'}</span>
              <span className="atl-wakeup__v">{reason}</span>
            </div>
          )}
          {dueLabel && (
            <div className="atl-wakeup__row">
              <span className="atl-wakeup__k">{isZh ? '触发时间' : 'Fires at'}</span>
              <span className="atl-wakeup__v atl-wakeup__v--mono">{dueLabel}</span>
            </div>
          )}
          {prompt && (
            <div className="atl-wakeup__row atl-wakeup__row--block">
              <span className="atl-wakeup__k">{isZh ? '唤醒指令' : 'Wakeup prompt'}</span>
              <code className="atl-wakeup__prompt">{prompt}</code>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
