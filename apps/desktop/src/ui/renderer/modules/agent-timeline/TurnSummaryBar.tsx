/**
 * TurnSummaryBar — composer 上方的审阅条 (Allow / Deny).
 *
 * 信息源: timeline 末尾最近 type='turn_summary'.
 * 时间线里已有「本轮改动」汇总卡 → **不再重复渲染文件列表** (用户 2026-07 反馈叠两层).
 * 本组件只在有真实 edit hunk 待审时显示精简操作条; 纯 write_file 新建不弹.
 * 点药丸主体 → 向上弹出待审文件列表 (跟计划 / 后台任务同一套 panel 动画).
 *
 * 副作用: 始终把本轮改动 sync 进 agentTurnEditsStore, 供 IDE 顶栏审阅条使用.
 *
 * agent 还在跑 (streaming=true) 时不显示.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { TimelineEntry } from '../../utils/workspaceUtils';
import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';
import { resolveWorkspacePath } from '../../utils/pathUtils';
import { aggregateTurnChanges } from './aggregateTurnChanges';
import { useI18n } from '../../hooks/useI18n';
import { setAgentTurnEdits, clearAgentTurnEdits, type AgentTurnFileEdit } from '../../state/agentTurnEditsStore';
import { dispatchHint } from '../../components/notifyEvents';
import { openSurfaceFromPath } from '../../state/openSurfaceFromPath';
import { FILE_REVERTED_EVENT } from './cells/revertFileChange';
import { acceptAllTurnEdits, revertAllTurnEdits } from '../../state/turnEditsBulk';
import { FileTypeIcon } from '../../components/FileTypeIcon';
import DockRail from './dock/DockRail';
import type { DockPill } from './dock/dockTypes';

interface Props {
  /** 当前 session timeline */
  timeline: TimelineEntry[];
  /** agent 在跑时隐藏 — 用户应该关注新动作而不是上一轮汇总 */
  streaming: boolean;
}

function hasSuspiciousZeroSummary(changes?: NonNullable<TimelineEntry['summaryChanges']>): boolean {
  if (!changes || changes.length === 0) return false;
  return changes.some((c) =>
    (c.addCount || 0) === 0
    && (c.delCount || 0) === 0
    && (
      ((c as any).editHunks?.length || 0) > 0
      || ((c.changedLines?.length || 0) > 0 && c.op !== 'delete' && c.op !== 'rename')
    ),
  );
}

function lineCountOf(s: string | undefined): number {
  if (!s) return 0;
  const parts = s.split('\n');
  return parts.length > 1 && parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

function repairPersistedZeroChanges(changes: NonNullable<TimelineEntry['summaryChanges']>) {
  return changes.map((c) => {
    let addCount = c.addCount || 0;
    let delCount = c.delCount || 0;
    if (addCount === 0 && delCount === 0) {
      const hunks = (c as any).editHunks as Array<{ oldString?: string; newString?: string }> | undefined;
      if (hunks && hunks.length > 0) {
        addCount = hunks.reduce((s, h) => s + lineCountOf(h.newString), 0);
        delCount = hunks.reduce((s, h) => s + lineCountOf(h.oldString), 0);
      } else if (c.changedLines && c.op !== 'delete' && c.op !== 'rename') {
        for (const l of c.changedLines) {
          const n = Math.max(0, (l.end ?? l.start) - l.start + 1);
          if (l.kind === 'add') addCount += n;
          else if (l.kind === 'del') delCount += n;
          else { addCount += n; delCount += n; }
        }
      }
    }
    return { ...c, addCount, delCount };
  });
}

function fileBaseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

export function useTurnReviewPill({ timeline, streaming }: Props): DockPill | null {
  const runtime = useNeoxRuntimeOptional();
  const { isZh } = useI18n();
  const sessionId = runtime?.activeSession?.id;
  const workspacePath = runtime?.workspacePath;

  /* 找最近一条 turn_summary entry — 反向遍历, O(1) 命中常见情况.
   * 不再要求 summaryChanges 非空 — 实际 +/- 由 aggregator 现场跑出来, 不依赖 persisted 字段. */
  const latest = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const e = timeline[i]!;
      if (e.type === 'turn_summary') return e;
    }
    return null;
  }, [timeline]);

  const turnId = latest?.summaryTurnId || latest?.id || '';
  const storageKey = sessionId && turnId ? `neox:turnSummaryBar:${sessionId}:${turnId}` : '';
  const dismissKey = storageKey ? `${storageKey}:dismissed` : '';

  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!dismissKey) return;
    try {
      setDismissed(sessionStorage.getItem(dismissKey) === '1');
    } catch { /* sessionStorage 可能不可用, 走默认值 */ }
  }, [dismissKey]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try { if (dismissKey) sessionStorage.setItem(dismissKey, '1'); } catch { /* */ }
  }, [dismissKey]);

  /* +/- 数据统一采用工具调用累计口径:
   *   1. 能拿到本 turn 的 timeline slice → 现场重跑 aggregator, 新旧 turn_summary 都跟明细 edit/write 对齐
   *   2. 拿不到 slice (测试/残缺历史) → 才退到 persisted summaryChanges, 并修复老的 +0 -0 */
  const latestId = latest?.id;
  const latestTurnId = latest?.summaryTurnId;
  const changes = useMemo(() => {
    if (!latest) return [] as NonNullable<TimelineEntry['summaryChanges']>;
    const persisted = latest.summaryChanges ?? [];
    if (latestTurnId) {
      const userIdx = timeline.findIndex(e => e.id === latestTurnId);
      const summaryIdx = timeline.findIndex(e => e.id === latestId);
      if (userIdx >= 0 && summaryIdx > userIdx) {
        const slice = timeline.slice(userIdx, summaryIdx);
        const fresh = aggregateTurnChanges(slice, workspacePath);
        if (fresh && fresh.changes.length > 0) return fresh.changes;
      }
    }
    return hasSuspiciousZeroSummary(persisted) ? repairPersistedZeroChanges(persisted) : persisted;
  }, [latest, latestId, latestTurnId, timeline, workspacePath]);

  /* 同步到 IDE 审阅 store — 即使 bar dismissed/streaming 也要更新, 编辑器顶栏才能看见. */
  useEffect(() => {
    if (!sessionId) return;
    if (!latest || streaming || changes.length === 0) {
      if (!streaming && !latest) clearAgentTurnEdits(sessionId);
      return;
    }
    const files: AgentTurnFileEdit[] = changes.map((c) => ({
      path: resolveWorkspacePath(c.path, workspacePath),
      addCount: c.addCount,
      delCount: c.delCount,
      changedLines: c.changedLines,
      editHunks: (c as any).editHunks,
    }));
    setAgentTurnEdits(sessionId, turnId || latest.id, files);
  }, [sessionId, latest, streaming, changes, workspacePath, turnId]);

  const updateHunkReview = runtime?.updateHunkReview;
  const [bulkBusy, setBulkBusy] = useState(false);
  /* 面板里当前点开的文件 — 给行 is-active 选中态 (跟本轮改动卡同级反馈) */
  const [activePath, setActivePath] = useState<string | null>(null);

  const pendingHunks = useMemo(() => {
    const out: Array<{ path: string; h: any; i: number }> = [];
    for (const c of changes) {
      /* 纯新建 (write / oldString 空) 不是"待审编辑" — 时间线汇总卡已够, 别再弹全部接受. */
      if (c.op === 'write' || c.op === 'delete' || c.op === 'rename') continue;
      const hunks = (c as any).editHunks as any[] | undefined;
      if (!hunks?.length) continue;
      const abs = resolveWorkspacePath(c.path, workspacePath);
      hunks.forEach((h, i) => {
        const st = h.review ?? 'pending';
        if (!(typeof h.oldString === 'string' && h.oldString.length > 0)) return;
        if (st === 'pending' && !h.previewTruncated) out.push({ path: abs, h, i });
      });
    }
    return out;
  }, [changes, workspacePath]);

  /* 按文件聚合 — 面板里一行一个文件, 点开进 Surface 审 diff */
  const pendingFiles = useMemo(() => {
    const map = new Map<string, {
      path: string;
      pendingCount: number;
      addCount: number;
      delCount: number;
      changedLines?: any[];
      editHunks?: any[];
      fallbackContent?: string;
    }>();
    for (const c of changes) {
      if (c.op === 'write' || c.op === 'delete' || c.op === 'rename') continue;
      const hunks = (c as any).editHunks as any[] | undefined;
      if (!hunks?.length) continue;
      const abs = resolveWorkspacePath(c.path, workspacePath);
      const pending = hunks.filter((h) =>
        (h.review ?? 'pending') === 'pending'
        && !h.previewTruncated
        && typeof h.oldString === 'string'
        && h.oldString.length > 0,
      );
      if (pending.length === 0) continue;
      const prev = map.get(abs);
      if (prev) {
        prev.pendingCount += pending.length;
        prev.addCount += c.addCount || 0;
        prev.delCount += c.delCount || 0;
      } else {
        map.set(abs, {
          path: abs,
          pendingCount: pending.length,
          addCount: c.addCount || 0,
          delCount: c.delCount || 0,
          changedLines: c.changedLines,
          editHunks: hunks,
          fallbackContent: (c as any).fallbackContent,
        });
      }
    }
    return Array.from(map.values());
  }, [changes, workspacePath]);

  /* 列表变了 (Allow/Deny 后少行) 时清掉已不在列表里的选中 */
  useEffect(() => {
    if (activePath && !pendingFiles.some((f) => f.path === activePath)) {
      setActivePath(null);
    }
  }, [pendingFiles, activePath]);

  const acceptAllPending = useCallback((e?: { stopPropagation?: () => void }) => {
    e?.stopPropagation?.();
    if (!sessionId || pendingHunks.length === 0) return;
    const n = acceptAllTurnEdits(sessionId, updateHunkReview as never);
    dispatchHint(
      isZh ? `已接受 ${n} 处改动` : `Accepted ${n} change${n === 1 ? '' : 's'}`,
      'success',
    );
    /* 接受后立刻收起操作条 — 文件已在磁盘, review 写回后 pending 也会清空 */
    dismiss();
  }, [sessionId, pendingHunks, updateHunkReview, isZh, dismiss]);

  const rejectAllPending = useCallback(async (e?: { stopPropagation?: () => void }) => {
    e?.stopPropagation?.();
    if (!sessionId || pendingHunks.length === 0) return;
    setBulkBusy(true);
    try {
      const r = await revertAllTurnEdits(sessionId, updateHunkReview as never);
      if (r.ok < 0) { dispatchHint(isZh ? '回退能力未就绪' : 'Revert unavailable', 'warning'); return; }
      dispatchHint(
        r.ok > 0
          ? (isZh ? `已回退 ${r.ok} 处改动` : `Reverted ${r.ok} change${r.ok === 1 ? '' : 's'}`)
          : (isZh ? '回退失败' : 'Revert failed'),
        r.ok > 0 ? 'success' : 'warning',
      );
      if (r.ok > 0) dismiss();
    } finally {
      setBulkBusy(false);
    }
  }, [sessionId, pendingHunks, updateHunkReview, isZh, dismiss]);

  useEffect(() => {
    const onReverted = (e: Event) => {
      const abs = String((e as CustomEvent).detail?.path ?? '');
      if (!abs || !sessionId) return;
      const key = abs.replace(/\\/g, '/').toLowerCase();
      let hit = 0;
      for (const { path, h, i } of pendingHunks) {
        if (path.replace(/\\/g, '/').toLowerCase() !== key) continue;
        const entryId = h.__sourceEntryId;
        const hunkIdx = typeof h.__sourceHunkIdx === 'number' ? h.__sourceHunkIdx : i;
        if (entryId && updateHunkReview && hunkIdx >= 0) {
          updateHunkReview(sessionId, entryId, hunkIdx, 'rejected');
          hit++;
        }
      }
      if (hit === 0) return;
      /* 内存态也同步, 否则要等时间线回流才刷新 */
      const files: AgentTurnFileEdit[] = changes.map((c) => {
        const p = resolveWorkspacePath(c.path, workspacePath);
        const isTarget = p.replace(/\\/g, '/').toLowerCase() === key;
        return {
          path: p,
          addCount: c.addCount,
          delCount: c.delCount,
          changedLines: c.changedLines,
          editHunks: ((c as any).editHunks as any[] | undefined)?.map((h: any) =>
            isTarget && (h.review ?? 'pending') === 'pending' ? { ...h, review: 'rejected' as const } : h,
          ),
        };
      });
      if (latest) setAgentTurnEdits(sessionId, turnId || latest.id, files);
    };
    window.addEventListener(FILE_REVERTED_EVENT, onReverted as EventListener);
    return () => window.removeEventListener(FILE_REVERTED_EVENT, onReverted as EventListener);
  }, [sessionId, pendingHunks, updateHunkReview, changes, workspacePath, latest, turnId]);

  const openPendingFile = useCallback((file: (typeof pendingFiles)[number]) => {
    if (!sessionId) return;
    setActivePath(file.path);
    openSurfaceFromPath({
      sessionId,
      path: file.path,
      workspacePath,
      changedLines: file.changedLines as any,
      editHunks: file.editHunks as any,
      fallbackContent: file.fallbackContent,
      preferKind: 'code',
    });
  }, [sessionId, workspacePath]);

  /* store sync 已在上方 effect 完成. 时间线汇总卡是唯一「本轮改动」列表;
   * 这里只在有真实 edit 待审时给一颗药丸, 避免跟时间线卡重复. */
  if (!latest || streaming || dismissed) return null;
  if (pendingHunks.length === 0) return null;

  const n = changes.length || pendingHunks.length;
  return {
    id: 'turn-review',
    tone: 'attention',
    icon: <ReviewIcon />,
    label: isZh ? '本轮改动' : 'Agent edits',
    meta: String(n),
    /* 权重最小 = 永远排第一: 这是本条里唯一"不处理就卡住"的东西 */
    weight: 10,
    /* attention 只保留配色/排序语义, 不再触发撑开 (见 DockRail 的 expandDetail) */
    attention: true,
    expandDetail: false,
    updatedAt: (latest as { timestamp?: number }).timestamp ?? Date.now(),
    ariaLabel: isZh ? `本轮改动审阅, ${n} 处待审` : `Review turn edits, ${n} pending`,
    actions: [
      {
        id: 'review-all',
        label: isZh ? '一屏审阅' : 'Review all',
        title: isZh ? '把本轮改过的文件叠在一屏里逐处审阅' : 'Review every edited file on one screen',
        onClick: () => {
          if (!sessionId) return;
          window.dispatchEvent(new CustomEvent('neox:open-surface', {
            detail: {
              kind: 'review',
              source: { type: 'inline', content: '' },
              title: isZh ? '本轮改动' : 'Edits this turn',
              pinned: true,
              byUser: true,
              metadata: { sessionId, workspacePath },
            },
          }));
          window.dispatchEvent(new CustomEvent('neox:right-panel:expand', { detail: { mode: 'agent' } }));
        },
      },
      {
        id: 'accept',
        label: isZh ? '接受' : 'Accept',
        title: isZh ? '接受本轮全部待审改动' : 'Accept all agent edits this turn',
        onClick: () => acceptAllPending(),
      },
      {
        id: 'reject',
        label: bulkBusy ? '…' : (isZh ? '回退' : 'Revert'),
        danger: true,
        title: isZh ? '回退本轮全部待审改动' : 'Revert all agent edits this turn',
        onClick: () => { void rejectAllPending(); },
      },
      {
        id: 'dismiss',
        icon: (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ),
        title: isZh ? '隐藏 (改动仍在磁盘上, 编辑器顶栏可继续审阅)' : 'Hide (edits stay on disk; review from the editor top bar)',
        onClick: dismiss,
      },
    ],
    panel: (
      <ul className="nx-dock-review">
        {pendingFiles.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              className={`nx-dock-review__row${activePath === f.path ? ' is-active' : ''}`}
              onClick={() => openPendingFile(f)}
              title={f.path}
              aria-current={activePath === f.path ? 'true' : undefined}
            >
              <span className="nx-dock-review__icon" aria-hidden="true">
                <FileTypeIcon path={f.path} size={16} />
              </span>
              <span className="nx-dock-review__name">{fileBaseName(f.path)}</span>
              <span className="nx-dock-review__meta">
                <span className="nx-dock-review__hunks">
                  {f.pendingCount > 1 ? `${f.pendingCount} hunks` : '1 hunk'}
                </span>
                {(f.addCount > 0 || f.delCount > 0) && (
                  <span className="nx-dock-review__diffstat">
                    {f.addCount > 0 && <span className="nx-dock-review__add">+{f.addCount}</span>}
                    {f.addCount > 0 && f.delCount > 0 && ' '}
                    {f.delCount > 0 && <span className="nx-dock-review__del">−{f.delCount}</span>}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    ),
  };
}

const ReviewIcon = (): React.ReactElement => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9.5 1.8H4a1.2 1.2 0 0 0-1.2 1.2v10A1.2 1.2 0 0 0 4 14.2h8a1.2 1.2 0 0 0 1.2-1.2V5.5z" />
    <path d="M9.4 1.9v3.6h3.7" />
    <path d="M5.8 10.2 7.2 11.6 10.4 8.4" />
  </svg>
);

/** 独立组件形态 —— IDE 侧 AI 面板单独挂它 */
export const TurnSummaryBar: React.FC<Props> = (props) => {
  const pill = useTurnReviewPill(props);
  return <DockRail pills={pill ? [pill] : []} />;
};

export default TurnSummaryBar;
