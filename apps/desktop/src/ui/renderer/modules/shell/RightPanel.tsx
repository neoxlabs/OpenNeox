import React, { useEffect, useMemo, useState } from 'react';
import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';
import { useTimelineFeed } from '../../state/timelineFeedStore';
import { useTimelinePanelSummary } from '../../state/timelinePanelSummaryStore';
import { confirmAsync, promptAsync } from '../../components/confirmEvents';
import { dispatchHint, dispatchOpFailed } from '../../components/notifyEvents';
import { getStepIconInfo } from '../agent-timeline/stepIcons';
import type { StepIconKind } from '../agent-timeline/types';
import type { TimelineEntry } from '../../utils/workspaceUtils';
import { displayWorkspaceName } from '../../utils/modeHomeName';
import { useI18n, defaultIsZh } from '../../hooks/useI18n';
import { messageSignalCount } from '../../app/blankSessionReuse';
import { isSessionRewindEnabled, isCheckpointRollbackEnabled } from './sessionRewindAvailability';

/* ============================================================
 * RightPanel — 288px · 真实 Task Detail
 *
 *   1) Agent 头像 + 会话名 + 运行状态
 *   2) 当前活动 (running step / 待机)
 *   3) Token 使用 (context window vs used)
 *   4) 最近工具 (distinct tool iconKind + 名)
 *   5) 最近文件变更 (edit_file entries + diff stat)
 *   6) 会话元信息 (workspace / 起始 / 消息数)
 *
 *   用不到的 demo 字段 (任务类型/优先级/切换Agent/更新间隔) 全部砍掉.
 * ============================================================ */

export interface RightPanelProps {
  /** 保留: 允许外部覆盖 agent 名字 (比如装饰性展示). 其余数据全走 runtime context. */
  agentName?: string;
  embedded?: boolean;
}

const pad = (n: number) => n.toString().padStart(2, '0');
const formatClock = (ts?: number) => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const formatDate = (ts?: number, isZh = defaultIsZh()) => {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${isZh ? '今天' : 'Today'} ${formatClock(ts)}`;
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
};
const formatNumber = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return n.toLocaleString();
  return String(Math.round(n));
};

const pad2 = (n: number) => n.toString().padStart(2, '0');
const formatHms = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(rs)}`;
};

const ElapsedHms: React.FC<{ startedAt: number; active: boolean }> = React.memo(({ startedAt, active }) => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  const text = useMemo(() => {
    void tick;
    return formatHms(Date.now() - startedAt);
  }, [startedAt, tick]);
  return <span className="neox-rightcard__elapsed">{text}</span>;
});
ElapsedHms.displayName = 'ElapsedHms';

/* ============================================================
 * RightPanel
 * ============================================================ */
export const RightPanel: React.FC<RightPanelProps> = ({ agentName = 'Neox Agent', embedded = false }) => {
  const runtime = useNeoxRuntimeOptional();
  const { isZh } = useI18n();
  const timelineEvents = useTimelineFeed();
  const panelSummary = useTimelinePanelSummary();
  const fileChanges = useMemo(() => aggregateFileChanges(timelineEvents), [timelineEvents]);

  /* 无 runtime (不应该发生, bridge 必包), 给一个静态骨架 */
  if (!runtime) {
    return (
      <aside className="neox-rightpanel neox-shell__right" aria-label={isZh ? "任务详情" : "Task details"}>
        <section className="neox-rightcard">
          <div className="neox-rightcard__head">
            <span className="neox-rightcard__title">Task Detail</span>
          </div>
          <div className="neox-rightcard__empty">{isZh ? "等待运行时挂载…" : "Waiting for runtime…"}</div>
        </section>
      </aside>
    );
  }

  const {
    workspacePath,
    activeSession,
    streaming,
    turnStartedAt,
    selectedModel,
  } = runtime;

  /* 消息数取 active + 列表里那份的**最大值**。
   * blankSessionReuse 顶部早写明了: 内存里活跃会话对象上的 messageCount 是创建那一刻的
   * 值, 发完消息不回填; 而列表 (runtime.sessions) 那份是权威的 —— 侧栏「N 条消息」正确、
   * 这里显示 0, 差别就在读了哪一份。同 shouldReuseBlankSession(active, authoritative) 的模式。 */
  const authoritativeSession = activeSession
    ? runtime.sessions.find((s) => s.id === activeSession.id)
    : undefined;
  const messageCountDisplay = Math.max(
    messageSignalCount(activeSession as never),
    messageSignalCount(authoritativeSession as never),
  );

  const summary =
    panelSummary && panelSummary.sessionId === activeSession?.id
      ? panelSummary
      : null;

  const runningStep = summary?.running ?? null;
  const recentTools = summary?.recentTools ?? [];
  const stats = summary?.stats ?? { total: 0, done: 0, running: 0, pending: 0, failed: 0, pct: 0 };

  /* Token stats */
  const contextWindow = selectedModel?.contextWindow ?? 0;
  const contextUsed =
    (activeSession as any)?.contextUsed ??
    (activeSession as any)?.totalTokens ??
    0;
  const usedPct = contextWindow > 0 ? Math.min(100, (contextUsed / contextWindow) * 100) : 0;

  const workspaceName = displayWorkspaceName(workspacePath, null, isZh);
  return (
    <aside className="neox-rightpanel neox-shell__right" aria-label={isZh ? "任务详情" : "Task details"}>
      {/* 1) Agent + 会话名 —— 嵌在弹窗里时收成一行事实, 见 RightPanelProps.embedded */}
      {embedded ? (
        <section className="neox-rightcard neox-rightcard--slim">
          <div className="neox-slimmeta">
            <span className={`neox-status-pill ${streaming ? 'is-ok' : 'is-off'}`}>
              <span className="neox-status-pill__dot" />
              {streaming ? (isZh ? '运行中' : 'Running') : (isZh ? '待机' : 'Idle')}
            </span>
            {selectedModel?.name && <span className="neox-slimmeta__item">{selectedModel.name}</span>}
            {workspaceName && <span className="neox-slimmeta__item" title={workspacePath}>{workspaceName}</span>}
          </div>
        </section>
      ) : (
        <section className="neox-rightcard">
          <div className="neox-rightcard__head">
            <span className="neox-rightcard__title">{isZh ? "任务详情" : "Task details"}</span>
            <span className={`neox-status-pill ${streaming ? 'is-ok' : 'is-off'}`}>
              <span className="neox-status-pill__dot" />
              {streaming ? (isZh ? '运行中' : 'Running') : (isZh ? '待机' : 'Idle')}
            </span>
          </div>
          <div className="neox-agentcard">
            <div className="neox-agentcard__avatar">{agentName.charAt(0)}</div>
            <div className="neox-agentcard__name">{activeSession?.name?.trim() || agentName}</div>
            <div className="neox-agentcard__role">
              {selectedModel?.name ? (isZh ? `基于 ${selectedModel.name}` : `Based on ${selectedModel.name}`) : (isZh ? 'AI 编程助手' : 'AI coding assistant')}
            </div>
          </div>
        </section>
      )}

      {/* 2) 当前活动 */}
      {runningStep && (
        <section className="neox-rightcard">
          <div className="neox-rightcard__head">
            <span className="neox-rightcard__title">{isZh ? "当前活动" : "Current activity"}</span>
            {streaming && turnStartedAt ? (
              <ElapsedHms startedAt={turnStartedAt} active />
            ) : null}
          </div>
          <div className="neox-activity">
            <ActivityIcon iconKind={runningStep.iconKind} />
            <div className="neox-activity__body">
              <div className="neox-activity__title">{runningStep.title}</div>
              {runningStep.desc && <div className="neox-activity__desc">{runningStep.desc}</div>}
            </div>
          </div>
        </section>
      )}

      {/* 3) Token 使用 */}
      {contextWindow > 0 && (
        <section className="neox-rightcard">
          <div className="neox-rightcard__head">
            <span className="neox-rightcard__title">{isZh ? "Token 使用" : "Token usage"}</span>
            <span className="neox-rightcard__elapsed">{Math.round(usedPct)}%</span>
          </div>
          <div className="neox-tokenbar">
            <div
              className={`neox-tokenbar__fill${usedPct > 85 ? ' is-high' : ''}`}
              style={{ width: `${usedPct}%` }}
            />
          </div>
          <div className="neox-kv-list">
            <div className="neox-kv">
              <span className="neox-kv__key">{isZh ? "上下文窗口" : "Context window"}</span>
              <span className="neox-kv__val">{formatNumber(contextWindow)}</span>
            </div>
            <div className="neox-kv">
              <span className="neox-kv__key">{isZh ? "已用" : "Used"}</span>
              <span className={`neox-kv__val${usedPct > 85 ? ' is-danger' : ' is-primary'}`}>
                {formatNumber(contextUsed)}
              </span>
            </div>
            <div className="neox-kv">
              <span className="neox-kv__key">{isZh ? "剩余" : "Remaining"}</span>
              <span className="neox-kv__val">{formatNumber(Math.max(0, contextWindow - contextUsed))}</span>
            </div>
          </div>
        </section>
      )}

      {/* 4) 最近工具 */}
      {recentTools.length > 0 && (
        <section className="neox-rightcard">
          <div className="neox-rightcard__head">
            <span className="neox-rightcard__title">{isZh ? "最近工具" : "Recent tools"}</span>
          </div>
          <div className="neox-tool-list">
            {recentTools.map((t, i) => (
              <div key={i} className="neox-tool-list__item">
                <MiniIcon iconKind={t.kind} />
                <span className="neox-tool-list__name">{t.title}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 5) 最近文件变更 */}
      {fileChanges.length > 0 && (
        <section className="neox-rightcard">
          <div className="neox-rightcard__head">
            <span className="neox-rightcard__title">{isZh ? "最近文件变更" : "Recent file changes"}</span>
            <span className="neox-rightcard__elapsed">{fileChanges.length}</span>
          </div>
          <div className="neox-file-list">
            {fileChanges.map((f) => (
              <div key={f.path} className="neox-file-list__item">
                <span className="neox-file-list__name" title={f.path}>{shortenPath(f.path)}</span>
                <span className="neox-file-list__stat">
                  <span className="neox-file-list__add">+{f.addCount}</span>
                  <span className="neox-file-list__del">−{f.delCount}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 6) Checkpoints + 会话操作 */}
      {activeSession && <CheckpointCard sessionId={activeSession.id} />}
      {activeSession && <FileCheckpointCard sessionId={activeSession.id} />}

      {/* 7) 会话信息 */}
      <section className="neox-rightcard">
        <div className="neox-rightcard__head">
          <span className="neox-rightcard__title">{isZh ? "会话信息" : "Session info"}</span>
        </div>
        <div className="neox-kv-list">
          <div className="neox-kv">
            <span className="neox-kv__key">{isZh ? "工作区" : "Workspace"}</span>
            <span className="neox-kv__val" title={workspacePath}>{workspaceName}</span>
          </div>
          {activeSession?.createdAt && (
            <div className="neox-kv">
              <span className="neox-kv__key">{isZh ? "创建时间" : "Created"}</span>
              <span className="neox-kv__val">{formatDate(activeSession.createdAt as number, isZh)}</span>
            </div>
          )}
          <div className="neox-kv">
            <span className="neox-kv__key">{isZh ? "消息数" : "Messages"}</span>
            <span className="neox-kv__val">{messageCountDisplay}</span>
          </div>
          {stats.total > 0 && (
            <div className="neox-kv">
              <span className="neox-kv__key">{isZh ? "工具执行" : "Tool runs"}</span>
              <span className="neox-kv__val">
                {stats.done}/{stats.total}
                {stats.failed > 0 && <span className="neox-kv__val is-danger"> · {stats.failed} {isZh ? '失败' : 'failed'}</span>}
              </span>
            </div>
          )}
        </div>
        {activeSession && (
          <div className="neox-rightcard__ops">
            {isSessionRewindEnabled() && (
              <button
                type="button"
                className="neox-rightcard__op"
                onClick={() => void runtime.undoActiveSession()}
                title={isZh ? '撤销最近一轮消息' : 'Undo the latest turn'}
              >
                ↶ {isZh ? '撤销' : 'Undo'}
              </button>
            )}
            <button
              type="button"
              className="neox-rightcard__op"
              onClick={() => void runtime.compactActiveSession()}
              title={isZh ? "压缩上下文 (保留关键信息, 减少 tokens)" : "Compact context (keep key info, reduce tokens)"}
            >
              ✂ {isZh ? '压缩' : 'Compact'}
            </button>
          </div>
        )}
      </section>
    </aside>
  );
};

/* ============================================================
 * CheckpointCard — 列出会话 checkpoints + 手动建点 + 回滚
 * ============================================================ */
const CheckpointCard: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { isZh } = useI18n();
  const runtime = useNeoxRuntimeOptional();
  const [items, setItems] = useState<Array<{ id: string; name?: string; createdAt?: number }>>([]);
  const [loading, setLoading] = useState(false);
  const [fileCkptOn, setFileCkptOn] = useState<boolean | null>(null);
  /* 对话回退整条能力现在是关的 —— 原因见 sessionRewindAvailability.ts */
  const rewindOn = isCheckpointRollbackEnabled();

  const refresh = React.useCallback(async () => {
    try {
      setLoading(true);
      const onRes = await (window as any).neox?.isCheckpointEnabled?.();
      setFileCkptOn(onRes === true || onRes?.enabled === true);
      const list = await (window as any).neox?.getSessionCheckpoints?.(sessionId);
      setItems(Array.isArray(list) ? list : []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleCreate = async () => {
    const raw = await promptAsync({ title: isZh ? '新建 Checkpoint' : 'New Checkpoint', placeholder: isZh ? '名称 (留空自动生成)' : 'Name (leave blank to auto-generate)', confirmLabel: isZh ? '创建' : 'Create' });
    if (raw == null) return; // 取消
    const name = raw.trim() || undefined;
    await runtime?.checkpointActiveSession(name);
    void refresh();
  };
  const handleRollback = async (id: string, label: string) => {
    const filesToo = fileCkptOn === true;
    const ok = await confirmAsync({
      title: isZh ? `回滚到「${label || id}」?` : `Roll back to "${label || id}"?`,
      message: filesToo
        ? (isZh
          ? '对话和工作区文件都会回到该 checkpoint 的状态。'
          : 'Both the conversation and the workspace files will return to this checkpoint.')
        : (isZh
          ? '只回滚对话 —— 工作区文件不会变。'
          : 'Conversation only — workspace files will NOT change.'),
      description: filesToo
        ? (isZh
          ? '此 checkpoint 之后的对话消息会丢失; 文件改动会被硬回滚 (回滚前的状态仍可从「文件检查点」找回)。'
          : 'Messages after this checkpoint are lost; file changes are hard-reset (the pre-rollback state is still recoverable from File checkpoints).')
        : (isZh
          ? '此 checkpoint 之后的对话消息会丢失。文件回滚依赖实验性「检查点」(Shadow Git), 当前没开启 —— 磁盘上的改动会原样留着。'
          : 'Messages after this checkpoint are lost. File rollback needs the experimental Checkpoint (Shadow Git), which is off — changes on disk stay as they are.'),
      variant: 'danger',
      confirmLabel: isZh ? '回滚' : 'Roll back',
    });
    if (!ok) return;
    try {
      await runtime?.rollbackActiveSession(id);
      dispatchHint(
        filesToo
          ? (isZh ? '已回滚对话与文件' : 'Conversation and files rolled back')
          : (isZh ? '已回滚对话 (文件未变 — 文件快照未开启)' : 'Conversation rolled back (files unchanged — file checkpoints are off)'),
        'info',
      );
    } catch (err: any) {
      dispatchOpFailed({ op: isZh ? '回滚会话' : 'Roll back session', message: err?.message || String(err) });
    }
    void refresh();
  };

  if (!rewindOn) return null;

  return (
    <section className="neox-rightcard">
      <div className="neox-rightcard__head">
        <span className="neox-rightcard__title" title={isZh
          ? '对话和工作区文件一起回到某个时刻'
          : 'Rewind both the conversation and the workspace files'}>
          {isZh ? '整段退回' : 'Rewind'}
        </span>
        <button type="button" className="neox-rightcard__head-link" onClick={handleCreate}>
          + {isZh ? '新建' : 'New'}
        </button>
      </div>
      {loading && <div className="neox-rightcard__empty neox-text-shimmer">{isZh ? "加载中…" : "Loading…"}</div>}
      {!loading && items.length === 0 && (
        <div className="neox-rightcard__empty">{isZh ? '暂无可退回的位置' : 'Nowhere to rewind to yet'}</div>
      )}
      {!loading && items.length > 0 && (
        <ul className="neox-ckpt-list">
          {items.map((c) => (
            <li key={c.id} className="neox-ckpt__item">
              <span className="neox-ckpt__name">{c.name || c.id.slice(0, 8)}</span>
              {c.createdAt && (
                <span className="neox-ckpt__time">
                  {new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
              <button
                type="button"
                className="neox-ckpt__rollback"
                onClick={() => void handleRollback(c.id, c.name ?? '')}
                title={isZh ? '对话和文件一起退回到这里' : 'Rewind conversation and files to here'}
              >
                ↶ {isZh ? '退回这里' : 'Rewind here'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/* ============================================================
 * FileCheckpointCard — 列出每轮【文件】检查点 (Shadow Git) + 回滚整轮磁盘改动
 *   与 CheckpointCard (只回滚对话历史) 互补: 这个真动磁盘文件 (git reset --hard)。
 *   后端 (preload→checkpointHandlers→RuntimeCheckpointService→ShadowGit) 全通, 纯 renderer 接线。
 * ============================================================ */
interface FileCheckpointItem {
  id: string;
  label?: string;
  timestamp?: number;
  messageIndex?: number;
  stats?: { created?: number; modified?: number; deleted?: number; total?: number };
}
const FileCheckpointCard: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { isZh } = useI18n();
  const [items, setItems] = useState<FileCheckpointItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setLoading(true);
      const onRes = await (window as any).neox?.isCheckpointEnabled?.();
      const on = onRes === true || onRes?.enabled === true;
      setEnabled(on);
      if (!on) { setItems([]); return; }
      const listRes = await (window as any).neox?.getFileCheckpoints?.(50, sessionId);
      const list = Array.isArray(listRes) ? listRes : (listRes?.checkpoints ?? []);
      /* no-changes 占位点 (ShadowGit 无变更时返回 id:'no-changes') 不展示 */
      setItems(Array.isArray(list) ? list.filter((c: FileCheckpointItem) => c.id && c.id !== 'no-changes') : []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleEnable = async () => {
    try {
      await (window as any).neox?.experimentalSetConfig?.({ enableCheckpoint: true });
      await (window as any).neox?.setCheckpointEnabled?.(true);
    } catch { /* ignore — refresh 会反映真实状态 */ }
    void refresh();
  };

  /* 回滚前的恢复点 id —— 有值时在面板顶部给"撤销回滚". 刷新/再次回滚会覆盖它. */
  const [undoRollbackId, setUndoRollbackId] = useState<string | null>(null);

  const handleUndoRollback = async () => {
    if (!undoRollbackId) return;
    try {
      /* 撤销回滚本身也是一次回滚 —— 回到那个"回滚前"的恢复点 */
      const r = await (window as any).neox?.rollbackToFileCheckpoint?.(undoRollbackId);
      const notify = await import('../../components/notifyEvents');
      if (r?.success) {
        setUndoRollbackId(null);
        notify.dispatchHint(isZh ? '已撤销回滚, 文件回到回滚前' : 'Rollback undone — files restored', 'success');
      } else {
        notify.dispatchOpFailed({
          op: isZh ? '撤销回滚' : 'Undo rollback',
          message: r?.errors?.join('; ') || (isZh ? '恢复点已不可用' : 'Restore point no longer available'),
        });
      }
    } catch (e: any) {
      const notify = await import('../../components/notifyEvents');
      notify.dispatchOpFailed({ op: isZh ? '撤销回滚' : 'Undo rollback', message: e?.message ?? String(e) });
    }
    void refresh();
  };

  const handleRollback = async (item: FileCheckpointItem) => {
    const label = item.label || (item.messageIndex != null ? (isZh ? `第 ${item.messageIndex + 1} 轮` : `Turn ${item.messageIndex + 1}`) : item.id.slice(0, 8));
    const ok = await confirmAsync({
      title: isZh ? `回滚文件到「${label}」?` : `Roll back files to "${label}"?`,
      message: isZh
        ? '工作区里的文件会被还原成该检查点时的样子 (用 Neox 自己的快照仓库, 不动你项目的 Git 历史)。'
        : 'Files in the workspace are restored to how they were at this checkpoint (via Neox\'s own snapshot repo — your project\'s Git history is untouched).',
      /* 原文案写"不可撤销" —— 那是错的: rollbackTo 会先把当前状态存成 reapply 恢复点。
       * 说重话吓住用户、又不给出口, 比说实话更糟。现在如实说明, 并在回滚后给撤销入口。 */
      description: isZh
        ? '这会覆盖此后对这些文件的所有改动 (含你手动改的)。回滚前会先存一个恢复点, 回滚后可以撤销。'
        : 'This overwrites all later changes to these files (including your manual edits). A restore point is saved first, so you can undo the rollback afterwards.',
      variant: 'danger',
      confirmLabel: isZh ? '回滚文件' : 'Roll back files',
    });
    if (!ok) return;
    try {
      const r = await (window as any).neox?.rollbackToFileCheckpoint?.(item.id);
      const notify = await import('../../components/notifyEvents');
      if (r?.success) {
        /* 记下回滚前的恢复点 —— 它一直存在, 只是以前没有任何入口能到达。 */
        if (r.reapplyCheckpointId) setUndoRollbackId(r.reapplyCheckpointId);
        const n = r.restored?.length ?? 0;
        if (n === 0) {
          notify.dispatchHint(
            isZh ? '没有文件被改动 —— 这个检查点就是当前状态, 想撤销这轮改动请选它上一个检查点'
                 : 'Nothing changed — this checkpoint matches the current state; pick the previous one to undo this turn',
            'info',
          );
        } else {
          notify.dispatchHint(isZh ? `已回滚 ${n} 个文件` : `Rolled back ${n} file(s)`, 'success');
        }
      } else {
        notify.dispatchOpFailed({ op: isZh ? '文件回滚' : 'File rollback', message: r?.errors?.join('; ') || (isZh ? '失败' : 'Failed') });
      }
    } catch (e: any) {
      const notify = await import('../../components/notifyEvents');
      notify.dispatchOpFailed({ op: isZh ? '文件回滚' : 'File rollback', message: e?.message ?? String(e) });
    }
    void refresh();
  };

  return (
    <section className="neox-rightcard">
      <div className="neox-rightcard__head">
        <span className="neox-rightcard__title" title={isZh
          ? '只把工作区文件退回, 对话保持不动'
          : 'Restore workspace files only; the conversation stays as it is'}>
          {isZh ? '只撤销文件改动' : 'Undo file changes only'}
        </span>
      </div>
      {undoRollbackId && (
        <div className="neox-rightcard__undobar">
          <span>{isZh ? '刚刚回滚了文件' : 'Files were just rolled back'}</span>
          <button type="button" onClick={handleUndoRollback}>
            {isZh ? '撤销回滚' : 'Undo rollback'}
          </button>
        </div>
      )}
      {loading && <div className="neox-rightcard__empty neox-text-shimmer">{isZh ? '加载中…' : 'Loading…'}</div>}
      {!loading && enabled === false && (
        <div className="neox-rightcard__empty">
          {isZh ? '文件回滚依赖实验性「检查点」(Shadow Git)。' : 'File rollback needs the experimental Checkpoint (Shadow Git).'}
          <button type="button" className="neox-rightcard__head-link" style={{ marginLeft: 8 }} onClick={handleEnable}>
            {isZh ? '开启' : 'Enable'}
          </button>
        </div>
      )}
      {!loading && enabled === true && items.length === 0 && (
        <div className="neox-rightcard__empty">{isZh ? '本会话还没有文件改动可撤销 (或 git 不可用)' : 'No file changes to undo in this session yet (or git is unavailable)'}</div>
      )}
      {!loading && enabled === true && items.length > 0 && (
        <ul className="neox-ckpt-list">
          {items.map((c) => {
            const n = c.stats?.total ?? ((c.stats?.created ?? 0) + (c.stats?.modified ?? 0) + (c.stats?.deleted ?? 0));
            const label = c.label || (c.messageIndex != null ? (isZh ? `第 ${c.messageIndex + 1} 轮` : `Turn ${c.messageIndex + 1}`) : c.id.slice(0, 8));
            return (
              <li key={c.id} className="neox-ckpt__item">
                <span className="neox-ckpt__name">{label}</span>
                {n > 0 && <span className="neox-ckpt__time">{n} {isZh ? '文件' : n === 1 ? 'file' : 'files'}</span>}
                <button
                  type="button"
                  className="neox-ckpt__rollback"
                  onClick={() => void handleRollback(c)}
                  title={isZh ? '只把工作区文件退回到这轮之前, 对话不动' : 'Restore workspace files to before this turn; the conversation stays'}
                >
                  ↶ {isZh ? '回滚' : 'Roll back'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

/* ============================================================
 * Mini helpers
 * ============================================================ */
function shortenPath(p: string, max = 30): string {
  if (p.length <= max) return p;
  const parts = p.split(/[/\\]/);
  if (parts.length <= 2) return '…' + p.slice(-max + 1);
  return `…/${parts.slice(-2).join('/')}`;
}

function aggregateFileChanges(entries: TimelineEntry[]): { path: string; addCount: number; delCount: number }[] {
  const map = new Map<string, { path: string; addCount: number; delCount: number; ts: number }>();
  for (const e of entries) {
    if (e.type !== 'edit_file') continue;
    const p = (e.editFilePath || e.targetPath || '').trim();
    if (!p) continue;
    const addLines = (e.editNewString || '').split('\n').length;
    const delLines = (e.editOldString || '').split('\n').length;
    const addCount = e.editNewString ? addLines : 0;
    const delCount = e.editOldString ? delLines : 0;
    const existing = map.get(p);
    const ts = (e.timestamp as number | undefined) ?? 0;
    if (existing) {
      existing.addCount += addCount;
      existing.delCount += delCount;
      if (ts > existing.ts) existing.ts = ts;
    } else {
      map.set(p, { path: p, addCount, delCount, ts });
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 6);
}

/* ---------- icon helpers ---------- */
const MiniIcon: React.FC<{ iconKind: StepIconKind }> = ({ iconKind }) => {
  const { Icon, className } = getStepIconInfo(iconKind);
  return (
    <span className={`neox-tool-list__icon ${className}`} aria-hidden="true">
      <Icon size={11} />
    </span>
  );
};
const ActivityIcon: React.FC<{ iconKind: StepIconKind }> = ({ iconKind }) => {
  const { Icon, className } = getStepIconInfo(iconKind);
  return (
    <span className={`neox-activity__icon ${className}`} aria-hidden="true">
      <Icon size={14} />
    </span>
  );
};

export default RightPanel;
