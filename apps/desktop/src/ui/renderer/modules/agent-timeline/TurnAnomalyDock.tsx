
import React from 'react';
import { useI18n } from '../../hooks/useI18n';
import { useAgentModeVariant } from '../../hooks/useAgentModeVariant';
import { IconStop, IconAlert, IconChevronDown } from '../shell/shellIcons';
import { INTERRUPTED_NOTICE_ID_PREFIX, isReconnectEntry } from './turnAnomaly';
import { translateError } from '../../i18n/errors';
import {
  AUTO_RETRY_MAX, cancelAutoRetry, classifyRetry, getAutoRetryState, noteAnomaly, subscribeAutoRetry,
} from '../../state/turnAutoRetry';
import type { TimelineEntry } from '../../utils/workspaceUtils';

type ReconnectEntry = TimelineEntry & {
  reconnectAttempt?: number; reconnectMaxRetries?: number; reconnectDelayMs?: number; reconnectErrorCode?: string;
};
type ErrEntry = TimelineEntry & {
  errorCode?: string; errorMessage?: string; errorSuggestion?: string; errorRetryable?: boolean;
  errorRepeatCount?: number; errorLastAt?: number; errorRequestId?: string;
};

const MAX_INLINE_ROWS = 2;

function clock(ts?: number): string | undefined {
  if (!ts || !Number.isFinite(ts)) return undefined;
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 自动重试的进度圈 + 倒计时 —— 每 250ms 重算一次, 只在真的在等的时候挂。 */
function useAutoRetryTick(active: boolean): number {
  const [, force] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [active]);
  return 0;
}

/** 环形进度: 走过的比例 = 已用掉的等待时间。纯展示, 不带文字。 */
const ProgressRing: React.FC<{ ratio: number }> = ({ ratio }) => {
  const r = 6, c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, ratio));
  return (
    <svg className="atl-anomaly__ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r={r} className="atl-anomaly__ring-track" />
      <circle
        cx="8" cy="8" r={r} className="atl-anomaly__ring-fill"
        strokeDasharray={`${c}`} strokeDashoffset={`${c * (1 - p)}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
};

const AnomalyRow: React.FC<{
  entry: TimelineEntry;
  sessionId: string | null;
  onDismiss?: (entryId: string) => void;
  onRetry?: () => void;
  onContinue?: () => void;
  canContinue?: boolean;
}> = ({ entry, sessionId, onDismiss, onRetry, onContinue, canContinue }) => {
  const { isZh, language } = useI18n();
  /* Work: 错误码 (PROXY_UPSTREAM_FAILED 之类) 不上行 —— 只说人话; 码仍在展开详情和复制内容里, 反馈时用得上 */
  const { isWork } = useAgentModeVariant();
  const [open, setOpen] = React.useState(false);
  const [, bump] = React.useState(0);

  const stopped = String(entry.id).startsWith(INTERRUPTED_NOTICE_ID_PREFIX);
  const isToolFailure = entry.type === 'tool_error';
  /* 传输层正在自己重连 —— 只展示进度, **不叠加**我们这层的自动重试 (会变成两套重试打架)。 */
  const reconnect = isReconnectEntry(entry) ? (entry as ReconnectEntry) : null;
  const e = entry as ErrEntry;
  const seenAt = e.errorLastAt ?? e.timestamp ?? 0;
  const autoKind = (stopped || reconnect) ? 'none'
    : classifyRetry({ code: e.errorCode, retryable: e.errorRetryable, message: e.errorMessage || e.detail });

  const continueMode = !!canContinue && !!onContinue;
  const primaryFire = continueMode ? onContinue : onRetry;

  /* 排下一次自动重试 —— 幂等, 同一次失败反复渲染不会叠定时器。 */
  React.useEffect(() => {
    if (!sessionId || autoKind === 'none' || !primaryFire) return;
    noteAnomaly({ sessionId, entryId: entry.id, code: e.errorCode, retryable: e.errorRetryable, seenAt, fire: primaryFire });
  }, [sessionId, entry.id, e.errorCode, e.errorRetryable, seenAt, autoKind, primaryFire]);

  React.useEffect(() => subscribeAutoRetry(() => bump((n) => n + 1)), []);
  const auto = sessionId ? getAutoRetryState(sessionId) : null;
  const autoHere = auto && auto.entryId === entry.id ? auto : null;
  const waiting = !!autoHere?.nextAt;
  useAutoRetryTick(waiting);

  /* 圈走满 = 等待结束 (已用掉的 / 这一档退避总时长)。 */
  const leftMs = autoHere?.nextAt ? Math.max(0, autoHere.nextAt - Date.now()) : 0;
  const ratio = waiting && autoHere?.waitMs ? 1 - leftMs / autoHere.waitMs : 1;

  const dismiss = onDismiss ? () => { cancelAutoRetry(sessionId); onDismiss(entry.id); } : undefined;
  const retryNow = primaryFire ? () => { cancelAutoRetry(sessionId); primaryFire(); } : undefined;

  const humanize = (raw: string): string => {
    const t = raw.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return t;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      const pick = [o.summary, o.message, o.error, o.detail].find((v) => typeof v === 'string' && v.trim());
      if (typeof pick === 'string') return pick.trim();
    } catch { /* 不是完整 JSON (被截断过) —— 也别原样显示 */ }
    const m = /"(?:summary|message|error)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t);
    if (m) { try { return JSON.parse(`"${m[1]}"`) as string; } catch { return m[1]; } }
    return isZh ? '工具返回了无法解析的结果' : 'Tool returned an unreadable result';
  };

  const rawTitle = e.errorMessage || e.detail || entry.title || (isZh ? '未知错误' : 'Unknown error');
  const title = reconnect
    ? (entry.title || (isZh ? '连接异常, 重试中' : 'Connection problem — retrying'))
    : stopped
    ? [String(entry.title || '').trim(), String(entry.detail || '').trim()].filter(Boolean).join(' · ')
      || (isZh ? '已停止' : 'Stopped')
    : humanize(translateError(e.errorCode, language, rawTitle).message || rawTitle);

  const repeat = e.errorRepeatCount && e.errorRepeatCount > 1
    ? (isZh ? `失败 ${e.errorRepeatCount} 次` : `${e.errorRepeatCount} failures`)
    : null;

  return (
    <div className={`atl-anomaly__row${stopped ? ' is-stopped' : ' is-error'}${open ? ' is-open' : ''}`}>
      <div className="atl-anomaly__line">
        <span className="atl-anomaly__icon" aria-hidden>
          {stopped ? <IconStop size={13} /> : <IconAlert size={13} />}
        </span>
        {!stopped && !isWork && (e.errorCode || (isToolFailure && e.toolName)) && (
          <span className="atl-anomaly__code">{e.errorCode || e.toolName}</span>
        )}
        <span className="atl-anomaly__text" title={title}>{title}</span>

        {reconnect && (
          <span className="atl-anomaly__auto is-running" title={reconnect.reconnectErrorCode || ''}>
            <span className="atl-anomaly__spin" aria-hidden />
            {reconnect.reconnectDelayMs
              ? (isZh ? `${(reconnect.reconnectDelayMs / 1000).toFixed(1)}s 后再试` : `retry in ${(reconnect.reconnectDelayMs / 1000).toFixed(1)}s`)
              : (isZh ? '重连中' : 'reconnecting')}
          </span>
        )}
        {!reconnect && waiting && autoHere && (
          <span className="atl-anomaly__auto" title={isZh ? '可恢复的故障, 正在自动重试' : 'Recoverable — retrying automatically'}>
            <ProgressRing ratio={ratio} />
            {isZh
              ? `自动重试 ${autoHere.attempt + 1}/${AUTO_RETRY_MAX} · ${Math.ceil(leftMs / 1000)}s`
              : `Retry ${autoHere.attempt + 1}/${AUTO_RETRY_MAX} · ${Math.ceil(leftMs / 1000)}s`}
          </span>
        )}
        {!reconnect && !waiting && autoHere && !autoHere.exhausted && (
          <span className="atl-anomaly__auto is-running">
            <span className="atl-anomaly__spin" aria-hidden />
            {isZh ? `第 ${autoHere.attempt}/${AUTO_RETRY_MAX} 次重试中` : `Retrying ${autoHere.attempt}/${AUTO_RETRY_MAX}`}
          </span>
        )}
        {autoHere?.exhausted && (
          <span className="atl-anomaly__auto is-exhausted">
            {isZh ? `自动重试 ${AUTO_RETRY_MAX} 次都没成` : `Gave up after ${AUTO_RETRY_MAX} tries`}
          </span>
        )}

        {!waiting && !autoHere && repeat && (
          <span className="atl-anomaly__meta">
            {repeat}{clock(seenAt) ? ` · ${clock(seenAt)}` : ''}
          </span>
        )}
        {stopped && clock(entry.timestamp) && <span className="atl-anomaly__meta">{clock(entry.timestamp)}</span>}

        {!reconnect && retryNow && (!stopped || continueMode) && (
          <button
            type="button"
            className="atl-anomaly__btn atl-anomaly__btn--retry"
            onClick={retryNow}
            title={continueMode
              ? (isZh ? '从断掉的那半截往下接着写, 不重新生成已经写好的部分' : 'Pick up where it stopped instead of regenerating')
              : undefined}
          >
            {continueMode ? (isZh ? '继续' : 'Continue') : (isZh ? '重试' : 'Retry')}
          </button>
        )}
        {dismiss && (
          <button type="button" className="atl-anomaly__btn" onClick={dismiss}>
            {isZh ? '关闭' : 'Dismiss'}
          </button>
        )}
        {!stopped && (
          <button
            type="button"
            className={`atl-anomaly__toggle${open ? ' is-open' : ''}`}
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            title={isZh ? (open ? '收起' : '展开详情') : (open ? 'Collapse' : 'Details')}
          >
            <IconChevronDown size={13} />
          </button>
        )}
      </div>

      {open && !stopped && (
        <div className="atl-anomaly__detail">
          <div className="atl-anomaly__full">{title}</div>
          {/* 标题被 translateError 换成我们的人话时, 上游自己那句必须在展开里留着 ——
              它常常是唯一说清"到底哪儿不对"的一句 (例: "Model grok-4.6 is not supported
              for format anthropic")。两者相同就不重复显示。 */}
          {rawTitle && rawTitle !== title && (
            <div className="atl-anomaly__full atl-anomaly__full--raw">{rawTitle}</div>
          )}
          {e.errorSuggestion && <div className="atl-anomaly__tip">{e.errorSuggestion}</div>}
          {e.errorRequestId && (
            <div className="atl-anomaly__reqid">
              {isZh ? '请求 ID' : 'Request ID'}: <code>{e.errorRequestId}</code>
            </div>
          )}
          <div className="atl-anomaly__detail-actions">
            <button
              type="button" className="atl-anomaly__btn"
              onClick={() => {
                const text = [e.errorCode, title, e.errorSuggestion, e.errorRequestId].filter(Boolean).join('\n');
                void navigator.clipboard?.writeText(text);
              }}
            >{isZh ? '复制详情' : 'Copy details'}</button>
            <button
              type="button" className="atl-anomaly__btn"
              onClick={() => { try { window.dispatchEvent(new CustomEvent('neox:error-feedback', { detail: { code: e.errorCode, message: title, requestId: e.errorRequestId } })); } catch { /* ignore */ } }}
            >{isZh ? '反馈' : 'Report'}</button>
          </div>
        </div>
      )}
    </div>
  );
};

export const TurnAnomalyDock: React.FC<{
  entries: TimelineEntry[];
  sessionId?: string | null;
  onDismiss?: (entryId: string) => void;
  onRetry?: () => void;
  /** 从断点续写 —— canContinue 为真时它取代「重试」成为主动作 (含自动重试)。 */
  onContinue?: () => void;
  canContinue?: boolean;
}> = ({ entries, sessionId = null, onDismiss, onRetry, onContinue, canContinue }) => {
  const { isZh } = useI18n();
  /* 本地收起 —— 工具失败关掉只是"这条我看过了", timeline 里的记录不动。 */
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(() => new Set());
  const [foldOpen, setFoldOpen] = React.useState(false);
  const visible = React.useMemo(
    () => (entries ?? []).filter((e) => !hidden.has(e.id)),
    [entries, hidden],
  );
  /* 「需要你看一眼的」排前面 (runner_error / 已停止 / 重连), 工具失败排后面。
   *   折叠态只露前两条, 所以顺序决定了露出来的是哪两条 —— 会自动重试、带「继续」按钮的
   *   那种必须在上面, 一屏工具失败把它挤下去就等于没提示。同类之间保持时间线原序。 */
  const ordered = React.useMemo(() => {
    const hot = visible.filter((e) => e.type !== 'tool_error');
    const cold = visible.filter((e) => e.type === 'tool_error');
    return [...hot, ...cold];
  }, [visible]);

  const handleDismiss = React.useCallback((entryId: string) => {
    setHidden((prev) => new Set(prev).add(entryId));
    const target = (entries ?? []).find((e) => e.id === entryId);
    /* runner_error / 「已停止」本来就不落盘, 直接抹掉; 工具失败只收起。 */
    if (target && target.type !== 'tool_error') onDismiss?.(entryId);
  }, [entries, onDismiss]);

  const dismissAll = React.useCallback(() => {
    cancelAutoRetry(sessionId);
    setHidden((prev) => {
      const next = new Set(prev);
      for (const e of entries ?? []) next.add(e.id);
      return next;
    });
    for (const e of entries ?? []) {
      if (e.type !== 'tool_error') onDismiss?.(e.id);
    }
  }, [entries, onDismiss, sessionId]);
  if (ordered.length === 0) return null;

  const folded = ordered.length > MAX_INLINE_ROWS;
  const restCount = ordered.length - MAX_INLINE_ROWS;

  return (
    <div
      className={`atl-anomaly${folded ? ' is-folded' : ''}${folded && foldOpen ? ' is-expanded' : ''}`}
      role="status"
      aria-live="polite"
    >
      {folded && (
        <div className="atl-anomaly__summary">
          <span className="atl-anomaly__icon" aria-hidden><IconAlert size={13} /></span>
          <span className="atl-anomaly__text">
            {isZh ? `${ordered.length} 条异常` : `${ordered.length} issues`}
            {/* 跟计数之间的气口由 CSS 的 margin-left 给 (见 .atl-anomaly__summary .atl-anomaly__meta) */}
            {!foldOpen && (
              <span className="atl-anomaly__meta">
                {isZh ? ` · 另 ${restCount} 条` : ` · ${restCount} more`}
              </span>
            )}
          </span>
          <button type="button" className="atl-anomaly__btn" onClick={dismissAll}>
            {isZh ? '全部关闭' : 'Dismiss all'}
          </button>
          <button
            type="button"
            className={`atl-anomaly__toggle${foldOpen ? ' is-open' : ''}`}
            onClick={() => setFoldOpen((v) => !v)}
            aria-expanded={foldOpen}
            title={isZh ? (foldOpen ? '收起' : '全部展开') : (foldOpen ? 'Collapse' : 'Show all')}
          >
            <IconChevronDown size={13} />
          </button>
        </div>
      )}
      <div className="atl-anomaly__list">
        {ordered.map((e) => (
          <AnomalyRow
            key={e.id}
            entry={e}
            sessionId={sessionId}
            onDismiss={handleDismiss}
            onRetry={onRetry}
            onContinue={onContinue}
            canContinue={canContinue}
          />
        ))}
      </div>
    </div>
  );
};

export default TurnAnomalyDock;
