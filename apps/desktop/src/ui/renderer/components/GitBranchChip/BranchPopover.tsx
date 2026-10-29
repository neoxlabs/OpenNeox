/* ============================================================
 * BranchPopover — chip 点开后的分支切换面板
 *
 *   · 顶部: 搜索框 + 当前分支显示
 *   · 列表: 本地分支 (✓ 当前), 远程分支折叠
 *   · 底部: "新建分支..." (打开 inline 输入)
 *
 *   交互:
 *     · 点列表项 → 切换 (dirty 时走 confirmSwitch)
 *     · 新建分支 → input → 回车 git create-branch + checkout
 *     · ESC / 外部点击 → 关闭 (由父组件控制 open state)
 * ============================================================ */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useEnterTransition } from '../../hooks/useEnterTransition';
import { promptDirtySwitch } from './confirmSwitch';
import { refreshGitState, type GitState } from '../../state/gitStateStore';
import { usePopoverDismiss } from '../../hooks/usePopoverDismiss';
import { useI18n } from '../../hooks/useI18n';
import { friendlyOpError } from '../notifyEvents';
import { confirmAsync, promptAsync } from '../confirmEvents';

interface RefsResult {
  head: string;
  local: string[];
  remote: string[];
  tags: string[];
}

interface BranchPopoverProps {
  cwd: string;
  state: GitState;
  anchorRect: DOMRect | null;
  onClose: () => void;
  /** 父组件可监听 toast — 切分支结果给 banner 提示 */
  onToast?: (kind: 'ok' | 'err', msg: string) => void;
}

export const BranchPopover: React.FC<BranchPopoverProps> = ({ cwd, state, anchorRect, onClose, onToast }) => {
  const { isZh } = useI18n();
  /* macOS 入场动画 —— 菜单用 pop (只缩放不位移, 位移会跟触发器脱节) */
  const entered = useEnterTransition();
  const [refs, setRefs] = useState<RefsResult | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; branch: string } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  /* 拉本地/远程分支列表 */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r: RefsResult = await (window as any).neox.gitRefs(cwd);
        if (!cancelled) setRefs(r);
      } catch {
        if (!cancelled) setRefs({ head: state.branch, local: [state.branch].filter(Boolean), remote: [], tags: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [cwd, state.branch]);

  useEffect(() => {
    if (!ctxMenu) return;
    const h = (e: MouseEvent) => { if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ctxMenu]);

  const runBranchAction = async (action: string, branch: string) => {
    setCtxMenu(null);
    const neox = (window as any).neox;
    try {
      switch (action) {
        case 'checkout': await neox.gitCheckout(cwd, branch); onToast?.('ok', isZh ? `已切换到 ${branch}` : `Switched to ${branch}`); break;
        case 'merge': await neox.gitMerge(cwd, branch); onToast?.('ok', isZh ? `已合并 ${branch}` : `Merged ${branch}`); break;
        case 'rebase': await neox.gitRebase(cwd, branch); onToast?.('ok', isZh ? `已变基到 ${branch}` : `Rebased onto ${branch}`); break;
        case 'push': await neox.gitPush(cwd); onToast?.('ok', isZh ? 'Push 完成' : 'Push done'); break;
        case 'pull': await neox.gitPull(cwd); onToast?.('ok', isZh ? 'Pull 完成' : 'Pull done'); break;
        case 'tag': {
          const tag = await promptAsync({
            title: isZh ? '新建标签' : 'New tag',
            message: isZh ? `在 ${branch} 上创建标签:` : `Create tag on ${branch}:`,
            defaultValue: 'v',
            confirmLabel: isZh ? '创建' : 'Create',
          });
          if (tag) { await neox.gitCreateTag(cwd, tag, branch); onToast?.('ok', isZh ? `已创建标签 ${tag}` : `Tag ${tag} created`); }
          break;
        }
        case 'delete': {
          const ok = await confirmAsync({
            title: isZh ? '删除分支' : 'Delete branch',
            message: isZh ? `确定删除分支 "${branch}"？` : `Delete branch "${branch}"?`,
            variant: 'danger',
            confirmLabel: isZh ? '删除' : 'Delete',
          });
          if (ok) {
            await neox.gitDeleteBranch(cwd, branch, false);
            setRefs((p) => p ? { ...p, local: p.local.filter((x) => x !== branch) } : p);
            onToast?.('ok', isZh ? `已删除 ${branch}` : `Deleted ${branch}`);
          }
          break;
        }
      }
    } catch (e: any) { onToast?.('err', e?.message || String(e)); }
  };

  /* 自动聚焦搜索框 */
  useEffect(() => { inputRef.current?.focus(); }, []);

  /* 统一 popover 关闭逻辑 */
  usePopoverDismiss({
    open: true,
    refs: [rootRef],
    onDismiss: onClose,
  });

  const filtered = (refs?.local || []).filter((b) => !query || b.toLowerCase().includes(query.toLowerCase()));

  const doCheckout = useCallback(async (branch: string) => {
    if (branch === state.branch || busy) return;
    const neox = (window as any).neox;
    /* dirty 防呆 */
    if (state.dirty) {
      let untracked: string[] = [];
      try { untracked = (await neox.gitCleanPreview?.(cwd)) ?? []; } catch { untracked = []; }
      const action = await promptDirtySwitch(branch, state.files.length, untracked);
      if (action === 'cancel') return;
      setBusy(true);
      try {
        if (action === 'stash') {
          await neox.gitStash(cwd, `neox-auto-stash before checkout ${branch}`);
        } else if (action === 'discard') {
          await neox.gitDiscardWorktree(cwd);
        }
      } catch (e: any) {
        onToast?.('err', isZh ? `预处理失败: ${friendlyOpError(e)}` : `Pre-step failed: ${friendlyOpError(e)}`);
        setBusy(false);
        return;
      }
    } else {
      setBusy(true);
    }
    try {
      await neox.gitCheckout(cwd, branch);
      onToast?.('ok', isZh ? `已切到 ${branch}` : `Switched to ${branch}`);
      await refreshGitState(cwd);
      onClose();
    } catch (e: any) {
      onToast?.('err', isZh ? `切分支失败: ${friendlyOpError(e)}` : `Checkout failed: ${friendlyOpError(e)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, cwd, state.branch, state.dirty, state.files.length, onClose, onToast, isZh]);

  const doCreate = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const neox = (window as any).neox;
      /* 基于当前 HEAD 建分支 + 切过去 */
      await neox.gitCreateBranch(cwd, name, 'HEAD');
      await neox.gitCheckout(cwd, name);
      onToast?.('ok', isZh ? `已创建并切到 ${name}` : `Created and switched to ${name}`);
      await refreshGitState(cwd);
      onClose();
    } catch (e: any) {
      onToast?.('err', isZh ? `新建分支失败: ${friendlyOpError(e)}` : `Create branch failed: ${friendlyOpError(e)}`);
    } finally {
      setBusy(false);
    }
  }, [cwd, newBranchName, busy, onClose, onToast, isZh]);

  /* popover 跟随 anchor 定位 — anchor 在上半屏向下弹 (top), 下半屏向上弹 (bottom). */
  const popStyle: React.CSSProperties = (() => {
    if (!anchorRect) return { bottom: 40, left: 16 };
    const W = 280;
    const EST_H = 380;
    const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - W - 8);
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    if (spaceBelow >= EST_H || anchorRect.top < window.innerHeight / 2) {
      return { top: anchorRect.bottom + 4, left, width: W };
    }
    return { bottom: window.innerHeight - anchorRect.top + 4, left, width: W };
  })();

  return (
    <div
      ref={rootRef}
      className={`neox-branch-popover nx-in nx-in--pop ${entered ? 'is-in' : ''}`}
      style={popStyle}
      role="dialog"
      aria-label={isZh ? '切换分支' : 'Switch branch'}
    >
      {/* ── 顶部: 搜索 + 快捷操作 ── */}
      <div className="neox-branch-popover__head">
        <input
          ref={inputRef}
          type="text"
          className="neox-branch-popover__search"
          placeholder={isZh ? '搜索分支…' : 'Search branches…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={busy}
        />
        <div className="neox-branch-popover__actions">
          <button className="neox-branch-popover__action" title={isZh ? '抓取 (Fetch)' : 'Fetch'} onClick={async () => {
            try { await (window as any).neox.gitFetch(cwd); onToast?.('ok', isZh ? 'Fetch 完成' : 'Fetch done'); }
            catch (e: any) { onToast?.('err', isZh ? `Fetch 失败: ${friendlyOpError(e)}` : `Fetch failed: ${friendlyOpError(e)}`); }
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button className="neox-branch-popover__action" title={isZh ? '拉取 (Pull)' : 'Pull'} onClick={async () => {
            try { await (window as any).neox.gitPull(cwd); onToast?.('ok', isZh ? 'Pull 完成' : 'Pull done'); }
            catch (e: any) { onToast?.('err', isZh ? `Pull 失败: ${friendlyOpError(e)}` : `Pull failed: ${friendlyOpError(e)}`); }
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg>
          </button>
          <button className="neox-branch-popover__action" title={isZh ? '推送 (Push)' : 'Push'} onClick={async () => {
            try { await (window as any).neox.gitPush(cwd); onToast?.('ok', isZh ? 'Push 完成' : 'Push done'); }
            catch (e: any) { onToast?.('err', isZh ? `Push 失败: ${friendlyOpError(e)}` : `Push failed: ${friendlyOpError(e)}`); }
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </button>
        </div>
      </div>

      {/* ── 分支列表: 本地 + 远程分组 ── */}
      <div className="neox-branch-popover__list" role="listbox">
        {filtered.length === 0 && refs?.remote?.length === 0 && (
          <div className="neox-branch-popover__empty neox-text-shimmer">
            {refs ? (isZh ? '没有匹配的分支' : 'No matching branches') : (isZh ? '加载中…' : 'Loading…')}
          </div>
        )}

        {/* 本地分支 */}
        {filtered.length > 0 && (
          <div className="neox-branch-popover__group">
            <div className="neox-branch-popover__group-label">{isZh ? '本地分支' : 'Local branches'}</div>
            {filtered.map((b) => {
              const isCurrent = b === state.branch;
              return (
                <button
                  key={b}
                  type="button"
                  className={`neox-branch-popover__item${isCurrent ? ' is-current' : ''}`}
                  onClick={() => doCheckout(b)}
                  onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, branch: b }); }}
                  disabled={busy || isCurrent}
                  role="option"
                  aria-selected={isCurrent}
                >
                  <svg className="neox-branch-popover__bicon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>
                  <span className="neox-branch-popover__info">
                    <span className="neox-branch-popover__name" title={b}>{b}</span>
                    {isCurrent && state.dirty && <span className="neox-branch-popover__sub">{isZh ? `未提交: ${(state as any).changedCount || '?'} 个文件` : `Uncommitted: ${(state as any).changedCount || '?'} files`}</span>}
                  </span>
                  {isCurrent && <span className="neox-branch-popover__check">✓</span>}
                </button>
              );
            })}
          </div>
        )}

        {/* 远程分支 */}
        {refs && refs.remote.length > 0 && (
          <div className="neox-branch-popover__group">
            <div className="neox-branch-popover__group-label">{isZh ? '远程分支' : 'Remote branches'}</div>
            {refs.remote.filter((b) => !query || b.toLowerCase().includes(query.toLowerCase())).slice(0, 10).map((b) => (
              <button key={b} type="button" className="neox-branch-popover__item neox-branch-popover__item--remote"
                onClick={() => doCheckout(b)} disabled={busy}
              >
                <span className="neox-branch-popover__check" />
                <span className="neox-branch-popover__name" title={b}>{b}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="neox-branch-popover__foot">
        {creating ? (
          <div className="neox-branch-popover__create">
            <input
              type="text"
              className="neox-branch-popover__search"
              placeholder={isZh ? '新分支名 (回车确认)' : 'New branch name (Enter to confirm)'}
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void doCreate(); }
                if (e.key === 'Escape') { setCreating(false); setNewBranchName(''); }
              }}
              autoFocus
              disabled={busy}
            />
          </div>
        ) : (
          <button
            type="button"
            className="neox-branch-popover__create-btn"
            onClick={() => setCreating(true)}
            disabled={busy}
          >
            {isZh ? '+ 新建分支…' : '+ New branch…'}
          </button>
        )}
      </div>

      {/* 分支右键菜单 */}
      {ctxMenu && (
        <div ref={ctxRef} className="neox-branch-ctx" style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 99999 }}>
          {ctxMenu.branch !== state.branch && (
            <button className="neox-branch-ctx__item" onClick={() => runBranchAction('checkout', ctxMenu.branch)}>
              {isZh ? '切换到此分支' : 'Switch to this branch'}
            </button>
          )}
          {ctxMenu.branch !== state.branch && (
            <button className="neox-branch-ctx__item" onClick={() => runBranchAction('merge', ctxMenu.branch)}>
              {isZh ? '合并到当前分支' : 'Merge into current branch'}
            </button>
          )}
          {ctxMenu.branch !== state.branch && (
            <button className="neox-branch-ctx__item" onClick={() => runBranchAction('rebase', ctxMenu.branch)}>
              {isZh ? '变基到此分支' : 'Rebase onto this branch'}
            </button>
          )}
          <div className="neox-branch-ctx__sep" />
          <button className="neox-branch-ctx__item" onClick={() => runBranchAction('push', ctxMenu.branch)}>
            {isZh ? '推送' : 'Push'}
          </button>
          <button className="neox-branch-ctx__item" onClick={() => runBranchAction('pull', ctxMenu.branch)}>
            {isZh ? '拉取' : 'Pull'}
          </button>
          <button className="neox-branch-ctx__item" onClick={() => runBranchAction('tag', ctxMenu.branch)}>
            {isZh ? '创建标签…' : 'Create tag…'}
          </button>
          {ctxMenu.branch !== state.branch && (
            <>
              <div className="neox-branch-ctx__sep" />
              <button className="neox-branch-ctx__item neox-branch-ctx__item--danger" onClick={() => runBranchAction('delete', ctxMenu.branch)}>
                {isZh ? '删除分支' : 'Delete branch'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default BranchPopover;
