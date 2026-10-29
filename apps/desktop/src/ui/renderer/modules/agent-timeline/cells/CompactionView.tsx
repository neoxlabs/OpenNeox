import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { LiveShimmerText } from '../components/LiveShimmerText';

/* ---------- compaction ---------- */
interface CompressionBucket {
  bucket: string;
  label: string;
  messageCount: number;
  estimatedTokens: number;
  status: string;
  compressedTokens?: number;
  items?: string[];
}

export const CompactionView: React.FC<{
  status?: string;
  originalTokens?: number;
  finalTokens?: number;
  budgetTokens?: number;
  originalMsgs?: number;
  keptMsgs?: number;
  droppedMsgs?: number;
  compressionBuckets?: CompressionBucket[];
  compressionTotalBuckets?: number;
  compressionCompletedBuckets?: number;
  compressionSummaryModel?: string;
  /** 失败原因原文 —— 分割线下方整段显示, 不折进一行 */
  errorDetail?: string;
}> = ({
  status,
  originalTokens,
  finalTokens,
  budgetTokens,
  originalMsgs,
  keptMsgs,
  droppedMsgs,
  compressionBuckets,
  compressionTotalBuckets,
  compressionCompletedBuckets,
  compressionSummaryModel,
  errorDetail,
}) => {
  const { isZh } = useI18n();
  const isRunning = status === 'running' || status === 'compressing' || status === 'started';
  const isCompleted = status === 'completed';
  const isFailed = status === 'failed';
  const isSkipped = status === 'skipped';
  if (!isRunning && !isCompleted && !isFailed && !isSkipped) return null;

  /* 桶进度 → 0-100, 拿不到就 indeterminate */
  const activeBuckets = compressionBuckets?.filter(b => b.status !== 'empty') ?? [];
  const totalBuckets = positiveOptional(compressionTotalBuckets) ?? positiveOptional(activeBuckets.length);
  const completedBucketCount = positiveOptional(compressionCompletedBuckets)
    ?? positiveOptional(activeBuckets.filter(bucket => isBucketComplete(bucket.status)).length);
  const bucketPct = totalBuckets && completedBucketCount !== undefined
    ? clampPercent(Math.round((Math.min(totalBuckets, completedBucketCount) / totalBuckets) * 100))
    : undefined;
  const hasProgress = typeof bucketPct === 'number';

  const original = positiveNumber(originalTokens);
  const final = positiveNumber(finalTokens);
  const savedTokens = original > 0 && final > 0 ? Math.max(0, original - final) : 0;

  const noNetGain = isCompleted && original > 0 && final > 0 && final >= original;
  const title = isFailed
    ? (isZh ? '上下文压缩失败' : 'Context compaction failed')
    : noNetGain
      ? (isZh ? '压缩未获收益' : 'Compaction gained nothing')
      : isCompleted
        ? (isZh ? '上下文已压缩' : 'Context compacted')
        : isSkipped
          ? (isZh ? '上下文无需压缩' : 'No compaction needed')
          : (isZh ? '正在压缩上下文…' : 'Compacting context…');

  /* 一行次要文字 — 进行中优先显示进度 */
  let meta: string | null = null;
  if (isFailed) {
    meta = isZh ? '已保留原上下文' : 'Original context kept';
  } else if (isCompleted && original > 0 && final > 0) {
    meta = `${formatTokens(original)} → ${formatTokens(final)} tokens`
      + (savedTokens > 0 ? (isZh ? ` · 释放 ${formatTokens(savedTokens)}` : ` · freed ${formatTokens(savedTokens)}`) : '');
  } else if (isRunning) {
    const parts: string[] = [];
    if (hasProgress) parts.push(`${bucketPct}%`);
    /* 一次请求摘要整段时没有组 (进度是估算百分比, 见 useStreamHandler), 不写「n/m 组」 */
    if (activeBuckets.length > 0 && totalBuckets && completedBucketCount !== undefined) parts.push(`${Math.min(totalBuckets, completedBucketCount)}/${totalBuckets}${isZh ? ' 组' : ' groups'}`);
    if (original > 0) parts.push(`${formatTokens(original)} tokens`);
    meta = parts.length > 0 ? parts.join(' · ') : null;
  }

  /* 次要细节收进 hover tooltip */
  const tooltipParts: string[] = [];
  const oMsgs = positiveNumber(originalMsgs);
  const kMsgs = positiveNumber(keptMsgs);
  const dMsgs = positiveNumber(droppedMsgs);
  if (oMsgs > 0) tooltipParts.push(kMsgs > 0
    ? (isZh ? `保留 ${kMsgs}/${oMsgs} 条消息` : `Kept ${kMsgs}/${oMsgs} messages`)
    : (isZh ? `${oMsgs} 条消息` : `${oMsgs} messages`));
  if (dMsgs > 0) tooltipParts.push(isZh ? `丢弃 ${dMsgs} 条` : `Dropped ${dMsgs}`);
  if (positiveNumber(budgetTokens) > 0) tooltipParts.push(isZh ? `目标 ${formatTokens(positiveNumber(budgetTokens))} tokens` : `Budget ${formatTokens(positiveNumber(budgetTokens))} tokens`);
  if (activeBuckets.length > 0 && totalBuckets && completedBucketCount !== undefined) tooltipParts.push(isZh ? `进度 ${Math.min(totalBuckets, completedBucketCount)}/${totalBuckets} 组` : `Progress ${Math.min(totalBuckets, completedBucketCount)}/${totalBuckets} groups`);
  if (compressionSummaryModel) tooltipParts.push(isZh ? `摘要模型 ${compressionSummaryModel}` : `Summary model ${compressionSummaryModel}`);
  const tooltip = tooltipParts.length > 0 ? tooltipParts.join(' · ') : undefined;

  /* 分割线两翼 rail: 进行中 = 进度轨道 (确定进度从外侧向中心合拢), 静态 = 细分隔线 */
  const railFillStyle = isRunning && hasProgress ? { width: `${Math.max(4, bucketPct)}%` } : undefined;
  const icon = (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 5v5.4M5.8 8.4L8 10.6l2.2-2.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  const divider = (
    <div
      className={[
        'atl-compact',
        'atl-compact--divider',
        isRunning ? 'is-running' : '',
        isRunning && !hasProgress ? 'is-indeterminate' : '',
        isCompleted ? 'is-completed' : '',
        isFailed ? 'is-failed' : '',
        isSkipped ? 'is-skipped' : '',
      ].filter(Boolean).join(' ')}
      role={isFailed ? 'alert' : 'status'}
      aria-live="polite"
      title={tooltip}
    >
      <span className="atl-compact__rail atl-compact__rail--left" aria-hidden="true">
        {isRunning && <span className="atl-compact__rail-fill" style={railFillStyle} />}
      </span>
      <span className="atl-compact__icon" aria-hidden="true">{icon}</span>
      <LiveShimmerText className={`atl-compact__title${isRunning ? ' is-shimmer' : ''}`} text={title} live={isRunning} />
      {meta && <span className="atl-compact__meta">{meta}</span>}
      <span className="atl-compact__icon atl-compact__icon--right" aria-hidden="true">{icon}</span>
      <span className="atl-compact__rail atl-compact__rail--right" aria-hidden="true">
        {isRunning && <span className="atl-compact__rail-fill" style={railFillStyle} />}
      </span>
    </div>
  );
  if (!isFailed || !errorDetail) return divider;
  return (
    <>
      {divider}
      <div className="atl-compact__error">{isZh ? `原因：${errorDetail}` : `Reason: ${errorDetail}`}</div>
    </>
  );
};

function isBucketComplete(status: string): boolean {
  return /^(done|completed|compressed|success|skipped)$/i.test(status);
}

function positiveNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function positiveOptional(value: unknown): number | undefined {
  const n = positiveNumber(value);
  return n > 0 ? n : undefined;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** 128432 → "128.4K", 86_300 → "86.3K", 1_240_000 → "1.2M" */
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${trimZero((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1000) return `${trimZero((n / 1000).toFixed(1))}K`;
  return String(Math.round(n));
}

function trimZero(s: string): string {
  return s.replace(/\.0$/, '');
}
