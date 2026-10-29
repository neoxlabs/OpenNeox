import React, { useCallback } from 'react';
import type { StepContent } from '../types';
import { useNeoxRuntimeOptional } from '../../../app/NeoxRuntimeContext';
import { displayWorkspacePath } from '../../../utils/pathUtils';
import { openSurfaceFromPath } from '../../../state/openSurfaceFromPath';
import { FilePathChip } from '../FilePathChip';
import { useI18n } from '../../../hooks/useI18n';
import { DiffView, diffLinesToChangedRanges } from './DiffView';
import { SimpleDiff } from './SimpleDiff';
import { revertFileChange, notifyRevertOutcome } from './revertFileChange';
import { confirmAsync } from '../../../components/confirmEvents';
import { dispatchHint, dispatchOpFailed } from '../../../components/notifyEvents';

type DiffContent = Extract<StepContent, { type: 'diff' }>;

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** 新建文件 = 只有加没有真删 (删除那一侧只剩空串拆出来的空行) */
function isNewFile(content: DiffContent): boolean {
  /* 只看「没删」不够: 在老文件里加一行注释也没删 —— 新文件是每一行都是加 (没有上下文行) */
  return content.addCount > 0 && content.lines.every((l) => l.kind === 'add' || (l.kind === 'del' && !l.text.trim()));
}

function displayPath(path: string, workspacePath?: string): string {
  const shown = displayWorkspacePath(path, workspacePath, { max: 72, headSegments: 1, tailSegments: 3 });
  /* 「private/…/ws5/src/util.js」: 头一段 + 省略号 + 工作区名, 卡头只要工作区里的相对路径 */
  const m = /^\S*…\/[^/\s]+\/(\S.*)$/.exec(shown);
  return m ? m[1]! : shown;
}

export const EditDiffCard: React.FC<{ content: DiffContent; dense?: boolean }> = ({ content, dense }) => {
  const runtime = useNeoxRuntimeOptional();
  const { isZh } = useI18n();
  const sessionId = runtime?.activeSession?.id;
  const workspacePath = runtime?.workspacePath;
  const changedLines = diffLinesToChangedRanges(content.lines);
  const fallbackContent = content.fallbackContent
    ?? (content.delCount === 0 && content.addCount > 0
      ? content.lines.filter((line) => line.kind === 'add').map((line) => line.text).join('\n')
      : undefined);
  const fileName = fileNameOf(content.file);
  const pathLabel = displayPath(content.file, workspacePath);
  const hasRows = content.lines.length > 0;
  const changeTone =
    content.delCount === 0 && content.addCount > 0 ? 'add' :
    content.addCount === 0 && content.delCount > 0 ? 'del' :
    'mixed';

  const openReview = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!sessionId || !content.file) return;
    openSurfaceFromPath({
      sessionId,
      path: content.file,
      workspacePath,
      changedLines,
      editHunks: content.editHunks,
      fallbackContent,
    });
  }, [changedLines, content.editHunks, content.file, fallbackContent, sessionId, workspacePath]);

  const [reverted, setReverted] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const revertDiff = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!content.file) return;
    const ok = await confirmAsync({
      title: isZh ? '回退这次改动?' : 'Revert this change?',
      message: isZh ? `「${fileName}」将回到这次改动之前的样子` : `“${fileName}” will go back to how it was before this change`,
      description: isZh
        ? '这会直接改写磁盘上的文件。回退之后这张卡会标成「已回退」, 想反悔可以点「恢复」放回去。'
        : 'This rewrites the file on disk. The card will be marked reverted — click Restore to put it back.',
      variant: 'danger',
      confirmLabel: isZh ? '回退' : 'Revert',
    });
    if (!ok) return;
    setBusy(true);
    const outcome = await revertFileChange({
      filePath: content.file,
      op: 'edit',
      editHunks: content.editHunks,
      previousSnapshotId: content.previousSnapshotId,
      workspacePath,
    });
    setBusy(false);
    if (outcome.success) setReverted(true);
    await notifyRevertOutcome(outcome, fileName, isZh);
  }, [content.editHunks, content.file, content.previousSnapshotId, fileName, isZh, workspacePath]);

  /* 恢复 —— 方向安全的那一侧, 不问二次确认 (再问一次只是烦人)。
   * 走现成的 reapplyFileEdit (主进程 file:reapply-edit), 不另造快照。 */
  const restoreDiff = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!content.file) return;
    const api = (window as unknown as {
      neox?: { reapplyFileEdit?: (p: string, o?: string, n?: string, m?: 'file' | 'edit') => Promise<{ success?: boolean; error?: string }> };
    }).neox;
    if (typeof api?.reapplyFileEdit !== 'function') {
      dispatchOpFailed({ op: isZh ? '恢复' : 'Restore', message: isZh ? '当前版本不支持恢复' : 'Restore is unavailable in this build' });
      return;
    }
    setBusy(true);
    try {
      const one = content.editHunks?.length === 1 ? content.editHunks[0] : undefined;
      const r = one?.oldString && one?.newString
        ? await api.reapplyFileEdit(content.file, one.oldString, one.newString, 'edit')
        : await api.reapplyFileEdit(content.file, undefined, undefined, 'file');
      if (r?.success) {
        setReverted(false);
        dispatchHint(isZh ? `已恢复 ${fileName}` : `Restored ${fileName}`, 'success');
      } else {
        dispatchOpFailed({ op: isZh ? '恢复' : 'Restore', message: r?.error || (isZh ? '恢复失败' : 'Restore failed') });
      }
    } catch (err: any) {
      dispatchOpFailed({ op: isZh ? '恢复' : 'Restore', message: String(err?.message ?? err) });
    } finally {
      setBusy(false);
    }
  }, [content.editHunks, content.file, fileName, isZh]);

  if (dense) {
    /* 新建文件: 「旧内容」是空串, 拆行后成了一条空的删除行挂在最上面 —— 不是改动, 去掉 */
    const shownLines = isNewFile(content)
      ? content.lines.filter((l) => !(l.kind === 'del' && !l.text.trim()))
      : content.lines;
    return (
      <div className={`nx-diff-wrap has-head${reverted ? ' is-reverted' : ''}`}
        data-reverted-label={reverted ? (isZh ? '已回退' : 'reverted') : undefined}>
        <div className="nx-diff__head">
          <FilePathChip
            path={content.file}
            display={pathLabel}
            changedLines={changedLines}
            editHunks={content.editHunks}
            fallbackContent={fallbackContent}
            className="nx-diff__path"
          />
          {isNewFile(content) && <span className="nx-diff__tag">{isZh ? '新文件' : 'New'}</span>}
          {content.addCount > 0 && <span className="nx-diff__n is-add">+{content.addCount}</span>}
          {content.delCount > 0 && !isNewFile(content) && <span className="nx-diff__n is-del">−{content.delCount}</span>}
          {reverted && <span className="nx-diff__tag is-reverted">{isZh ? '已撤销' : 'Reverted'}</span>}
          <span className="nx-diff__sp" />
          <button type="button" className="nx-diff__btn" onClick={openReview}
            title={isZh ? '在右侧查看预览 / 源码' : 'Open preview / source on the right'}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
            </svg>
            {isZh ? '查看' : 'View'}
          </button>
          <button type="button" className="nx-diff__btn" disabled={busy} onClick={reverted ? restoreDiff : revertDiff}
            title={reverted ? (isZh ? '恢复 · 把刚撤销的改动放回去' : 'Restore the reverted change') : (isZh ? '撤销本次改动' : 'Revert this change')}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              style={reverted ? { transform: 'scaleX(-1)' } : undefined}>
              <path d="M3 7v6h6" /><path d="M3.5 13a9 9 0 1 0 2.1-6.4L3 9" />
            </svg>
            {reverted ? (isZh ? '恢复' : 'Restore') : (isZh ? '撤销' : 'Undo')}
          </button>
        </div>
        {hasRows ? (
          <SimpleDiff
            lines={shownLines}
            streaming={content.streaming}
          />
        ) : (
          <div className="nx-diff__empty">
            {content.streaming
              ? (isZh ? '正在生成 diff…' : 'Preparing diff…')
              : (isZh ? '无内联 diff' : 'No inline diff')}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="atl-tool__content atl-tool__content--diff">
      <section
        className={[
          'atl-edit-diff-card',
          content.streaming ? 'is-streaming' : '',
          hasRows ? '' : 'is-empty',
          `is-${changeTone}`,
          content.delCount === 0 && content.addCount > 0 ? 'is-write-only' : '',
          reverted ? 'is-reverted' : '',
        ].filter(Boolean).join(' ')}
        data-change-tone={changeTone}
        data-reverted-label={reverted ? (isZh ? '已回退' : 'reverted') : undefined}
      >
        <header className={`atl-edit-diff-card__head${dense ? ' is-dense' : ''}`}>
          {!dense && <span className="atl-edit-diff-card__icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <path d="M5 3.8h6.7L15 7.1v9.1H5V3.8Z" />
              <path d="M11.5 3.8V7h3.3" />
              <path d="M7.7 10h4.6M7.7 12.6h3.4" />
            </svg>
          </span>}
          {!dense && <div className="atl-edit-diff-card__meta">
            <div className="atl-edit-diff-card__title">
              <span className="atl-edit-diff-card__verb">Edited</span>
              <FilePathChip
                path={content.file}
                display={fileName}
                changedLines={changedLines}
                editHunks={content.editHunks}
                fallbackContent={fallbackContent}
                className="atl-edit-diff-card__file"
              />
            </div>
            <FilePathChip
              path={content.file}
              display={pathLabel}
              changedLines={changedLines}
              editHunks={content.editHunks}
              fallbackContent={fallbackContent}
              className="atl-edit-diff-card__path"
            />
          </div>}
          {/* dense 下唯一值得留的路径信息: 文件不在工作区根目录时的相对路径 */}
          {dense && pathLabel !== fileName && (
            <FilePathChip
              path={content.file}
              display={pathLabel}
              changedLines={changedLines}
              editHunks={content.editHunks}
              fallbackContent={fallbackContent}
              className="atl-edit-diff-card__path atl-edit-diff-card__path--dense"
            />
          )}
          {/* trail: coalesce + stat + actions 合成一列, 窄宽时整体换行, 不再挤扁 Undo/Review */}
          <div className="atl-edit-diff-card__trail">
            {typeof content.coalescedCount === 'number' && content.coalescedCount > 1 && (
              <span
                className="atl-edit-diff-card__coalesce"
                title={isZh
                  ? `本回合内对此文件进行了 ${content.coalescedCount} 次操作, 卡片显示净改动`
                  : `${content.coalescedCount} operations on this file this turn; the card shows the net change`}
              >
                {/* 同上: 这个徽标的 title 也早已本地化, 只有徽标本身写着 "N ops"。 */}
                {isZh ? `${content.coalescedCount} 次操作` : `${content.coalescedCount} ops`}
              </span>
            )}
            {!dense && <span className="atl-edit-diff-card__stat" aria-label={isZh ? `新增 ${content.addCount} 行，删除 ${content.delCount} 行` : `${content.addCount} added, ${content.delCount} deleted`}>
              <span className="atl-edit-diff-card__stat-add">+{content.addCount}</span>
              <span className="atl-edit-diff-card__stat-del">-{content.delCount}</span>
            </span>}
            <div className="atl-edit-diff-card__actions">
              <button
                type="button"
                className="atl-edit-diff-card__action"
                disabled={busy}
                title={reverted
                  ? (isZh ? '恢复 · 把刚回退掉的改动放回去' : 'Restore · put the reverted change back')
                  : (isZh ? '回退本次改动' : 'Revert this change')}
                onClick={reverted ? restoreDiff : revertDiff}
              >
                {reverted ? (isZh ? '恢复' : 'Restore') : (isZh ? '回退' : 'Undo')}
              </button>
              <button
                type="button"
                className="atl-edit-diff-card__action atl-edit-diff-card__action--primary"
                title={isZh ? '在右侧查看预览 / 源码' : 'Open preview / source on the right'}
                onClick={openReview}
              >
                {isZh ? '查看' : 'Review'}
              </button>
            </div>
          </div>
        </header>
        {hasRows ? (
          <DiffView
            lines={content.lines}
            isWriteOnly={content.delCount === 0 && content.addCount > 0}
            streaming={content.streaming}
            file={content.file}
            workspacePath={workspacePath}
          />
        ) : (
          <div className="atl-edit-diff-card__empty">
            <span className="atl-edit-diff-card__empty-dot" aria-hidden="true" />
            {content.streaming
              ? (isZh ? '正在生成 diff 预览…' : 'Preparing diff preview...')
              : (isZh ? '无内联 diff 可显示' : 'No inline diff available')}
          </div>
        )}
      </section>
    </div>
  );
};
