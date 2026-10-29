/* ============================================================
 * GitBranchChip — 共用分支显示 + 切换 chip
 *
 *   两种 variant:
 *     · header:    Agent 顶部 header (无边框纯文本, 紧贴 cwd label)
 *     · statusbar: IDE 底部 status bar (StatusItem 风格, 含 branch glyph)
 *
 *   状态:
 *     · 非 git 仓库 / state.loaded=false → 不渲染 (返回 null)
 *     · clean      → "main"
 *     · dirty      → "main ●"   (橙色小圆点)
 *     · ahead/behind → "main ↑2 ↓1"
 *     · 切换中     → 灰显
 *     · disabled (agent running) → 灰显 + 提示
 *
 *   点击 → 弹 BranchPopover (锚定到 chip 本体)
 * ============================================================ */

import React, { useCallback, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useGitState } from '../../hooks/useGitState';
import { useI18n } from '../../hooks/useI18n';
import { BranchPopover } from './BranchPopover';
import { bodyOf } from '../../utils/ownerDoc';
import './GitBranchChip.css';

interface GitBranchChipProps {
  /** 当前 workspace 绝对路径 — 非 git 仓库时 chip 自动隐藏 */
  cwd: string | undefined;
  /** 'header' (Agent 顶部) | 'statusbar' (IDE 底部) — 两种视觉变体 */
  variant: 'header' | 'statusbar';
  /** agent 正在跑时为 true — 禁用切换 (避免 worktree 跟 agent 写文件 race) */
  disabled?: boolean;
  /** toast 回调 — 切分支结果给宿主 banner */
  onToast?: (kind: 'ok' | 'err', msg: string) => void;
}

const BranchGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="9" r="2.5" />
    <path d="M6 8.5v7M8.5 6h6.5a3 3 0 0 1 3 3v0" />
  </svg>
);

export const GitBranchChip: React.FC<GitBranchChipProps> = ({ cwd, variant, disabled = false, onToast }) => {
  const state = useGitState(cwd);
  const { isZh } = useI18n();
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  /* hooks 必须在任何 early return 前全部调用完 — 否则触发
   * "Rendered more hooks than during the previous render". */
  const onClick = useCallback(() => {
    if (disabled || !cwd || !state.isGitRepo) return;
    const rect = btnRef.current?.getBoundingClientRect() || null;
    setAnchorRect(rect);
    setOpen((v) => !v);
  }, [cwd, disabled, state.isGitRepo]);

  /* 非 git 仓库 / 还没拉过 → 不占位 (避免 1 秒后才闪出) */
  if (!cwd) return null;
  if (state.loaded && !state.isGitRepo) return null;
  if (!state.loaded && variant === 'header') {
    /* 首次加载: header 版完全不占 (避免布局抖); statusbar 版占一个 placeholder */
    return null;
  }

  const branchText = state.branch || (state.loaded ? '—' : '…');
  const aheadBehind: string[] = [];
  if (state.ahead > 0) aheadBehind.push(`↑${state.ahead}`);
  if (state.behind > 0) aheadBehind.push(`↓${state.behind}`);

  const title = (() => {
    if (disabled) return isZh ? '运行中不能切分支' : 'Cannot switch branches while running';
    if (!state.isGitRepo) return isZh ? '当前目录不是 git 仓库' : 'Not a git repository';
    const parts = [isZh ? `分支: ${state.branch}` : `Branch: ${state.branch}`];
    if (state.dirty) parts.push(isZh ? `${state.files.length} 个改动未提交` : `${state.files.length} uncommitted change${state.files.length === 1 ? '' : 's'}`);
    if (state.ahead) parts.push(isZh ? `${state.ahead} 个 commit 待 push` : `${state.ahead} commit${state.ahead === 1 ? '' : 's'} to push`);
    if (state.behind) parts.push(isZh ? `${state.behind} 个 commit 待 pull` : `${state.behind} commit${state.behind === 1 ? '' : 's'} to pull`);
    return parts.join(' · ');
  })();

  const className = [
    'neox-git-chip',
    `neox-git-chip--${variant}`,
    state.dirty ? 'is-dirty' : '',
    disabled ? 'is-disabled' : '',
    open ? 'is-open' : '',
  ].filter(Boolean).join(' ');

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={className}
        onClick={onClick}
        disabled={disabled}
        title={title}
        aria-label={title}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="neox-git-chip__glyph"><BranchGlyph /></span>
        <span className="neox-git-chip__name">{branchText}</span>
        {state.dirty && <span className="neox-git-chip__dot" aria-hidden="true" />}
        {aheadBehind.length > 0 && (
          <span className="neox-git-chip__delta">{aheadBehind.join(' ')}</span>
        )}
      </button>
      {open && cwd && ReactDOM.createPortal(
        <BranchPopover
          cwd={cwd}
          state={state}
          anchorRect={anchorRect}
          onClose={() => setOpen(false)}
          onToast={onToast}
        />,
        bodyOf(btnRef.current),
      )}
    </>
  );
};

export default GitBranchChip;
