import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { Surface } from '../../../state/surfaceStore';
import { useAgentTurnEdits, type AgentTurnFileEdit } from '../../../state/agentTurnEditsStore';
import { CodeSurfaceViewer } from './CodeSurfaceViewer';
import { useI18n } from '../../../hooks/useI18n';
import { resolveAbs } from '../../../state/openSurfaceFromPath';
import { acceptAllTurnEdits, revertAllTurnEdits } from '../../../state/turnEditsBulk';
import { useNeoxRuntimeOptional } from '../../../app/NeoxRuntimeContext';
import { dispatchHint } from '../../../components/notifyEvents';
import { FileTypeIcon } from '../../../components/FileTypeIcon';

interface Props { surface: Surface; workspacePath?: string }

/* 每段高度按这个文件的 diff 行数算: 一两处小改动就一小段, 长改动给到 640 再在段内滚。
 * 固定 360px 的第一版把三行的改动也摆成一大块空白, 长文件又要在小窗里翻。 */
function fileViewHeight(f: AgentTurnFileEdit): number {
  const lines = (f.editHunks ?? []).reduce((n, h) =>
    n + (h.oldString ?? '').split('\n').length + (h.newString ?? '').split('\n').length + 4, 0);
  return Math.max(200, Math.min(640, 96 + lines * 20));
}

function countPending(f: AgentTurnFileEdit): number {
  return (f.editHunks ?? []).filter((h) => (h.review ?? 'pending') === 'pending').length;
}

export const ReviewSurfaceViewer: React.FC<Props> = ({ surface, workspacePath }) => {
  const { isZh } = useI18n();
  const meta = (surface.metadata ?? {}) as { sessionId?: string; workspacePath?: string };
  const sessionId = meta.sessionId;
  const ws = meta.workspacePath ?? workspacePath;
  const slice = useAgentTurnEdits(sessionId);
  const sectionRefs = useRef(new Map<string, HTMLElement | null>());
  const runtime = useNeoxRuntimeOptional();
  const [bulkBusy, setBulkBusy] = useState(false);

  /* 跨文件全部接受 / 全部回退 —— 逻辑在 turnEditsBulk, 跟 composer 药丸同一份 */
  const acceptAll = useCallback(() => {
    if (!sessionId) return;
    const n = acceptAllTurnEdits(sessionId, runtime?.updateHunkReview as never);
    dispatchHint(isZh ? `已接受 ${n} 处改动` : `Accepted ${n} change${n === 1 ? '' : 's'}`, 'success');
  }, [sessionId, runtime, isZh]);
  const revertAll = useCallback(async () => {
    if (!sessionId || bulkBusy) return;
    setBulkBusy(true);
    try {
      const r = await revertAllTurnEdits(sessionId, runtime?.updateHunkReview as never);
      if (r.ok < 0) dispatchHint(isZh ? '回退能力未就绪' : 'Revert unavailable', 'warning');
      else dispatchHint(
        r.ok > 0 ? (isZh ? `已回退 ${r.ok} 处改动` : `Reverted ${r.ok} change${r.ok === 1 ? '' : 's'}`) : (isZh ? '回退失败' : 'Revert failed'),
        r.ok > 0 ? 'success' : 'warning');
    } finally { setBulkBusy(false); }
  }, [sessionId, runtime, isZh, bulkBusy]);

  const files = slice?.files ?? [];
  const totals = useMemo(() => ({
    files: files.length,
    hunks: files.reduce((n, f) => n + (f.editHunks?.length ?? 0), 0),
    pending: files.reduce((n, f) => n + countPending(f), 0),
    add: files.reduce((n, f) => n + (f.addCount ?? 0), 0),
    del: files.reduce((n, f) => n + (f.delCount ?? 0), 0),
  }), [files]);

  /* 每个文件一个"假" code surface —— 跟 openSurfaceFromPath 造出来的形状一致, CodeSurfaceViewer 才认 */
  const fileSurfaces = useMemo(() => files.map((f): { file: AgentTurnFileEdit; abs: string; surface: Surface } => {
    const abs = resolveAbs(f.path, ws);
    return {
      file: f,
      abs,
      surface: {
        id: `review-${surface.id}-${f.path}`,
        kind: 'code',
        source: { type: 'file', path: abs },
        title: abs.split(/[/\\]/).filter(Boolean).pop() || f.path,
        pinned: false,
        createdAt: surface.createdAt,
        updatedAt: surface.updatedAt,
        metadata: {
          changedLines: f.changedLines,
          editHunks: f.editHunks,
          entryId: f.editHunks?.[0]?.__sourceEntryId,
          workspacePath: ws,
        },
      },
    };
  }), [files, ws, surface.id, surface.createdAt, surface.updatedAt]);

  if (!sessionId) {
    return <div className="sfc-review__empty">{isZh ? '这个审阅面板没有绑定会话。' : 'This review panel is not bound to a session.'}</div>;
  }
  if (files.length === 0) {
    return <div className="sfc-review__empty">{isZh ? '本轮没有待审的文件改动。' : 'No file edits to review this turn.'}</div>;
  }

  return (
    <div className="sfc-review">
      <div className="sfc-review__head">
        <div className="sfc-review__summary">
          <span className="sfc-review__title">{isZh ? '本轮改动' : 'Edits this turn'}</span>
          <span className="sfc-review__stat">{totals.files} {isZh ? '个文件' : 'files'}</span>
          <span className="sfc-review__stat sfc-review__stat--add">+{totals.add}</span>
          <span className="sfc-review__stat sfc-review__stat--del">−{totals.del}</span>
          <span className={`sfc-review__stat${totals.pending ? ' is-pending' : ''}`}>
            {totals.pending
              ? (isZh ? `${totals.pending} 处待审` : `${totals.pending} pending`)
              : (isZh ? '全部已审' : 'all reviewed')}
          </span>
          {totals.pending > 0 && (
            <span className="sfc-review__bulk">
              <button type="button" className="sfc-review__bulk-btn is-accept" onClick={acceptAll}
                title={isZh ? '接受本轮全部待审改动 (磁盘已是新内容, 只标记)' : 'Accept every pending edit this turn (marks only)'}>
                {isZh ? '全部接受' : 'Accept all'}
              </button>
              <button type="button" className="sfc-review__bulk-btn is-revert" onClick={() => { void revertAll(); }} disabled={bulkBusy}
                title={isZh ? '回退本轮全部待审改动 (物理改回磁盘)' : 'Revert every pending edit this turn (writes to disk)'}>
                {bulkBusy ? '…' : (isZh ? '全部回退' : 'Revert all')}
              </button>
            </span>
          )}
        </div>
        <div className="sfc-review__toc">
          {fileSurfaces.map(({ file }) => {
            const p = countPending(file);
            return (
              <button
                key={file.path}
                type="button"
                className={`sfc-review__toc-item${p ? '' : ' is-done'}`}
                title={file.path}
                onClick={() => sectionRefs.current.get(file.path)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                <span className="sfc-review__toc-name">{file.path.split(/[/\\]/).pop()}</span>
                {p > 0 && <span className="sfc-review__toc-badge">{p}</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="sfc-review__body">
        {fileSurfaces.map(({ file, surface: fs }) => {
          const p = countPending(file);
          return (
            <section
              key={file.path}
              className="sfc-review__file"
              ref={(el) => { sectionRefs.current.set(file.path, el); }}
            >
              <header className="sfc-review__file-head">
                <FileTypeIcon path={file.path} size={16} />
                {/* 文件名为主、所在文件夹淡一级 (跟 Git 改动列表同一种读法); 整条路径在悬停提示里 */}
                <span className="sfc-review__file-path" title={file.path}>
                  <span className="sfc-review__file-name">{file.path.split(/[/\\]/).pop()}</span>
                  <span className="sfc-review__file-dir">{file.path.split(/[/\\]/).slice(0, -1).slice(-3).join('/')}</span>
                </span>
                <span className="sfc-review__stat sfc-review__stat--add">+{file.addCount ?? 0}</span>
                <span className="sfc-review__stat sfc-review__stat--del">−{file.delCount ?? 0}</span>
                <span className={`sfc-review__stat${p ? ' is-pending' : ''}`}>
                  {p ? (isZh ? `${p} 处待审` : `${p} pending`) : (isZh ? '已审' : 'reviewed')}
                </span>
              </header>
              <div className="sfc-review__file-body" style={{ height: fileViewHeight(file) }}>
                <CodeSurfaceViewer surface={fs} workspacePath={ws} />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
};

export default ReviewSurfaceViewer;
