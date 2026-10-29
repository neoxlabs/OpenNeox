/* ============================================================
 * AssistantTextCell — Agent/LLM 文本回复气泡 (设计文档 §6.2)
 *   从 MessageRow.tsx 抽出 (Phase 3.7).
 *
 *   独有特性:
 *   - streaming 时显示 dot
 *   - 空 streaming + placeholder 显 TypingIndicator (paused 时换 PausedIndicator)
 *   - 中间消息无 footer; 每一轮结论 (isLast) 显 时间 + 复制 / 朗读 / 分享 footer
 *   - header hover 出现 复制按钮 (无编辑)
 *
 *   不处理: clamp/expand (assistant 不限高), 编辑 (用户专属), XML 系统消息
 *   (MessageRow router 已分流).
 * ============================================================ */

import React, { useEffect, useMemo, useRef, useState } from 'react';
/* React.memo used below for scroll-path skip */
import { createPortal } from 'react-dom';
import type { TimelineMessage } from '../types';
import TimelineTextRenderer from '../TimelineTextRenderer';
import { MessageAttachmentChip, Lightbox } from './attachments';
import { TypingIndicator, PausedIndicator } from './indicators';
import { FooterCopyButton, SpeakButton } from './messageButtons';
import { useI18n } from '../../../hooks/useI18n';
import { useAgentModeVariant } from '../../../hooks/useAgentModeVariant';
import { useNeoxRuntime } from '../../../app/NeoxRuntimeContext';
import ShareCardModal from './ShareCardModal';

const NEXT_ACTIONS_RE = /\n?```next[-_]actions[^\n]*\n([\s\S]*?)```\s*$/i;
function extractNextActions(text: string): { actions: string[]; stripped: string } {
  if (!text) return { actions: [], stripped: text };
  const m = text.match(NEXT_ACTIONS_RE);
  if (!m) return { actions: [], stripped: text };
  const inner = (m[1] || '').trim();
  let arr: string[] = [];
  try {
    const parsed = JSON.parse(inner);
    if (Array.isArray(parsed)) {
      arr = parsed.filter((s) => typeof s === 'string' && s.trim().length > 0);
    }
  } catch {
    arr = inner.split('\n').map((l) => l.replace(/^[-*•\s"']+/, '').replace(/["']?[,，]?$/, '').trim()).filter(Boolean);
  }
  arr = arr.map((s) => s.trim()).filter(Boolean).slice(0, 4);
  const stripped = text.replace(NEXT_ACTIONS_RE, '').trimEnd();
  return { actions: arr, stripped };
}

const QuickReplyChips: React.FC<{ actions: string[] }> = ({ actions }) => {
  if (!actions.length) return null;
  const onPick = (text: string) => {
    window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text, send: true } }));
  };
  return (
    <div className="atl-quick-replies" role="group" aria-label="quick replies">
      {actions.map((a) => (
        <button
          key={a}
          type="button"
          className="atl-quick-replies__chip"
          onClick={() => onPick(a)}
        >
          {a}
        </button>
      ))}
    </div>
  );
};

interface Props {
  message: TimelineMessage;
  /** 整条会话被用户暂停 — typing placeholder 改成 "已暂停" */
  paused?: boolean;
  /** 本轮结论 (该轮最后一条 assistant) — 显 footer / 快捷回复. 多轮时每一轮结论都有, 不只整会话最后一条. */
  isLast?: boolean;
  /** 本轮 agent 还在跑 —— 这条虽然是"目前本轮最后一条", 后面还会接工具/消息, footer 先别出 */
  turnRunning?: boolean;
  /** 重新生成只对整会话最后一轮有意义 (runtime.retryLast 语义); 历史轮结论有 footer 但不挂重试 */
  allowRegenerate?: boolean;
}

/** 1234 → 1.2K；小于 1000 原样。footer 空间小, 完整数字放 title 里。 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTokensExact(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString();
}

/** footer「共消耗」点开后的输入/缓存/输出明细 */
const TurnUsagePopover: React.FC<{
  anchor: DOMRect;
  total: number;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  zh: boolean;
  onClose: () => void;
}> = ({ anchor, total, usage, zh, onClose }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => ({
    top: Math.max(8, anchor.top - 8),
    left: Math.min(window.innerWidth - 200, Math.max(8, anchor.left)),
  }));

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let top = anchor.top - r.height - 8;
    if (top < 8) top = Math.min(window.innerHeight - r.height - 8, anchor.bottom + 8);
    let left = anchor.left;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    if (left < 8) left = 8;
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const rows = usage ? [
    { key: 'in', label: zh ? '输入' : 'Input', value: usage.inputTokens, tone: 'in' as const },
    { key: 'cache', label: zh ? '缓存' : 'Cache', value: usage.cacheReadTokens, tone: 'cache' as const },
    { key: 'out', label: zh ? '输出' : 'Output', value: usage.outputTokens, tone: 'out' as const },
  ].filter((r) => r.value > 0 || r.key !== 'cache') : [];

  return createPortal(
    <div
      ref={panelRef}
      className="atl-msg__usage-pop"
      role="dialog"
      aria-label={zh ? '本轮 token 明细' : 'Turn token breakdown'}
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="atl-msg__usage-pop-title">{zh ? '本轮用量' : 'This turn'}</div>
      {rows.length > 0 ? (
        <ul className="atl-msg__usage-pop-list">
          {rows.map((r) => (
            <li key={r.key} className={`atl-msg__usage-pop-row is-${r.tone}`}>
              <span className="atl-msg__usage-pop-label">{r.label}</span>
              <span className="atl-msg__usage-pop-value" title={`${formatTokensExact(r.value)} tokens`}>
                {formatTokensExact(r.value)}
              </span>
            </li>
          ))}
          <li className="atl-msg__usage-pop-row is-total">
            <span className="atl-msg__usage-pop-label">{zh ? '合计' : 'Total'}</span>
            <span className="atl-msg__usage-pop-value">{formatTokensExact(total)}</span>
          </li>
        </ul>
      ) : (
        <div className="atl-msg__usage-pop-empty">
          {zh ? `合计 ${formatTokensExact(total)}（无明细）` : `Total ${formatTokensExact(total)} (no breakdown)`}
        </div>
      )}
    </div>,
    document.body,
  );
};

export const AssistantTextCell: React.FC<Props> = React.memo(({ message, paused = false, isLast = false, turnRunning = false, allowRegenerate = false }) => {
  const { isZh } = useI18n();
  /* Work 面向不写代码的人: token 数 / tok/s / 模型名都是给开发者看的, 页脚只留时间和操作 */
  const { isWork } = useAgentModeVariant();
  /* 重试 = 重新生成这条回复 (runtime 的 retryLast)。
   * 只挂在整会话最后一轮结论上 (allowRegenerate); 历史轮有 footer 但不挂重试. */
  const runtime = useNeoxRuntime() as any;
  const [sharing, setSharing] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageAnchor, setUsageAnchor] = useState<DOMRect | null>(null);
  const usageBtnRef = useRef<HTMLButtonElement>(null);
  const isStreaming = !!message.streaming;
  const isPlaceholder = message.id === '__pending__';
  const isEmptyStreaming = isStreaming && !message.text;
  const showTyping = isStreaming && (isPlaceholder || isEmptyStreaming);

  const [lightbox, setLightbox] = useState<{ src: string; name?: string; size?: number } | null>(null);

  /* streaming 期间不解析 chips (不完整的 fenced block 会让文字闪); 完成后再抽. */
  const { actions: quickReplies, stripped: displayText } = useMemo(() => {
    const raw = isWork ? (message.text || '').replace(/\n+[ \t]*(验证|Verification)[:：][^\n]*(未跑|not run)[^\n]*\s*$/i, '') : (message.text || '');
    return isStreaming ? { actions: [] as string[], stripped: raw } : extractNextActions(raw);
  }, [isStreaming, message.text, isWork]);

  const trimmedText = (displayText || '').trim().replace(/^[\s.。…·,，、:：;；!！?？\-—_*~`'"]+$/, '');
  const hasAttachments = !!(message.attachments && message.attachments.length > 0);
  const hasChips = isLast && quickReplies.length > 0;
  if (!trimmedText && !hasAttachments && !hasChips) {
    return null;
  }

  return (
    <div
      className={`atl-msg is-assistant${isStreaming ? ' is-streaming' : ''}${isEmptyStreaming ? ' is-pending' : ''}`}
    >
      <span className="atl-msg__rail" aria-hidden="true" />
      <div className="atl-msg__body">
        {message.attachments && message.attachments.length > 0 && (
          <div className="atl-msg__attach">
            {message.attachments.map((a) => (
              <MessageAttachmentChip key={a.id} att={a} onPreview={(url) => setLightbox({ src: url, name: a.name, size: a.size })} />
            ))}
          </div>
        )}
        {showTyping ? (
          paused
            ? <PausedIndicator />
            : <TypingIndicator label={isPlaceholder ? message.text : undefined} />
        ) : (
          (isStreaming ? displayText : trimmedText) && (
            <div className="atl-msg__text">
              <div>
                <TimelineTextRenderer content={displayText} streaming={isStreaming} />
              </div>
            </div>
          )
        )}
        {/* 快捷回复 chips — 完成后才显示, streaming 期间抽出的 fenced 可能不完整 */}
        {isLast && !isStreaming && quickReplies.length > 0 && (
          <QuickReplyChips actions={quickReplies} />
        )}
        {trimmedText && !isEmptyStreaming && isLast && !isStreaming && !turnRunning && (
          <div className="atl-msg__footer atl-msg__footer--last">
            {(message.timestamp || (!isWork && message.model)) && (
              <span className="atl-msg__footer-meta">
                {message.timestamp && <span className="atl-msg__footer-time">{message.timestamp}</span>}
                {!isWork && message.model && <span className="atl-msg__footer-model" title={message.model}>{message.model}</span>}
              </span>
            )}
            <span className="atl-msg__footer-acts">
            <FooterCopyButton text={displayText || message.text} />
            {/* 朗读/停止 — TTS 在念时是停止方块, 平时是小喇叭重播本条 */}
            <SpeakButton text={displayText || message.text} quiet />
            <button
              type="button"
              className="atl-msg__footer-btn atl-msg__footer-btn--quiet"
              onClick={() => setSharing(true)}
              title={isZh ? '分享为图片' : 'Share as image'}
              aria-label={isZh ? '分享为图片' : 'Share as image'}
              data-label={isZh ? '分享' : 'Share'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
              </svg>
            </button>
            {/* 重新生成 —— 仅整会话最后一轮 (retryLast 只能重发上一条 prompt). */}
            {allowRegenerate && typeof runtime?.retryLast === 'function' && (
              <button
                type="button"
                className="atl-msg__footer-btn"
                onClick={() => { void runtime.retryLast(); }}
                title={isZh ? '重新生成' : 'Regenerate'}
                aria-label={isZh ? '重试' : 'Retry'}
                data-label={isZh ? '重试' : 'Retry'}
              >
                <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 7 a4 4 0 1 0 1.5 -3.0" />
                  <path d="M3 2 V5 H6" />
                </svg>
              </button>
            )}
            {!isWork && message.turnTokens && (
              <span className="atl-msg__footer-usage">
                {message.turnTokens ? (
                  <button
                    type="button"
                    ref={usageBtnRef}
                    className={`atl-msg__footer-usage-tokens${usageOpen ? ' is-open' : ''}`}
                    aria-expanded={usageOpen}
                    aria-haspopup="dialog"
                    title={isZh
                      ? `本轮消耗 ${message.turnTokens.toLocaleString()} tokens · 点击查看输入/缓存/输出`
                      : `${message.turnTokens.toLocaleString()} tokens this turn · Click for input / cache / output`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (usageOpen) {
                        setUsageOpen(false);
                        setUsageAnchor(null);
                        return;
                      }
                      const rect = usageBtnRef.current?.getBoundingClientRect()
                        ?? (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                      setUsageAnchor(rect);
                      setUsageOpen(true);
                    }}
                  >
                    {formatTokens(message.turnTokens)} tokens
                  </button>
                ) : null}
                {/* 生成速度: 口径写在 title 里, 因为光看 42 tok/s 会以为是整轮平均,
                    其实工具执行的时间不算在内 (量的是首个到最后一个 token 那段窗口)。 */}
                {typeof message.turnTps === 'number' && message.turnTps > 0 ? (
                  <span
                    className="atl-msg__footer-usage-tps"
                    title={isZh
                      ? `生成速度 ${message.turnTps} tokens/秒 (只算首个 token 到最后一个 token 的时间, 不含工具执行)`
                      : `${message.turnTps} tokens/sec while generating (excludes tool execution time)`}
                  >
                    {message.turnTps} tok/s
                  </span>
                ) : null}
              </span>
            )}
            </span>
          </div>
        )}
      </div>
      {lightbox && <Lightbox src={lightbox.src} name={lightbox.name} size={lightbox.size} onClose={() => setLightbox(null)} />}
      {usageOpen && usageAnchor && message.turnTokens ? (
        <TurnUsagePopover
          anchor={usageAnchor}
          total={message.turnTokens}
          usage={message.turnUsage}
          zh={isZh}
          onClose={() => { setUsageOpen(false); setUsageAnchor(null); }}
        />
      ) : null}
      {sharing && (
        <ShareCardModal
          text={displayText || message.text}
          model={message.model}
          tokens={message.turnTokens}
          zh={isZh}
          onClose={() => setSharing(false)}
        />
      )}
    </div>
  );
}, (prev, next) => (
  prev.message === next.message
  && !!prev.paused === !!next.paused
  && !!prev.isLast === !!next.isLast
  && !!prev.turnRunning === !!next.turnRunning
  && !!prev.allowRegenerate === !!next.allowRegenerate
));
