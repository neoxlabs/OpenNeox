/* ============================================================
 * confirmSwitch — 切分支前的 dirty 防呆
 *
 *   场景: 用户切分支时若 worktree 有 uncommitted 改动, git checkout 会失败
 *   (有冲突) 或带过去 (clean overlay). 都不是用户期望的行为.
 *
 *   策略 v1 (轻量): 用原生 confirm dialog, 三选一:
 *     · stash: 暂存改动后切 → 切完用户可 `git stash pop` 恢复
 *     · discard: 放弃改动 (git checkout . + git clean -fd) 后切
 *     · cancel: 不切
 *
 *   v2 可改成 styled 玻璃拟态 modal, 暂时不做.
 * ============================================================ */

import { confirmAsync } from '../confirmEvents';
import { getGlobalLanguage } from '../../hooks/useI18n';

export type DirtySwitchAction = 'stash' | 'discard' | 'cancel';

/**
 * 三选一(stash / discard / cancel)—— 用主题确认弹窗分两步(不再原生 confirm):
 *   1. "先 stash 再切?" 确定→stash, 取消→进第二步
 *   2. "放弃改动直接切?"(danger) 确定→discard, 取消→cancel
 */
export async function promptDirtySwitch(
  targetBranch: string,
  fileCount: number,
  untrackedToDelete: string[] = [],
): Promise<DirtySwitchAction> {
  const isZh = getGlobalLanguage() === 'zh';
  const doStash = await confirmAsync({
    title: isZh ? `切到「${targetBranch}」前先暂存改动?` : `Stash changes before switching to "${targetBranch}"?`,
    message: isZh ? `当前有 ${fileCount} 个未提交的改动。` : `There are ${fileCount} uncommitted change${fileCount === 1 ? '' : 's'}.`,
    description: isZh
      ? '确定 → git stash -u 暂存(含新建的文件, 切完可 git stash pop 全部取回);取消 → 下一步可选「放弃改动」或「不切」。'
      : 'Confirm → git stash -u (includes new files; recover everything with git stash pop after switching); Cancel → next step offers "discard" or "stay".',
    confirmLabel: isZh ? '暂存并切' : 'Stash & switch',
    cancelLabel: isZh ? '下一步' : 'Next',
  });
  if (doStash) return 'stash';

  /* 新建文件要**单独点名**。它们和"改动"的后果不一样:
   * 改动还能从 git 里找回上一版, 新建的文件删了就是彻底没有了。 */
  const n = untrackedToDelete.length;
  const sample = untrackedToDelete.slice(0, 5).join('\n  ');
  const more = n > 5 ? (isZh ? `\n  …另外 ${n - 5} 个` : `\n  …and ${n - 5} more`) : '';
  const untrackedBlock = n === 0 ? '' : (isZh
    ? `\n\n🗑 其中 ${n} 个是**新建的文件**, 会被永久删除 (git 里没有任何副本):\n  ${sample}${more}`
    : `\n\n🗑 ${n} of these are **new files** and will be permanently deleted (git has no copy of them):\n  ${sample}${more}`);

  const doDiscard = await confirmAsync({
    title: isZh ? `放弃 ${fileCount} 个改动并切到「${targetBranch}」?` : `Discard ${fileCount} change${fileCount === 1 ? '' : 's'} and switch to "${targetBranch}"?`,
    message: (isZh ? '这些未提交的改动将被丢弃。' : 'These uncommitted changes will be discarded.') + untrackedBlock,
    description: isZh
      ? (n > 0
        ? '⚠️ 不可恢复。想保住新建的文件请返回上一步选「暂存」—— git stash -u 会连它们一起存起来。'
        : '⚠️ 不可恢复。确定 → 丢弃并切分支;取消 → 留在当前分支。')
      : (n > 0
        ? '⚠️ This cannot be undone. To keep the new files, go back and choose "Stash" — git stash -u saves them too.'
        : '⚠️ This cannot be undone. Confirm → discard and switch; Cancel → stay on the current branch.'),
    variant: 'danger',
    confirmLabel: isZh ? '放弃并切' : 'Discard & switch',
    cancelLabel: isZh ? '不切' : 'Stay',
  });
  return doDiscard ? 'discard' : 'cancel';
}
