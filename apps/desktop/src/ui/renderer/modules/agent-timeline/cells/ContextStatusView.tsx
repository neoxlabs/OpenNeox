import React from 'react';
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

function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/* ---------- context_status — agent 自查预算卡片 ---------- */
export const ContextStatusView: React.FC<{
  suggestion: 'ok' | 'save_memory_soon' | 'save_memory_and_restart' | 'unknown';
  advice?: string;
  snapshotAvailable: boolean;
  sessionId?: string;
  worstPct?: string;
  input?:  { used: number; budget: number; pct: string; compressAt?: number };
  output?: { used: number; budget: number; pct: string };
  toolCalls?: { used: number; budget: number };
  time?:    { elapsedMs: number; budgetMs?: number };
  turns?:   { llmCalls: number; toolCallsTotal: number };
}> = ({ suggestion, advice, snapshotAvailable, worstPct, input, output, toolCalls, time, turns }) => {
  const { isZh } = useI18n();
  const tone =
    suggestion === 'save_memory_and_restart' ? 'critical' :
    suggestion === 'save_memory_soon'        ? 'warn'     :
    suggestion === 'ok'                      ? 'ok'       : 'unknown';
  const toneLabel =
    suggestion === 'save_memory_and_restart' ? (isZh ? '建议重启' : 'Restart advised') :
    suggestion === 'save_memory_soon'        ? (isZh ? '建议落盘' : 'Save memory soon') :
    suggestion === 'ok'                      ? (isZh ? '健康' : 'Healthy') : '—';

  /* 12px 内联 SVG, 跟 wakeup 一套风, 不用 emoji */
  const StatusIcon = (
    <svg className="atl-ctx__svg" viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" />
      <path d="M4.5 7 L6.3 8.8 L9.7 5.4" />
    </svg>
  );

  return (
    <div className={`atl-ctx atl-ctx--${tone}`}>
      <span className="atl-ctx__rail" aria-hidden="true" />
      <div className="atl-ctx__inner">
        <div className="atl-ctx__head">
          {StatusIcon}
          <span className="atl-ctx__title">{isZh ? '上下文预算' : 'Context budget'}</span>
          <span className={`atl-ctx__badge atl-ctx__badge--${tone}`}>{toneLabel}</span>
          {snapshotAvailable && worstPct && (
            <span className="atl-ctx__worst" title={isZh ? '三类预算中最紧张的占比' : 'Tightest of the three budgets'}>{isZh ? `最紧 ${worstPct}` : `Peak ${worstPct}`}</span>
          )}
        </div>

        {!snapshotAvailable ? (
          <div className="atl-ctx__msg">{advice || (isZh ? '当前 runtime 无预算快照。' : 'No budget snapshot for the current runtime.')}</div>
        ) : (
          <>
            {input && input.budget > 0 && (
              <CtxBar label={isZh ? '输入' : 'Input'} used={input.used} budget={input.budget} pct={input.pct} />
            )}
            {output && output.budget > 0 && (
              <CtxBar label={isZh ? '输出' : 'Output'} used={output.used} budget={output.budget} pct={output.pct} muted />
            )}

            <div className="atl-ctx__chips">
              {toolCalls && toolCalls.budget > 0 && (
                <span className="atl-ctx__chip">
                  {isZh ? '工具' : 'Tools'} {toolCalls.used}<span className="atl-ctx__chip-div">/</span>{toolCalls.budget}
                </span>
              )}
              {time && time.budgetMs && time.budgetMs > 0 && (
                <span className="atl-ctx__chip">
                  {isZh ? '时长' : 'Time'} {formatDuration(time.elapsedMs)}<span className="atl-ctx__chip-div">/</span>{formatDuration(time.budgetMs)}
                </span>
              )}
              {turns && (
                <span className="atl-ctx__chip">
                  {isZh
                    ? `LLM ${turns.llmCalls} · 工具调 ${turns.toolCallsTotal}`
                    : `LLM ${turns.llmCalls} · tool calls ${turns.toolCallsTotal}`}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const CtxBar: React.FC<{
  label: string;
  used: number;
  budget: number;
  pct: string;
  muted?: boolean;
}> = ({ label, used, budget, pct, muted }) => {
  const numericPct = Number.isFinite(parseFloat(pct)) ? Math.max(0, Math.min(100, parseFloat(pct))) : 0;
  const tier =
    numericPct >= 85 ? 'critical' :
    numericPct >= 65 ? 'warn'     : 'ok';
  return (
    <div className={`atl-ctx__bar-row${muted ? ' is-muted' : ''}`}>
      <span className="atl-ctx__bar-label">{label}</span>
      <div className="atl-ctx__bar">
        <div className={`atl-ctx__bar-fill atl-ctx__bar-fill--${tier}`} style={{ width: `${numericPct.toFixed(1)}%` }} />
      </div>
      <span className="atl-ctx__bar-val">
        <span className="atl-ctx__bar-pct">{pct}</span>
        <span className="atl-ctx__bar-frac">{formatNumber(used)} / {formatNumber(budget)}</span>
      </span>
    </div>
  );
};

