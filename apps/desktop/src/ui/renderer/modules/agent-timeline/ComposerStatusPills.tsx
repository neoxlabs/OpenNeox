import React, { useEffect, useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { useStreamingTokensHud } from '../../state/streamingHudStore';
import { LiveShimmerText } from './components/LiveShimmerText';

/* ============================================================
 * ContextPill · 顶部活跃上下文 (attachment / skill ref) 的小 pill
 *   · 点击 label 区 = 预览 (onOpen)
 *   · 点击 × = 移除 (onRemove)
 * ============================================================ */
/* ============================================================
 * LiveStatusLine — streaming 时显示 "3m 3s · ↑ 7.6k tokens".
 *   · 1s 节拍器驱动 elapsed 更新, streamingTokens 变化时 key 重 mount 触发滚动动画.
 *   · 让用户看到模型实时生成速度, 不再只是 "Agent 运行中" 灰底占位.
 * ============================================================ */
const formatHumanElapsed = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  if (h > 0) return `${h}h ${m}m ${rs}s`;
  if (m > 0) return `${m}m ${rs}s`;
  return `${rs}s`;
};
export const formatCompactTokens = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const value = n / 1_000_000;
  const nearest = Math.round(value);
  if (nearest >= 1 && Math.abs(value - nearest) <= 0.11) return `${nearest}M`;
  return `${value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, '')}M`;
};

const IDLE_HINTS_ZH = ['就绪', '想吃啥？', '有个想法？', '帮我记下…', '查点什么？', '要不要提醒你？'];
const IDLE_HINTS_EN = ['Ready', 'Hungry?', 'Got an idea?', 'Let me note that…', 'Look something up?', 'Set a reminder?'];
const IdlePillRotator: React.FC<{ isZh: boolean }> = ({ isZh }) => {
  const hints = isZh ? IDLE_HINTS_ZH : IDLE_HINTS_EN;
  const [i, setI] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(() => setI((v) => (v + 1) % hints.length), 8000);
    return () => window.clearInterval(id);
  }, [hints.length]);
  return (
    <div className="atl-livestatus atl-livestatus--idle" aria-live="polite">
      <span className="atl-livestatus__dot" aria-hidden />
      <LiveShimmerText key={i} className="atl-livestatus__phase atl-livestatus__phase--rotate" text={hints[i]} />
    </div>
  );
};

export const LiveStatusLine: React.FC<{
  streaming: boolean;
  turnStartedAt: number | null;
  /** 运行中子 agent 的产出 tokens 合计 — 有则追加 "· 子 ↑ Nk" 段 */
  subAgentTokens?: number;
  activityLabel?: string;
  /** Life 模式传 true: 空态也渲染 "就绪" 一行, 不再 return null. */
  idlePersist?: boolean;
}> = ({ streaming, turnStartedAt, subAgentTokens, activityLabel, idlePersist }) => {
  const { isZh } = useI18n();
  const streamingTokens = useStreamingTokensHud();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!streaming || !turnStartedAt) return;
    const id = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [streaming, turnStartedAt]);
  void tick;
  if (!streaming || !turnStartedAt) {
    if (!idlePersist) return null;
    return <IdlePillRotator isZh={isZh} />;
  }
  const elapsed = formatHumanElapsed(Date.now() - turnStartedAt);
  const tk = formatCompactTokens(streamingTokens || 0);
  return (
    <div className="atl-livestatus" aria-live="polite">
      <span className="atl-livestatus__clock">{elapsed}</span>
      <span className="atl-livestatus__sep">·</span>
      {activityLabel && (
        <>
          <LiveShimmerText className="atl-livestatus__phase" text={activityLabel} live />
          <span className="atl-livestatus__sep">·</span>
        </>
      )}
      <span className="atl-livestatus__arrow">↑</span>
      <span className="atl-livestatus__tokens">
        {tk}
      </span>
      <span className="atl-livestatus__unit">tokens</span>
      {(subAgentTokens ?? 0) > 0 && (
        <>
          <span className="atl-livestatus__sep">·</span>
          <LiveShimmerText className="atl-livestatus__phase" text={'子'} live />
          <span className="atl-livestatus__arrow">↑</span>
          <span className="atl-livestatus__tokens">
            {formatCompactTokens(subAgentTokens ?? 0)}
          </span>
        </>
      )}
    </div>
  );
};

/* 图片附件缩略图 — 跟 ContextPill 同行布局, 但显示真实 <img> 而不是文件名.
 * 用 data URL 直接渲染 (intake() 已经 readAsDataURL 落到 a.data).
 * 点击 → 走原 ContextPill 的 onOpen (打开预览模态), × 走 onRemove. */
export const ImageThumb: React.FC<{
  src: string;
  alt: string;
  onOpen?: () => void;
  onRemove?: () => void;
}> = ({ src, alt, onOpen, onRemove }) => {
  const { isZh } = useI18n();
  return (
    <span
      className="atl-ctxthumb"
      title={isZh ? `${alt} · 点击预览` : `${alt} · Click to preview`}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
      style={{
        display: 'inline-flex',
        position: 'relative',
        width: 36,
        height: 36,
        borderRadius: 6,
        overflow: 'hidden',
        cursor: onOpen ? 'pointer' : 'default',
        border: '1px solid var(--neox-line, rgba(127,127,127,0.16))',
        background: 'var(--neox-bg-muted, rgba(127,127,127,.1))',
        verticalAlign: 'middle',
      }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
      {onRemove && (
        <button
          type="button"
          aria-label={isZh ? '移除' : 'Remove'}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            width: 14,
            height: 14,
            padding: 0,
            border: 0,
            borderRadius: '50%',
            background: 'rgba(0,0,0,0.55)',
            color: '#fff',
            fontSize: 10,
            lineHeight: 1,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >×</button>
      )}
    </span>
  );
};

export const ContextPill: React.FC<{
  icon: React.ReactNode;   /* string emoji 或 JSX (SVG icon) 都接受 */
  label: string;
  tone: 'file' | 'skill';
  /** 名字后面一小段淡字 (如「当前文件」): 说明这个附件怎么来的, 不跟文件名挤在一串里 */
  hint?: string;
  onOpen?: () => void;
  onRemove?: () => void;
}> = ({ icon, label, tone, hint, onOpen, onRemove }) => {
  const { isZh } = useI18n();
  const clickable = !!onOpen;
  return (
    <span
      className={`atl-ctxpill atl-ctxpill--${tone}${clickable ? ' is-clickable' : ''}`}
      title={clickable ? (isZh ? `${label} · 点击预览` : `${label} · Click to preview`) : label}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen?.();
              }
            }
          : undefined
      }
    >
      <span className="atl-ctxpill__ico">{icon}</span>
      <span className="atl-ctxpill__label">{label}</span>
      {hint && <span className="atl-ctxpill__hint">{hint}</span>}
      {onRemove && (
        <button
          type="button"
          className="atl-ctxpill__x"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label={isZh ? '移除' : 'Remove'}
        >×</button>
      )}
    </span>
  );
};
