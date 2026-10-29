import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContextTokenBreakdown } from '@neoxlabs/kernel/utils/contextBreakdown.js';
import type { LatestRequestUsage } from '../../../pages/workspace/utils';
/* SessionCacheUsage 住在 **neox-platform**, 不在 neox-core —— 原来从
 * '@neoxlabs/core/shared/ipc/context' 引, 那个模块里没有这个导出 (TS2305)。
 * 是 import type, 运行时会被擦除所以不崩; 但类型解析失败后, 下面用它标注的
 * sessionCache props **全部失去检查** —— 类型写了等于没写。
 * 走 ui/shared/ipc 这个公开入口 (它 export * 自 platform), 直连
 * '@neoxlabs/platform/shared/ipc' 会被 check:boundaries 判成新增深引。 */
import type { SessionCacheUsage } from '../../../../shared/ipc';
import { getGlobalLanguage } from '../../../hooks/useI18n';
import ContextTank from './ContextTank';
import './contextPopup.css';

const L = (zh: string, en: string): string => (getGlobalLanguage() === 'zh' ? zh : en);

export interface ContextCompactControl {
  onCompact: () => void;
  /** 压缩进行中 (手动或自动) —— 量筒播压液动画 */
  active: boolean;
  /** 分桶进度 0..100; 单次摘要没有进度时为 null */
  pct: number | null;
  /** 不可点的原因; null = 可点 */
  disabledReason: string | null;
}

interface ContextDetailProps {
  contextUsed: number;
  maxContext: number;
  totalTokens?: number;
  memorySnapshot?: {
    tokensUsed: number;
    contextWindow?: number;
    state?: string;
    pressure?: number;
    byType?: Record<string, { count: number; tokens: number }>;
    breakdown?: ContextTokenBreakdown;
  } | null;
  latestRequestUsage?: LatestRequestUsage | null;
  sessionCache?: SessionCacheUsage | null;
  /** 按会话 hydrate — 禁止用 'current' 以免串到别的会话 */
  sessionId?: string;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLDivElement | null>;
  compact?: ContextCompactControl;
}

const formatK = (n: number): string => {
  if (n >= 1_000_000) {
    const value = n / 1_000_000;
    const nearest = Math.round(value);
    if (nearest >= 1 && Math.abs(value - nearest) <= 0.11) return `${nearest}M`;
    return `${value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString();
};

/** 量筒里自下而上的顺序 */
const LAYER_ORDER = ['system', 'tools', 'messages'];

const toPercent =(tokens: number, total: number): number => {
  if (total <= 0 || tokens <= 0) return 0;
  return Math.round((tokens / total) * 100);
};

type BreakdownLike = Partial<ContextTokenBreakdown> & {
  userTokens?: number;
  assistantTokens?: number;
  toolCallTokens?: number;
  toolResultTokens?: number;
  totalTokens?: number;
};

type BreakdownChild = { key: string; label: string; tokens: number };

const positive = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
);

const sumTokens = (items: BreakdownChild[]): number => items.reduce((total, item) => total + positive(item.tokens), 0);

const hasDetailedBreakdown = (breakdown?: BreakdownLike | null): boolean => {
  const details = breakdown?.details;
  return !!details && Object.values(details).some(value => positive(value) > 0);
};

const legacyScore = (breakdown?: BreakdownLike | null): number => {
  if (!breakdown) return 0;
  return [
    breakdown.userTokens,
    breakdown.assistantTokens,
    breakdown.toolCallTokens,
    breakdown.toolResultTokens,
  ].filter(value => positive(value) > 0).length;
};

const resolveBreakdown = (
  requestBreakdown?: BreakdownLike | null,
  memoryBreakdown?: BreakdownLike | null,
): BreakdownLike | undefined => {
  if (hasDetailedBreakdown(requestBreakdown)) return requestBreakdown || undefined;
  if (hasDetailedBreakdown(memoryBreakdown)) return memoryBreakdown || undefined;
  if (legacyScore(memoryBreakdown) > legacyScore(requestBreakdown)) return memoryBreakdown || undefined;
  return requestBreakdown || memoryBreakdown || undefined;
};

const buildGroups = (breakdown?: BreakdownLike, byType?: Record<string, { count: number; tokens: number }>) => {
  const details = hasDetailedBreakdown(breakdown) ? breakdown?.details : undefined;
  const systemTokens = positive(breakdown?.systemTokens);
  const legacyMessageChildren = [
    { key: 'userTextTokens', label: L('用户文本', 'User Text'), tokens: positive(breakdown?.userTokens) },
    { key: 'assistantTextTokens', label: L('助手文本', 'Assistant Text'), tokens: positive(breakdown?.assistantTokens) },
  ].filter(item => item.tokens > 0);
  const legacyToolChildren = [
    { key: 'toolCallTokens', label: L('工具调用', 'Tool Calls'), tokens: positive(breakdown?.toolCallTokens) },
    { key: 'toolResultTokens', label: L('工具结果', 'Tool Results'), tokens: positive(breakdown?.toolResultTokens) },
  ].filter(item => item.tokens > 0);
  const messageTokens = positive(breakdown?.messageTokens) || sumTokens(legacyMessageChildren);
  const toolTokens = positive(breakdown?.toolTokens) || sumTokens(legacyToolChildren);
  const fallbackMessageChildren = legacyMessageChildren.length > 0
    ? legacyMessageChildren
    : [{ key: 'messageTokens', label: L('消息历史', 'Message History'), tokens: messageTokens }].filter(item => item.tokens > 0);
  const fallbackToolChildren = legacyToolChildren.length > 0
    ? legacyToolChildren
    : [{ key: 'toolTokens', label: L('工具上下文', 'Tool Context'), tokens: toolTokens }].filter(item => item.tokens > 0);

  if (!systemTokens && !messageTokens && !toolTokens && byType) {
    const systemFallback = byType.system?.tokens || byType.ephemeral?.tokens || 0;
    const toolFallback = byType.tools?.tokens || byType.tool?.tokens || 0;
    const messageFallback = byType.messages?.tokens || byType.contextual?.tokens || 0;
    return [
      { key: 'system', label: L('系统', 'System'), color: '#8a93a6', tokens: systemFallback, children: [] },
      { key: 'messages', label: L('消息', 'Messages'), color: '#41a0ff', tokens: messageFallback, children: [] },
      { key: 'tools', label: L('工具', 'Tools'), color: '#f2a33a', tokens: toolFallback, children: [] },
    ].filter(group => group.tokens > 0);
  }

  return [
    {
      key: 'system',
      label: L('系统', 'System'),
      color: '#8a93a6',
      tokens: systemTokens,
      children: [
        { key: 'systemPromptTokens', label: L('系统提示词', 'System Prompt'), tokens: details ? positive(details.systemPromptTokens) : systemTokens },
        { key: 'hiddenInstructionsTokens', label: L('隐藏指令', 'Hidden Instructions'), tokens: positive(details?.hiddenInstructionsTokens) },
        { key: 'agentPrefixTokens', label: L('Agent 前缀', 'Agent Prefix'), tokens: positive(details?.agentPrefixTokens) },
      ].filter(item => item.tokens > 0),
    },
    {
      key: 'messages',
      label: L('消息', 'Messages'),
      color: '#41a0ff',
      tokens: messageTokens,
      children: details
        ? [
          { key: 'userTextTokens', label: L('用户文本', 'User Text'), tokens: positive(details.userTextTokens) },
          { key: 'assistantTextTokens', label: L('助手文本', 'Assistant Text'), tokens: positive(details.assistantTextTokens) },
          { key: 'attachmentTextTokens', label: L('附件文本', 'Attachment Text'), tokens: positive(details.attachmentTextTokens) },
          { key: 'imageDescriptionTokens', label: L('图片描述', 'Image Descriptions'), tokens: positive(details.imageDescriptionTokens) },
          { key: 'fileDescriptionTokens', label: L('文件描述', 'File Descriptions'), tokens: positive(details.fileDescriptionTokens) },
        ].filter(item => item.tokens > 0)
        : fallbackMessageChildren,
    },
    {
      key: 'tools',
      label: L('工具', 'Tools'),
      color: '#f2a33a',
      tokens: toolTokens,
      children: details
        ? [
          { key: 'toolDefinitionsTokens', label: L('工具定义', 'Tool Definitions'), tokens: positive(details.toolDefinitionsTokens) },
          { key: 'toolCallTokens', label: L('工具调用', 'Tool Calls'), tokens: positive(details.toolCallTokens) || positive(breakdown?.toolCallTokens) },
          { key: 'toolResultTokens', label: L('工具结果', 'Tool Results'), tokens: positive(details.toolResultTokens) || positive(breakdown?.toolResultTokens) },
        ].filter(item => item.tokens > 0)
        : fallbackToolChildren,
    },
  ].filter(group => group.tokens > 0);
};

const ContextDetailPopup: React.FC<ContextDetailProps> = ({
  contextUsed,
  maxContext,
  memorySnapshot,
  latestRequestUsage,
  sessionCache,
  sessionId,
  onClose,
  anchorRef,
  compact,
}) => {
  const popupRef = useRef<HTMLDivElement>(null);
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({});

  /* 重启/长时间后重开: renderer 内存快照是空的, 但 sessions 表持久化了最后一轮 usage
   * (latest_request_usage) 和累积快照 (session_usage) — 挂载时兜底回读一次, 不再空白。
   * 必须按精确 sessionId 拉, 禁止 'current' 跨会话 fallback. */
  const [hydrated, setHydrated] = useState<{
    latestRequestUsage?: LatestRequestUsage | null;
    sessionCache?: SessionCacheUsage | null;
    breakdown?: BreakdownLike | null;
  } | null>(null);
  useEffect(() => {
    setHydrated(null);
    if (latestRequestUsage && sessionCache) return;
    if (!sessionId) return;
    const api = (window as any).neox;
    api?.contextGetUsage?.(sessionId)
      .then((data: any) => { if (data) setHydrated(data); })
      .catch(() => {});
    // 只在打开弹窗 / 切会话时拉一次; 实时更新仍走 metrics 事件 → props/快照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  const effLatestRequestUsage = latestRequestUsage ?? hydrated?.latestRequestUsage ?? null;
  const effSessionCache = sessionCache ?? hydrated?.sessionCache ?? null;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      /* 点锚点 (电池按钮) 交给按钮自己切换 —— 这里先关、按钮 click 又打开, 就关不掉了 */
      if (anchorRef?.current?.contains(target)) return;
      if (popupRef.current && !popupRef.current.contains(target)) {
        onClose();
      }
    };
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 10);
    document.addEventListener('keydown', handleEsc);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose, anchorRef]);

  useEffect(() => {
    const updatePosition = () => {
      const anchor = anchorRef?.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const margin = 8;
      const gap = 10;
      const popupWidth = Math.min(376, Math.max(320, viewportWidth - 16));
      const measuredHeight = popupRef.current?.getBoundingClientRect().height || 0;
      const popupHeight = measuredHeight > 0
        ? measuredHeight
        : Math.min(560, viewportHeight - margin * 2);

      const anchorCenterX = rect.left + rect.width / 2;
      let left = anchorCenterX - popupWidth / 2;
      left = Math.max(margin, Math.min(left, viewportWidth - popupWidth - margin));

      // 优先显示在电池上方，底边贴近锚点；空间不足再放下方
      const availableAbove = rect.top - gap - margin;
      const availableBelow = viewportHeight - rect.bottom - gap - margin;
      const placeAbove = availableAbove >= 220 || availableAbove >= availableBelow;
      const maxHeight = Math.max(220, placeAbove ? availableAbove : availableBelow);
      const visibleHeight = Math.min(popupHeight, maxHeight);
      let top = placeAbove
        ? rect.top - gap - visibleHeight
        : rect.bottom + gap;
      top = Math.max(margin, Math.min(top, viewportHeight - visibleHeight - margin));

      setPopupStyle({
        position: 'fixed',
        left,
        top,
        zIndex: 12000,
        maxHeight: `${Math.floor(maxHeight)}px`,
      });
    };

    updatePosition();
    const rafId = window.requestAnimationFrame(updatePosition);
    const popupNode = popupRef.current;
    const observer = (typeof ResizeObserver !== 'undefined' && popupNode)
      ? new ResizeObserver(() => updatePosition())
      : null;
    if (observer && popupNode) {
      observer.observe(popupNode);
    }
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.cancelAnimationFrame(rafId);
      observer?.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorRef, contextUsed, maxContext, latestRequestUsage, memorySnapshot, sessionCache, hydrated]);

  const contextWindow = maxContext > 0 ? maxContext : (memorySnapshot?.contextWindow ?? 128000);
  const tokensUsed = contextUsed || 0;
  const pressure = contextWindow > 0 ? tokensUsed / contextWindow : 0;
  const percentDisplay = tokensUsed > 0 ? Math.max(1, Math.min(100, Math.round(pressure * 100))) : 0;
  const remaining = Math.max(0, contextWindow - tokensUsed);
  const compactionLimit = Math.floor(contextWindow * 0.7);
  const tokensUntilCompaction = Math.max(0, compactionLimit - tokensUsed);

  const requestInput = effLatestRequestUsage?.inputTokens || 0;
  const requestOutput = effLatestRequestUsage?.outputTokens || 0;
  const requestCacheRead = effLatestRequestUsage?.cacheReadTokens || 0;
  const requestCacheWrite = effLatestRequestUsage?.cacheWriteTokens || 0;
  const requestBaseInput = Math.max(
    0,
    effLatestRequestUsage?.billableInputTokens ?? (requestInput - requestCacheRead - requestCacheWrite),
  );
  const requestContextInput = Math.max(0, requestInput || (requestBaseInput + requestCacheRead + requestCacheWrite));
  const requestDisplayTotal = requestBaseInput + requestCacheRead + requestCacheWrite + requestOutput;
  const breakdown = useMemo(
    () => resolveBreakdown(effLatestRequestUsage?.breakdown, memorySnapshot?.breakdown ?? hydrated?.breakdown),
    [effLatestRequestUsage?.breakdown, memorySnapshot?.breakdown, hydrated?.breakdown],
  );
  const groups = useMemo(() => buildGroups(breakdown, memorySnapshot?.byType), [breakdown, memorySnapshot?.byType]);
  const breakdownCacheRatio = requestContextInput > 0
    ? Math.max(0, Math.min(1, requestCacheRead / requestContextInput))
    : 0;
  const requestHitRatePercent = Math.round(breakdownCacheRatio * 100);

  if (typeof window !== 'undefined' && localStorage.getItem('neox-ui-debug') === '1') {
    console.log('[ContextDetailPopup]', {
      contextUsed,
      maxContext,
      requestBreakdown: effLatestRequestUsage?.breakdown,
      memoryBreakdown: memorySnapshot?.breakdown,
      resolvedBreakdown: breakdown,
      breakdownCacheRatio,
      groups,
    });
  }
  const hasSessionCacheStats = !!effSessionCache && effSessionCache.requests > 0;
  const sessionHitRatePercent = Math.round(Math.max(0, Math.min(1, effSessionCache?.hitRate || 0)) * 100);
  const sessionBaseInput = effSessionCache?.baseInputTokens || 0;
  const sessionCacheRead = effSessionCache?.cacheReadTokens || 0;
  const sessionCacheWrite = effSessionCache?.cacheWriteTokens || 0;
  const sessionOutput = effSessionCache?.outputTokens || 0;
  const sessionRequests = effSessionCache?.requests || 0;
  const sessionDisplayTotal = sessionBaseInput + sessionCacheRead + sessionCacheWrite + sessionOutput;

  /* 本轮 / 累积 两个 tab。默认本轮; 本轮暂无数据(如 provider 丢 usage 字段)而累积有 → 落到累积 */
  const [usageTab, setUsageTab] = useState<'request' | 'session'>(
    () => (requestDisplayTotal > 0 || !hasSessionCacheStats ? 'request' : 'session'),
  );

  const legendGroups = useMemo(() => {
    if (groups.length > 0) return [...groups].sort((a, b) => LAYER_ORDER.indexOf(b.key) - LAYER_ORDER.indexOf(a.key));
    return tokensUsed > 0 ? [{ key: 'used', label: L('已用', 'Used'), color: '#41a0ff', tokens: tokensUsed, children: [] }] : [];
  }, [groups, tokensUsed]);
  const tankLayers = useMemo(() => {
    const sum = legendGroups.reduce((s, g) => s + g.tokens, 0);
    const scale = sum > 0 && contextWindow > 0 ? tokensUsed / sum / contextWindow : 0;
    return [...legendGroups].reverse().map(g => ({ key: g.key, color: g.color, fraction: Math.min(1, g.tokens * scale) }));
  }, [legendGroups, tokensUsed, contextWindow]);
  const genMs = effLatestRequestUsage?.generationMs || 0;
  const tokPerSec = genMs > 0 && requestOutput > 0 ? (requestOutput / genMs) * 1000 : 0;
  const firstTokenMs = effLatestRequestUsage?.firstTokenMs || 0;

  const scope = usageTab === 'session' && hasSessionCacheStats
    ? { base: sessionBaseInput, read: sessionCacheRead, write: sessionCacheWrite, out: sessionOutput, total: sessionDisplayTotal, hit: sessionHitRatePercent }
    : { base: requestBaseInput, read: requestCacheRead, write: requestCacheWrite, out: requestOutput, total: requestDisplayTotal, hit: requestHitRatePercent };
  const parts = [
    { key: 'in', label: L('未命中缓存', 'Uncached'), tokens: scope.base, color: '#8a93a6' },
    { key: 'read', label: L('缓存读取', 'Cache read'), tokens: scope.read, color: '#41a0ff' },
    { key: 'write', label: L('缓存写入', 'Cache write'), tokens: scope.write, color: '#9ccdff' },
    { key: 'out', label: L('输出', 'Output'), tokens: scope.out, color: '#f2a33a' },
  ];
  const usageEmpty = usageTab === 'session' ? !hasSessionCacheStats : requestDisplayTotal <= 0;
  const usageNote = usageTab === 'session'
    ? L(`${formatK(sessionRequests)} 次请求 · 含子 Agent`, `${formatK(sessionRequests)} requests · incl. sub-agents`)
    : L('最近一次请求', 'Latest request');

  const content = (
    <div className="context-popup cxp" ref={popupRef} style={popupStyle}>
      <section className="cxp-hero">
        <ContextTank layers={tankLayers} compactAt={0.7} compressing={!!compact?.active} />
        <div className="cxp-hero__body">
          <div className="cxp-hero__nums">
            <b>{formatK(tokensUsed)}</b>
            <span>/ {formatK(contextWindow)}</span>
            <em className={pressure > 0.8 ? 'is-warn' : ''}>{percentDisplay}%</em>
          </div>
          <div className="cxp-rows">
            {legendGroups.map(group => (
              <BreakdownGroup
                key={group.key}
                label={group.label}
                color={group.color}
                tokens={group.tokens}
                total={contextWindow}
                children={group.children}
              />
            ))}
            <BreakdownRow label={L('剩余', 'Free')} tokens={remaining} total={contextWindow} color="var(--cxp-free)" />
          </div>
          <div className={`cxp-hero__meta${tokensUntilCompaction > 0 ? '' : ' is-warn'}`}>
            <i />
            {tokensUntilCompaction > 0
              ? L(`距自动压缩 ${formatK(tokensUntilCompaction)}`, `${formatK(tokensUntilCompaction)} to auto-compact`)
              : L('已到压缩线', 'At the compaction line')}
          </div>
          {compact && (
            <button
              type="button"
              className={`cxp-compact${compact.active ? ' is-active' : ''}`}
              onClick={compact.onCompact}
              disabled={compact.active || !!compact.disabledReason}
              title={compact.disabledReason ?? undefined}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 2.5h8M4 13.5h8M8 4.5v2.5M6.3 5.6 8 7.2l1.7-1.6M8 11.5V9M6.3 10.4 8 8.8l1.7 1.6" />
              </svg>
              <span>
                {compact.active
                  ? L(`压缩中${compact.pct != null ? ` ${compact.pct}%` : '…'}`, `Compacting${compact.pct != null ? ` ${compact.pct}%` : '…'}`)
                  : compact.disabledReason ?? L('压缩上下文', 'Compact context')}
              </span>
              {compact.active && compact.pct != null && <i style={{ width: `${compact.pct}%` }} />}
            </button>
          )}
        </div>
      </section>

      <section className="cxp-stats">
        <div className="cxp-stat">
          <span>{L('缓存命中', 'Cache hit')}</span>
          <b>{requestContextInput > 0 ? `${requestHitRatePercent}%` : '—'}</b>
          <small>{hasSessionCacheStats ? L(`会话 ${sessionHitRatePercent}%`, `Session ${sessionHitRatePercent}%`) : L('本次请求', 'Latest')}</small>
        </div>
        <div className="cxp-stat">
          <span>{L('输出速度', 'Output speed')}</span>
          <b>{tokPerSec > 0 ? <>{tokPerSec >= 100 ? Math.round(tokPerSec) : tokPerSec.toFixed(1)}<em>tok/s</em></> : '—'}</b>
          <small>{requestOutput > 0 ? L(`输出 ${formatK(requestOutput)}`, `${formatK(requestOutput)} out`) : L('本次请求', 'Latest')}</small>
        </div>
        <div className="cxp-stat">
          <span>{L('首字延迟', 'First token')}</span>
          <b>{firstTokenMs > 0 ? <>{(firstTokenMs / 1000).toFixed(firstTokenMs >= 10_000 ? 0 : 1)}<em>s</em></> : '—'}</b>
          <small>{L('本次请求', 'Latest')}</small>
        </div>
      </section>

      <section className="cxp-panel">
        <div className="cxp-panel__head">
          <h4>{L('用量', 'Usage')}</h4>
          <div className="cxp-seg" role="tablist">
            {(['request', 'session'] as const).map(t => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={usageTab === t}
                className={usageTab === t ? 'is-on' : ''}
                onClick={() => setUsageTab(t)}
              >
                {t === 'request' ? L('本次请求', 'Request') : L('会话累计', 'Session')}
              </button>
            ))}
          </div>
        </div>
        {usageEmpty ? (
          <div className="cxp-empty">
            {usageTab === 'session' ? L('本会话还没有用量', 'No session usage yet') : L('最近一次请求没有返回用量', 'No usage reported for the last request')}
          </div>
        ) : (
          <>
            <div className="cxp-stack">
              {parts.map(p => p.tokens > 0 ? (
                <i key={p.key} style={{ width: `${(p.tokens / scope.total) * 100}%`, background: p.color }} title={`${p.label}: ${formatK(p.tokens)}`} />
              ) : null)}
            </div>
            <div className="cxp-tiles">
              {parts.map(p => (
                <div key={p.key} className="cxp-tile">
                  <span><i style={{ background: p.color }} />{p.label}</span>
                  <b>{formatK(p.tokens)}</b>
                </div>
              ))}
            </div>
            <div className="cxp-note">
              <span>{usageNote}</span>
            </div>
          </>
        )}
      </section>

      <RateLimitSection />
    </div>
  );

  return createPortal(content, document.body);
};

const RateLimitSection: React.FC = () => {
  const [usage, setUsage] = useState<Array<{
    windowId: string;
    label: string;
    requests: number;
    tokens: number;
    maxRequests: number;
    maxTokens: number;
    requestUsage: number;
  }>>([]);

  useEffect(() => {
    // getRateLimitUsage 在 window.neox 上 (preload.cjs:754), 不是 window.api (历史笔误)。
    const api = (window as any).neox;
    if (api?.getRateLimitUsage) {
      api.getRateLimitUsage().then((data: any) => {
        if (Array.isArray(data)) setUsage(data);
      }).catch(() => {});
    }
  }, []);

  const hasUsage = usage.some(u => u.requests > 0);
  if (!hasUsage) return null;

  return (
    <section className="cxp-panel">
      <div className="cxp-panel__head"><h4>{L('速率限制', 'Rate limit')}</h4></div>
      {usage.filter(u => u.requests > 0).map(u => {
        const pct = u.maxRequests > 0 ? Math.min(100, Math.round((u.requests / u.maxRequests) * 100)) : -1;
        return (
          <div key={u.windowId} className="cxp-limit">
            <div className="cxp-limit__head">
              <span>{u.label}</span>
              <span>{u.requests}{u.maxRequests > 0 ? ` / ${u.maxRequests}` : ''} {L('次', 'req')} · {formatK(u.tokens)}</span>
            </div>
            {pct >= 0 && (
              <div className="cxp-bar cxp-bar--thin">
                <i className={pct >= 80 ? 'is-critical' : pct >= 50 ? 'is-warn' : ''} style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
};

/* 构成一行: 点开看子项 (默认收起, 跟设置页一样) */
const BreakdownGroup: React.FC<{
  label: string;
  color: string;
  tokens: number;
  total: number;
  children: Array<{ key: string; label: string; tokens: number }>;
}> = ({ label, color, tokens, total, children }) => {
  const [open, setOpen] = useState(false);
  const expandable = children.length > 0;
  return (
    <>
      <BreakdownRow
        label={label}
        tokens={tokens}
        total={total}
        color={color}
        expandable={expandable}
        open={open}
        onToggle={expandable ? () => setOpen(v => !v) : undefined}
      />
      {open && children.map(item => (
        <BreakdownRow key={item.key} label={item.label} tokens={item.tokens} total={total} color={color} sub />
      ))}
    </>
  );
};

const BreakdownRow: React.FC<{
  label: string;
  tokens: number;
  total: number;
  color: string;
  sub?: boolean;
  expandable?: boolean;
  open?: boolean;
  onToggle?: () => void;
}> = ({ label, tokens, total, color, sub, expandable, open, onToggle }) => {
  const percent = toPercent(tokens, total);
  const Tag = onToggle ? 'button' : 'div';
  return (
    <Tag
      {...(onToggle ? { type: 'button' as const, onClick: onToggle, 'aria-expanded': open } : {})}
      className={`cxp-row${sub ? ' is-sub' : ''}${onToggle ? ' is-click' : ''}`}
    >
      <span className="cxp-row__dot" style={{ background: color, opacity: sub ? 0.45 : 1 }}>
        {expandable && <svg className={open ? 'is-open' : ''} viewBox="0 0 8 8" width="7" height="7" aria-hidden="true"><path d="M2.5 1.5 5.5 4l-3 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </span>
      <span className="cxp-row__name">{label}</span>
      <span className="cxp-row__tok">{formatK(tokens)}</span>
      <span className="cxp-row__pct">{percent}%</span>
    </Tag>
  );
};

export default ContextDetailPopup;
