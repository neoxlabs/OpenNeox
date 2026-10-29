import React from 'react';
import { useI18n } from '../../../hooks/useI18n';

type OpChipIconKey =
  | 'plan' | 'worktree' | 'worktree_exit'
  | 'trash' | 'pen' | 'folder_plus'
  | 'stop' | 'play'
  | 'task' | 'task_done' | 'info'
  | 'clock' | 'search' | 'plus' | 'commit' | 'send' | 'sessions';

const OpChipIcon: React.FC<{ kind: string }> = ({ kind }) => {
  const common = {
    viewBox: '0 0 16 16',
    width: 14,
    height: 14,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (kind as OpChipIconKey) {
    case 'plan':
      return <svg {...common}><rect x="3" y="3" width="10" height="11" rx="1.5" /><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" /></svg>;
    case 'worktree':
      return <svg {...common}><circle cx="4.5" cy="4" r="1.5" /><circle cx="4.5" cy="12" r="1.5" /><circle cx="11.5" cy="8" r="1.5" /><path d="M4.5 5.5v5M6 4h2a3 3 0 0 1 3 3v.5" /></svg>;
    case 'worktree_exit':
      return <svg {...common}><path d="M10 4l-4 4 4 4M6 8h7" /></svg>;
    case 'trash':
      return <svg {...common}><path d="M3 4.5h10M5.5 4.5v-1a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1" /><path d="M4 4.5l.7 8.2a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4.5" /><path d="M6.5 7v4M9.5 7v4" /></svg>;
    case 'pen':
      return <svg {...common}><path d="M11.5 3.5l1 1L5 12l-2 .5.5-2L11.5 3.5z" /><path d="M10 5l1 1" /></svg>;
    case 'folder_plus':
      return <svg {...common}><path d="M2.5 5a1 1 0 0 1 1-1h2.5l1.5 1.5h5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5z" /><path d="M8 7.5v3M6.5 9h3" /></svg>;
    case 'stop':
      return <svg {...common}><rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor" stroke="none" /></svg>;
    case 'play':
      return <svg {...common}><path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none" /></svg>;
    case 'task':
      return <svg {...common}><rect x="3" y="3" width="10" height="10" rx="1.5" /></svg>;
    case 'task_done':
      return <svg {...common}><rect x="3" y="3" width="10" height="10" rx="1.5" /><path d="M5.5 8l2 2 3.5-4" /></svg>;
    case 'info':
      return <svg {...common}><circle cx="8" cy="8" r="6" /><path d="M8 7v4M8 5h.01" /></svg>;
    case 'clock':
      return <svg {...common}><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></svg>;
    case 'search':
      return <svg {...common}><circle cx="7" cy="7" r="3.5" /><path d="M9.5 9.5l3 3" /></svg>;
    case 'plus':
      return <svg {...common}><path d="M8 3v10M3 8h10" /></svg>;
    case 'commit':
      return <svg {...common}><circle cx="8" cy="8" r="2.5" /><path d="M2 8h3.5M10.5 8H14" /></svg>;
    case 'send':
      return <svg {...common}><path d="M13.5 2.5L7 9M13.5 2.5l-4 11-2.5-4.5L2.5 6.5z" /></svg>;
    case 'sessions':
      return <svg {...common}><rect x="2.5" y="3" width="8" height="6.5" rx="1.2" /><path d="M5.5 12.5h6.8a1.2 1.2 0 0 0 1.2-1.2V6" /></svg>;
    default:
      return null;
  }
};

/** 撤销删除的状态机 —— 行尾按钮 (TimelineStep) 和旧的 chip 卡共用同一份。 */
function useUndoDeletion(deletionSnapshotId: string | undefined) {
  const { isZh } = useI18n();
  const [undoing, setUndoing] = React.useState(false);
  const [undone, setUndone] = React.useState(false);

  const undoDelete = React.useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!deletionSnapshotId || undoing) return;
    setUndoing(true);
    const api: any = (window as any).neox;
    const notify = await import('../../../components/notifyEvents');
    try {
      const r = await api?.restoreDeletion?.({ snapshotId: deletionSnapshotId });
      if (r?.success) {
        setUndone(true);
        notify.dispatchHint(
          r.restored === r.total
            ? (isZh ? '已恢复删除的内容' : 'Deleted content restored')
            : (isZh ? `已恢复 ${r.restored}/${r.total} 个文件` : `Restored ${r.restored}/${r.total} files`),
          'success',
        );
      } else {
        notify.dispatchOpFailed({
          op: isZh ? '撤销删除' : 'Undo delete',
          /* 快照过期(默认留 7 天)是唯一常见原因 —— 说清楚, 别让用户以为是 bug */
          message: r?.error || (isZh ? '删除前的快照已不可用' : 'The pre-delete snapshot is no longer available'),
        });
      }
    } catch (err: any) {
      notify.dispatchOpFailed({ op: isZh ? '撤销删除' : 'Undo delete', message: String(err?.message ?? err) });
    } finally {
      setUndoing(false);
    }
  }, [deletionSnapshotId, undoing, isZh]);

  return { undoDelete, undoing, undone, isZh };
}

export const OpChipUndoButton: React.FC<{ deletionSnapshotId?: string; className: string }> = ({ deletionSnapshotId, className }) => {
  const { undoDelete, undoing, undone, isZh } = useUndoDeletion(deletionSnapshotId);
  if (!deletionSnapshotId) return null;
  if (undone) return <span className={`${className} is-done`}>{isZh ? '已恢复' : 'Restored'}</span>;
  return (
    <button
      type="button"
      className={className}
      onClick={undoDelete}
      disabled={undoing}
      title={isZh ? '把删除前的内容写回原位' : 'Write the pre-delete content back in place'}
    >
      {undoing ? (isZh ? '恢复中…' : 'Restoring…') : (isZh ? '撤销删除' : 'Undo delete')}
    </button>
  );
};

export const OpChipView: React.FC<{
  icon?: string;
  label: string;
  target?: string;
  hint?: string;
  tone?: 'primary' | 'ok' | 'warn' | 'err' | 'plain';
  /** delete_file 删除前的内容快照 —— 有它才给"撤销删除". */
  deletionSnapshotId?: string;
}> = ({ icon, label, target, hint, tone = 'plain', deletionSnapshotId }) => {
  const { undoDelete, undoing, undone, isZh } = useUndoDeletion(deletionSnapshotId);

  return (
    <div className={`atl-opchip is-${tone}`}>
      {icon && <span className="atl-opchip__icon" aria-hidden="true"><OpChipIcon kind={icon} /></span>}
      <span className="atl-opchip__label">{label}</span>
      {target && <code className="atl-opchip__target">{target}</code>}
      {hint && <span className="atl-opchip__hint">{hint}</span>}
      {deletionSnapshotId && !undone && (
        <button
          type="button"
          className="atl-opchip__undo"
          onClick={undoDelete}
          disabled={undoing}
          title={isZh ? '把删除前的内容写回原位' : 'Write the pre-delete content back in place'}
        >
          {undoing ? (isZh ? '恢复中…' : 'Restoring…') : (isZh ? '撤销删除' : 'Undo delete')}
        </button>
      )}
      {undone && <span className="atl-opchip__hint">{isZh ? '已恢复' : 'Restored'}</span>}
    </div>
  );
};

