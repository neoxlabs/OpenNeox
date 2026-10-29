import React, { useCallback } from 'react';
import { useNeoxRuntimeOptional } from '../../../app/NeoxRuntimeContext';
import { openSurfaceFromPath } from '../../../state/openSurfaceFromPath';
import { displayWorkspacePath, pathTooltip, resolveWorkspacePath, isPseudoEllipsisPath, isClearlyOutsideWorkspace } from '../../../utils/pathUtils';
import { IconPencil, IconUndo, IconRedo, IconChevronDown, IconEye } from '../../shell/shellIcons';
import { confirmAsync } from '../../../components/confirmEvents';
import { dispatchHint, dispatchOpFailed } from '../../../components/notifyEvents';
import { useI18n } from '../../../hooks/useI18n';
import { FilePathChip } from '../FilePathChip';
import { revertFileChange, notifyRevertOutcome } from './revertFileChange';
import thumbSlides from '../../../media/clay/thumb-slides.webp';
import { DeliverableSlideThumb } from './DeliverableSlideThumb';
import thumbSheet from '../../../media/clay/thumb-sheet.webp';
import thumbDoc from '../../../media/clay/thumb-doc.webp';
import { absoluteToAssetUrl } from '../../../../shared/assetUrlPath';

/* 成品卡 (work-run 稿): 这一轮做出来的 PPT / 表格 / 文档单独一张大卡 —— 陶土缩略图 + 文件名 + 「预览 / 在文件夹中显示」 */
const DELIVERABLE: Record<string, { art: string; zh: string; en: string }> = {
  pptx: { art: thumbSlides, zh: '演示文稿', en: 'Slides' }, ppt: { art: thumbSlides, zh: '演示文稿', en: 'Slides' }, key: { art: thumbSlides, zh: '演示文稿', en: 'Slides' },
  xlsx: { art: thumbSheet, zh: '表格', en: 'Spreadsheet' }, xls: { art: thumbSheet, zh: '表格', en: 'Spreadsheet' }, csv: { art: thumbSheet, zh: '表格', en: 'Spreadsheet' },
  docx: { art: thumbDoc, zh: '文档', en: 'Document' }, doc: { art: thumbDoc, zh: '文档', en: 'Document' }, pdf: { art: thumbDoc, zh: 'PDF', en: 'PDF' },
};

/* ---------- turn_summary — 本轮改动汇总卡片 ----------
 * 一行一文件: 文件类型图标 + 路径 (FilePathChip: 单击右侧打开 / 双击右侧编辑源码 /
 * 右键统一菜单) + add/del 数. changedLines/editHunks 经 chip 透传给 openSurfaceFromPath.
 *
 * op 语义靠右侧 +N/−N 数字承担, delete 额外靠 path 上的 strikethrough, rename 靠 "from→" 前缀. */
function getOpLabel(isZh: boolean): Record<string, string> {
  return isZh
    ? { edit: '编辑', write: '新建', delete: '删除', rename: '重命名' }
    : { edit: 'Edit', write: 'Create', delete: 'Delete', rename: 'Rename' };
}
const OP_TONE: Record<string, string> = {
  edit:   'mod',
  write:  'add',
  delete: 'del',
  rename: 'mod',
};

/** 路径展示规则:
 *   1. 绝对路径 (/Users/.../xxx) 在 workspace 之下 → 去掉 workspace 前缀变相对
 *   2. 仍然过长 (>56 字符) → 折成 ".../parent/file" 风格
 *   3. tooltip 永远是完整原 path
 *  让卡片显示不再混 "/Users/exampleuser/Code/.../foo" 跟 "backend/foo" 两种风格. */
function displayPath(path: string, workspacePath?: string): string {
  const shown = displayWorkspacePath(path, workspacePath, { max: 72, headSegments: 1, tailSegments: 3 });
  const m = /^\S*…\/[^/\s]+\/(\S.*)$/.exec(shown);
  if (m) return m[1]!;
  return /^\S*…\/[^/\s]+$/.test(shown) ? '' : shown;
}
function splitDisplay(path: string, workspacePath?: string): { name: string; dir: string } {
  const shown = displayPath(path, workspacePath);
  const i = Math.max(shown.lastIndexOf('/'), shown.lastIndexOf('\\'));
  return i < 0 ? { name: shown, dir: '' } : { name: shown.slice(i + 1), dir: shown.slice(0, i) };
}
const ARTIFACT_TAGS: Record<string, string> = {
  pptx: 'PPT', ppt: 'PPT', pptm: 'PPT', pps: 'PPT', ppsx: 'PPT',
  docx: 'DOC', doc: 'DOC',
  xlsx: 'XLS', xls: 'XLS', xlsm: 'XLS', csv: 'CSV',
  pdf:  'PDF',
  png:  'IMG', jpg: 'IMG', jpeg: 'IMG', gif: 'IMG', webp: 'IMG', bmp: 'IMG',
  svg:  'SVG',
  mp3:  'AUD', wav: 'AUD',
  mp4:  'VID', mov: 'VID',
  zip:  'ZIP',
};

export const TurnSummaryView: React.FC<{
  totalFiles: number;
  totalAdds: number;
  totalDels: number;
  changes: Array<{
    path: string;
    op: 'edit' | 'write' | 'delete' | 'rename';
    addCount: number;
    delCount: number;
    changedLines?: Array<{ start: number; end: number; kind: 'add' | 'del' | 'modify' }>;
    from?: string;
    editHunks?: Array<{ oldString?: string; newString?: string; startLine?: number }>;
    fallbackContent?: string;
    overwrote?: boolean;
  }>;
  turnId?: string;
}> = ({ totalFiles, totalAdds, totalDels, changes, turnId }) => {
  const runtime = useNeoxRuntimeOptional();
  const { isZh } = useI18n();
  const OP_LABEL = getOpLabel(isZh);
  const sessionId = runtime?.activeSession?.id;
  const workspacePath = runtime?.workspacePath;
  void turnId; /* 保留 prop 兼容签名, 现无使用 */

  const openWithHighlight = useCallback((
    path: string,
    changedLines?: any[],
    editHunks?: any[],
    fallbackContent?: string,
    preferKind: 'code' | 'doc' = 'code',
  ) => {
    if (!sessionId || !path || isPseudoEllipsisPath(path)) return;
    openSurfaceFromPath({
      sessionId,
      path: resolveWorkspacePath(path, workspacePath),
      workspacePath,
      changedLines: changedLines as any,
      editHunks: editHunks as any,
      fallbackContent,
      preferKind,
    });
  }, [sessionId, workspacePath]);

  /* 有"渲染态"可看的文档类型 —— 只有这些才值得多给一个预览按钮 */

  const [reverted, setReverted] = React.useState<Record<string, boolean>>({});
  const [busyPath, setBusyPath] = React.useState<string | null>(null);

  const revertChange = useCallback(async (change: {
    path: string;
    op: 'edit' | 'write' | 'delete' | 'rename';
    editHunks?: Array<{ oldString?: string; newString?: string; startLine?: number; previewTruncated?: boolean }>;
    previousSnapshotId?: string;
  }) => {
    if (!change.path || isPseudoEllipsisPath(change.path)) return;
    const shortName = change.path.split('/').pop() ?? change.path;
    /* 破坏性动作必须先问 —— 它直接改磁盘上的文件, 点错了没有别的地方能反悔。
     * (「恢复」不问: 它是把刚撤掉的东西放回去, 方向是安全的那一侧。) */
    const ok = await confirmAsync({
      title: isZh ? '回退这个文件?' : 'Revert this file?',
      message: isZh ? `「${shortName}」将回到本轮改动之前的样子` : `“${shortName}” will go back to how it was before this turn`,
      description: isZh
        ? '这会直接改写磁盘上的文件。回退之后这一行会标成「已回退」, 想反悔可以点「恢复」放回去。'
        : 'This rewrites the file on disk. The row will be marked reverted afterwards — click Restore to put it back.',
      variant: 'danger',
      confirmLabel: isZh ? '回退' : 'Revert',
    });
    if (!ok) return;
    setBusyPath(change.path);
    const outcome = await revertFileChange({
      filePath: resolveWorkspacePath(change.path, workspacePath),
      op: change.op,
      editHunks: change.editHunks,
      previousSnapshotId: change.previousSnapshotId,
      workspacePath,
    });
    setBusyPath(null);
    if (outcome.success) setReverted((m) => ({ ...m, [change.path]: true }));
    await notifyRevertOutcome(
      outcome,
      shortName,
      isZh,
      { outsideWorkspace: isClearlyOutsideWorkspace(change.path, workspacePath) },
    );
  }, [workspacePath, isZh]);

  /* 恢复 —— 把刚回退掉的改动重新放回去。
   *   走的是现成的 reapplyFileEdit (主进程 file:reapply-edit), 不另造快照机制:
   *   单 hunk 有 old/new 就精确重放, 否则整文件重放。方向安全, 所以不问二次确认。 */
  const restoreChange = useCallback(async (change: {
    path: string;
    editHunks?: Array<{ oldString?: string; newString?: string }>;
  }) => {
    if (!change.path || isPseudoEllipsisPath(change.path)) return;
    const shortName = change.path.split('/').pop() ?? change.path;
    const api = (window as unknown as {
      neox?: { reapplyFileEdit?: (p: string, o?: string, n?: string, m?: 'file' | 'edit') => Promise<{ success?: boolean; error?: string }> };
    }).neox;
    if (typeof api?.reapplyFileEdit !== 'function') {
      dispatchOpFailed({ op: isZh ? '恢复' : 'Restore', message: isZh ? '当前版本不支持恢复' : 'Restore is unavailable in this build' });
      return;
    }
    setBusyPath(change.path);
    try {
      const one = change.editHunks?.length === 1 ? change.editHunks[0] : undefined;
      const r = one?.oldString && one?.newString
        ? await api.reapplyFileEdit(change.path, one.oldString, one.newString, 'edit')
        : await api.reapplyFileEdit(change.path, undefined, undefined, 'file');
      if (r?.success) {
        setReverted((m) => { const n = { ...m }; delete n[change.path]; return n; });
        dispatchHint(isZh ? `已恢复 ${shortName}` : `Restored ${shortName}`, 'success');
      } else {
        dispatchOpFailed({ op: isZh ? '恢复' : 'Restore', message: r?.error || (isZh ? '恢复失败' : 'Restore failed') });
      }
    } catch (err: any) {
      dispatchOpFailed({ op: isZh ? '恢复' : 'Restore', message: String(err?.message ?? err) });
    } finally {
      setBusyPath(null);
    }
  }, [isZh]);

  const COLLAPSE_AT = 5;
  const [showAll, setShowAll] = React.useState(false);
  changes = changes.filter((c) => !/\.tmp\.\d+\.[0-9a-f]{6,}$/i.test(c.path));
  const overflowCount = Math.max(0, changes.length - COLLAPSE_AT);
  const visibleChanges = showAll || overflowCount === 0 ? changes : changes.slice(0, COLLAPSE_AT);

  const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
  const images = changes
    .filter((c) => c.op !== 'delete' && IMAGE_EXT.test(c.path) && !reverted[c.path] && !isPseudoEllipsisPath(c.path))
    .slice(0, 4)
    .map((c) => resolveWorkspacePath(c.path, workspacePath));

  const extOf = (p: string) => ((p.split(/[/\\?#]/).pop() || '').split('.').pop() || '').toLowerCase();
  const deliverables = changes
    .filter((c) => c.op !== 'delete' && DELIVERABLE[extOf(c.path)] && !reverted[c.path] && !isPseudoEllipsisPath(c.path))
    .slice(0, 3);
  const deliverablePaths = new Set(deliverables.map((c) => c.path));
  const listChanges = visibleChanges.filter((c) => !deliverablePaths.has(c.path));
  const revealApi = (window as unknown as { neox?: { fsRevealInFinder?: (p: string) => Promise<unknown> } }).neox;

  /* 卡头「全部查看」= 右栏「改动」那一页 (同一个入口, 见 AgentTimelineContextRail openSurfaceKind) */
  const openAllChanges = useCallback(() => {
    window.dispatchEvent(new CustomEvent('neox:open-surface', {
      detail: {
        kind: 'git',
        title: isZh ? '改动' : 'Changes',
        source: { type: 'inline', content: '', mime: 'text/plain' },
        metadata: { singleton: true },
        byUser: true,
      },
    }));
  }, [isZh]);
  /* 卡头「全部撤销」: 只问一次, 再逐个回退还没退过的 (重命名没有回退语义, 跳过) */
  const revertAll = useCallback(async () => {
    const targets = changes.filter((c) => c.op !== 'rename' && !reverted[c.path] && !isPseudoEllipsisPath(c.path));
    if (!targets.length) return;
    const ok = await confirmAsync({
      title: isZh ? `撤销这 ${targets.length} 个文件的改动?` : `Revert ${targets.length} files?`,
      message: isZh ? '这些文件会回到本轮改动之前的样子' : 'These files will go back to how they were before this turn',
      description: isZh
        ? '这会直接改写磁盘上的文件。每一行之后都能单独点「恢复」放回去。'
        : 'This rewrites the files on disk. Each row can be restored individually afterwards.',
      variant: 'danger',
      confirmLabel: isZh ? '全部撤销' : 'Revert all',
    });
    if (!ok) return;
    let okCount = 0;
    let failCount = 0;
    for (const c of targets) {
      setBusyPath(c.path);
      const outcome = await revertFileChange({
        filePath: resolveWorkspacePath(c.path, workspacePath),
        op: c.op,
        editHunks: c.editHunks,
        previousSnapshotId: (c as { previousSnapshotId?: string }).previousSnapshotId,
        workspacePath,
      });
      if (outcome.success) { okCount++; setReverted((m) => ({ ...m, [c.path]: true })); } else failCount++;
    }
    setBusyPath(null);
    if (failCount) dispatchOpFailed({ op: isZh ? '全部撤销' : 'Revert all', message: isZh ? `${okCount} 个已撤销, ${failCount} 个没成功` : `${okCount} reverted, ${failCount} failed` });
    else dispatchHint(isZh ? `已撤销 ${okCount} 个文件` : `Reverted ${okCount} files`, 'success');
  }, [changes, reverted, workspacePath, isZh]);

  return (
    <div className="atl-turn-summary">
      {deliverables.map((c) => {
        const abs = resolveWorkspacePath(c.path, workspacePath);
        const d = DELIVERABLE[extOf(c.path)]!;
        const name = abs.split(/[/\\]/).pop() ?? abs;
        return (
          <div key={`dl-${c.path}`} className="atl-deliverable">
            <button
              type="button"
              className="atl-deliverable__thumb"
              title={abs}
              onClick={() => { if (sessionId) openSurfaceFromPath({ sessionId, path: abs, workspacePath }); }}
            >
              {/^pptx$/i.test(extOf(c.path)) ? <DeliverableSlideThumb path={abs} fallback={d.art} /> : <img src={d.art} alt="" draggable={false} />}
            </button>
            <div className="atl-deliverable__body">
              <div className="atl-deliverable__name" title={abs}>{name}</div>
              <div className="atl-deliverable__meta">
                {isZh ? d.zh : d.en} · {c.op === 'write' && !c.overwrote ? (isZh ? '新建' : 'New') : (isZh ? '已更新' : 'Updated')}
              </div>
              <div className="atl-deliverable__acts">
                <button type="button" onClick={() => { if (sessionId) openSurfaceFromPath({ sessionId, path: abs, workspacePath }); }}>
                  {isZh ? '预览' : 'Preview'}
                </button>
                <button type="button" onClick={() => void revealApi?.fsRevealInFinder?.(abs).then((r: any) => {
                  /* 点了没反应最糟 —— 找不到就说一声 */
                  if (r?.success === false) dispatchHint(isZh ? '找不到这个文件, 可能已被移动或删除' : 'File not found — it may have been moved or deleted', 'warning');
                })}>
                  {isZh ? '在文件夹中显示' : 'Show in folder'}
                </button>
              </div>
            </div>
          </div>
        );
      })}
      {images.length > 0 && (
        <div className={`atl-turn-summary__gallery${images.length === 1 ? ' is-single' : ''}`}>
          {images.map((abs) => (
            <button
              key={abs}
              type="button"
              className="atl-turn-summary__shot"
              title={abs}
              onClick={() => { if (sessionId) openSurfaceFromPath({ sessionId, path: abs, workspacePath }); }}
            >
              <img src={absoluteToAssetUrl(abs)} alt={abs.split(/[/\\]/).pop() ?? ''} loading="lazy" draggable={false} />
            </button>
          ))}
        </div>
      )}
      {listChanges.length > 0 && <div className="atl-changes">
      <div className="atl-changes__head">
        <span className="atl-changes__head-ic" aria-hidden="true"><IconPencil size={16} /></span>
        {/* 数用过滤掉中间文件之后的 changes, 不用 totalFiles —— 否则写「2 个」下面只列 1 个 */}
        <span className="atl-changes__title">{isZh ? '本轮改动' : 'Changes'}</span>
        <span className="atl-changes__count">{isZh ? `${changes.length} 个文件` : `${changes.length} file${changes.length === 1 ? '' : 's'}`}</span>
        {totalAdds > 0 && <span className="atl-turn-summary__add">+{totalAdds}</span>}
        {totalDels > 0 && <span className="atl-turn-summary__del">−{totalDels}</span>}
        <span className="atl-changes__head-acts">
          <button type="button" className="atl-changes__btn" onClick={openAllChanges}>
            <IconEye size={13} />{isZh ? '全部查看' : 'View all'}
          </button>
          {changes.some((c) => c.op !== 'rename' && !reverted[c.path]) && (
            <button type="button" className="atl-changes__btn" disabled={!!busyPath} onClick={() => void revertAll()}>
              <IconUndo size={13} />{isZh ? '全部撤销' : 'Revert all'}
            </button>
          )}
        </span>
      </div>
      {/* 列表本身的 padding / 分隔线被老规则 !important 钉成 0, 卡内边距由这层给 */}
      <div className="atl-changes__body">
      <ul
        className="atl-turn-summary__list"
        aria-label={isZh
          ? `本轮改动：${totalFiles} 文件，新增 ${totalAdds} 行，删除 ${totalDels} 行`
          : `Changes this turn: ${totalFiles} file${totalFiles === 1 ? '' : 's'}, +${totalAdds}, −${totalDels}`}
      >
        {listChanges.map((c, i) => {
          const tone = OP_TONE[c.op] ?? 'mod';
          const label = OP_LABEL[c.op] ?? (isZh ? '改动' : 'Change');
          const ext = (c.path.split(/[/\\?#]/).pop() || '').split('.').pop()?.toLowerCase() ?? '';
          const artifactTag = ARTIFACT_TAGS[ext];
          const isArtifact = !!artifactTag;
          return (
            <li key={`${c.path}-${i}`} className={`atl-turn-summary__row atl-turn-summary__row--${tone}${isArtifact ? ' atl-turn-summary__row--artifact' : ''}${reverted[c.path] ? ' is-reverted' : ''}`}>
              <span
                className="atl-turn-summary__op"
                title={label}
                aria-hidden="true"
              >
                {/* disc = 品牌色圆盘 + 白色扩展名。
                    不用原 logo 是因为 simple-icons 有一整类 (javascript / typescript …)
                    本身就是填满画布的实心方块, 20px 行里怎么裁都是"切了角的方块",
                    字还被挤糊 (用户连指三次「我全部要圆形的」「JS 好丑」)。
                    圆盘对每种类型形状都恒定, 品牌色留住识别度。 */}
                <span className="atl-changes__tile">{(ext || 'file').slice(0, 4)}</span>
              </span>
              {c.op === 'delete' ? (
                /* 已删除文件 — 打开动作全禁, 但右键菜单仍可复制路径 (FilePathChip deleted 态). */
                <span className="atl-turn-summary__path is-deleted">
                  <FilePathChip
                    path={c.path}
                    display={displayPath(c.path, workspacePath)}
                    primaryAction="none"
                    deleted
                  />
                </span>
              ) : c.op === 'rename' ? (
                <span className="atl-turn-summary__path" title={c.from ? `${pathTooltip(c.from, workspacePath)} → ${pathTooltip(c.path, workspacePath)}` : pathTooltip(c.path, workspacePath)}>
                  {c.from && <span className="atl-turn-summary__from">{c.from.split('/').pop()} →</span>}
                  <FilePathChip
                    path={c.path}
                    display={displayPath(c.path, workspacePath)}
                    changedLines={c.changedLines}
                    editHunks={c.editHunks}
                    fallbackContent={c.fallbackContent}
                    className="atl-turn-summary__pathbtn"
                    forceDiffView
                  />
                </span>
              ) : (
                <span className="atl-turn-summary__namecol">
                  <FilePathChip
                    path={c.path}
                    display={splitDisplay(c.path, workspacePath).name}
                    changedLines={c.changedLines}
                    editHunks={c.editHunks}
                    fallbackContent={c.fallbackContent}
                    className="atl-turn-summary__pathbtn"
                    forceDiffView
                  />
                  {splitDisplay(c.path, workspacePath).dir && (
                    <span className="atl-turn-summary__dir" title={pathTooltip(c.path, workspacePath)}>{splitDisplay(c.path, workspacePath).dir}</span>
                  )}
                  {/* 只标「新建」—— 编辑是这张卡的默认动作, 每行都标一遍等于没标。
                      删除/重命名走上面各自的分支 (删除线 / from→)。 */}
                  {c.op === 'write' && !c.overwrote && !reverted[c.path] && (
                    <span className="atl-turn-summary__op-tag">{isZh ? '新建' : 'new'}</span>
                  )}
                  {reverted[c.path] && (
                    <span className="atl-turn-summary__op-tag atl-turn-summary__op-tag--reverted">
                      {isZh ? '已回退' : 'reverted'}
                    </span>
                  )}
                </span>
              )}
              <span className="atl-turn-summary__stat">
                {/* 写入 / 编辑: 显示 +N -M 对 (即便其中一个是 0), 跟单卡 chip 一致.
                 * artifact (pptx/docx/pdf/图片): 无行数概念, 显 brand tag (PPT/DOC/PDF...).
                 * 删除: 只显 -N. 重命名: 路径已 from→to 表达, 不展示 ± chip. */}
                {isArtifact && c.op !== 'delete' && c.op !== 'rename' && (
                  <span className="atl-turn-summary__kind">{artifactTag}</span>
                )}
                {/* 行数取不到时显示 "—" 而不是 +0 −0 —— 文件确实改了, 只是没有 diff 可算
                    (shell heredoc / 外部进程写的). 报 0 是假数字, 会让整张卡失去可信度. */}
                {!isArtifact && c.op !== 'delete' && c.op !== 'rename' && (
                  (c as any).statsUnknown
                    ? <span className="atl-turn-summary__nostat" title={isZh ? '该文件由 shell 或外部进程写入,没有可用的 diff,行数无法统计' : 'Written by a shell or external process — no diff available, line counts unknown'} />
                    : <>
                        {/* 0 不渲染 —— 新建文件写 "−0"、纯删改写 "+0" 都是为了凑对齐而印上去的
                            假信息。列对齐交给 CSS 的固定列宽, 不该靠占位数字。
                            两个都是 0 时 (空文件 / 无 diff) 至少留 +0, 否则整列空掉。 */}
                        {(c.addCount > 0 || c.delCount === 0) && (
                          <span className="atl-turn-summary__add">+{c.addCount}</span>
                        )}
                        {c.delCount > 0 && (
                          <span className="atl-turn-summary__del">−{c.delCount}</span>
                        )}
                      </>
                )}
                {c.op === 'delete' && c.delCount > 0 && (
                  <span className="atl-turn-summary__del">−{c.delCount}</span>
                )}
              </span>
              <span className="atl-turn-summary__actions">
                {c.op !== 'delete' && c.op !== 'rename' && (
                  <button
                    type="button"
                    className="atl-turn-summary__action"
                    title={isZh ? '查看 · 在右侧打开并定位到改动' : 'View · open on the right at the change'}
                    aria-label={isZh ? '查看' : 'View'}
                    onClick={(e) => {
                      e.stopPropagation();
                      openWithHighlight(c.path, c.changedLines, c.editHunks, c.fallbackContent, 'code');
                    }}
                  ><IconEye size={13} /></button>
                )}
                {c.op !== 'rename' && (reverted[c.path] ? (
                  /* 已回退 → 这颗变「恢复」。同一个位置、镜像的图标, 方向一目了然;
                   * 不再显示回退 (已经退过了, 再点一次没有意义)。 */
                  <button
                    type="button"
                    className="atl-turn-summary__action atl-turn-summary__action--restore"
                    disabled={busyPath === c.path}
                    title={isZh ? '恢复 · 把刚回退掉的改动放回去' : 'Restore · put the reverted change back'}
                    aria-label={isZh ? '恢复' : 'Restore'}
                    onClick={(e) => { e.stopPropagation(); void restoreChange(c); }}
                  ><IconRedo size={13} /></button>
                ) : (
                  <button
                    type="button"
                    className="atl-turn-summary__action atl-turn-summary__action--revert"
                    disabled={busyPath === c.path}
                    title={isClearlyOutsideWorkspace(c.path, workspacePath)
                      ? (isZh
                        ? '回退 · 这个文件不在当前工作区, 可能没有可回退的快照'
                        : 'Revert · this file is outside the current workspace, so there may be no snapshot to restore')
                      : (isZh ? '回退 · 撤销这个文件本轮的改动' : "Revert · undo this file's changes this turn")}
                    aria-label={isZh ? '回退' : 'Revert'}
                    onClick={(e) => {
                      e.stopPropagation();
                      void revertChange(c);
                    }}
                  ><IconUndo size={13} /></button>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      {overflowCount > 0 && (
        <button
          type="button"
          className="atl-turn-summary__more"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
        >
          <span className="atl-turn-summary__more-icon" aria-hidden>
            <IconChevronDown size={13} />
          </span>
          {showAll
            ? (isZh ? "收起" : "Show less")
            : (isZh ? `还有 ${overflowCount} 个文件 · 展开` : `${overflowCount} more file${overflowCount === 1 ? "" : "s"} · Show all`)}
        </button>
      )}
      </div>
      </div>}
    </div>
  );
};
