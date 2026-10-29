/**
 * CommitPanel —— IDEA New UI 风格 Git Commit 面板
 *
 * 布局（自上而下）：
 *   1. 标题栏 "提交" + 工具栏图标
 *   2. 文件树（占满剩余空间）—— 带 checkbox 的可折叠分组
 *      - "更改  N 个文件"  （tracked changes: staged + unstaged）
 *      - "未进行版本管理的文件  N 个文件"  （untracked）
 *   3. 底部固定区 —— Amend checkbox → 提交消息 → 提交/提交并推送 按钮
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVcsContext } from '../../../state/vcsContext';
import Icons from '../../../components/Icons';
import FileTypeIcon from '../../../components/FileTypeIcon';
import { classifyUntracked, type Bucket, type BucketKey } from './untrackedClassifier';
import FileRowContextMenu, { type FileArea } from './FileRowContextMenu';
import { confirmAsync } from '../../../components/confirmEvents';
import './CommitPanel.css';
import { friendlyOpError } from '../../../components/notifyEvents';
import { useI18n } from '../../../hooks/useI18n';
import { refreshGitState, type GitFileStatus, type GitStatusView as GitStatusResult } from '../../../state/gitStateStore';
import { useGitState } from '../../../hooks/useGitState';
import { CappedRows, GitStatusLimitNote } from '../../../components/CappedRows';

const BUCKET_LABEL_EN: Record<BucketKey, { label: string; description: string }> = {
  deps:  { label: 'Dependencies',   description: 'Suggest adding to .gitignore' },
  build: { label: 'Build output',   description: 'Suggest adding to .gitignore' },
  tmp:   { label: 'Temp & logs',    description: 'Suggest adding to .gitignore' },
  ide:   { label: 'IDE / system',   description: 'Suggest adding to .gitignore' },
  byDir: { label: 'Other',          description: 'Grouped by directory' },
  loose: { label: 'Loose files',    description: 'Top-level / single files' },
};

// ────────────────────────────── Types ──────────────────────────────


// ────────────────────────────── Helpers ──────────────────────────────

/** 文件名颜色：按文件状态着色 —— 走 CSS 变量(CommitPanel.css 定义 light/dark 两套, 保证对比度), 不再写死 hex */
function fileColor(file: GitFileStatus): string {
  if (file.area === 'untracked') return 'var(--cp-status-untracked)';
  const code = file.area === 'staged' ? file.indexStatus : file.worktreeStatus;
  switch (code.trim()) {
    case 'A': return 'var(--cp-status-added)';
    case 'D': return 'var(--cp-status-deleted)';
    case 'R': return 'var(--cp-status-renamed)';
    default:  return 'var(--cp-status-modified)';
  }
}

function fileName(p: string): string {
  return p.split('/').pop() || p;
}

function dirName(p: string): string {
  const parts = p.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

/* 文件类型 icon 不再走"字母 + 颜色"方案 —
 *   改用 FileTypeIcon 组件加载 assets/icons/file-types/*.svg (simple-icons CC0),
 *   统一一套真实 brand logo. 见 components/FileTypeIcon.tsx. */

// ────────────────────────────── Persistence ──────────────────────────────
/* 折叠态 localStorage 持久化 — 走两个独立 key:
 *   · neox-cp-groups-v1  : 顶级两组 (changes / untracked)
 *   · neox-cp-buckets-v1 : untracked 分组 (deps/build/tmp/ide/byDir/loose)
 *
 *   失败 (隐私模式 / 空间满) 就静默 fallback, 不影响功能. */
const LS_GROUPS_KEY = 'neox-cp-groups-v1';
const LS_BUCKETS_KEY = 'neox-cp-buckets-v1';

interface PersistedGroups { changes?: boolean; untracked?: boolean; }

function loadPersistedGroups(): PersistedGroups {
  try {
    const raw = window.localStorage.getItem(LS_GROUPS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }
}
function savePersistedGroups(g: PersistedGroups): void {
  try { window.localStorage.setItem(LS_GROUPS_KEY, JSON.stringify(g)); } catch { /* no-op */ }
}
function loadPersistedBuckets(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(LS_BUCKETS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }
}
function savePersistedBuckets(b: Record<string, boolean>): void {
  try { window.localStorage.setItem(LS_BUCKETS_KEY, JSON.stringify(b)); } catch { /* no-op */ }
}

// ────────────────────────────── Component ──────────────────────────────

export interface CommitPanelProps {
  /** 点文件在右侧面板打开 (走 surfaceStore.ingestSurfaceEvent, 要 sessionId).
   *  缺省时退回 vcs context 的 onOpenFile. */
  onPreviewSurface?: (filePath: string) => void;
  /** 查看 diff — 走 diff surface; 缺省时弹 toast 提示 */
  onViewDiff?: (filePath: string) => void;
}

const CommitPanel: React.FC<CommitPanelProps> = ({ onPreviewSurface, onViewDiff }) => {
  const { workspacePath, onToast, onOpenFile } = useVcsContext();
  const { isZh } = useI18n();
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [amend, setAmend] = useState(false);
  // checked 文件 — 用于选择哪些参与 commit（IDEA 的 checkbox 模式）
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());
  // 折叠状态 — 初始值用 lazy initializer 读 localStorage 一次, 没就用 fallback
  const [changesCollapsed, setChangesCollapsed] = useState(() => loadPersistedGroups().changes ?? false);
  const [untrackedCollapsed, setUntrackedCollapsed] = useState(() => loadPersistedGroups().untracked ?? true);
  const [generating, setGenerating] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /* untracked bucket 折叠状态 — 每 bucket key 一份, 默认遵从 classifier defaultCollapsed.
   *   值 = true 折叠, false 展开. 走 localStorage 持久化, 见下方 useEffect. */
  const [bucketCollapsed, setBucketCollapsed] = useState<Record<string, boolean>>(() => loadPersistedBuckets());
  /* 右键菜单 state — 同时只能开一个 */
  const [contextMenu, setContextMenu] = useState<{
    file: GitFileStatus;
    anchor: { x: number; y: number };
  } | null>(null);

  /* 写入持久化 — 每次 collapse state 变化都同步到 localStorage.
   *   初始值已在 useState lazy initializer 里从 localStorage 读取, 无需再 useEffect sync. */
  useEffect(() => {
    savePersistedGroups({ changes: changesCollapsed, untracked: untrackedCollapsed });
  }, [changesCollapsed, untrackedCollapsed]);
  useEffect(() => {
    savePersistedBuckets(bucketCollapsed);
  }, [bucketCollapsed]);

  // ── git status: 共享的增量模型 (gitStateStore) ──
  const gitState = useGitState(workspacePath || undefined);
  const status: GitStatusResult | null = gitState.status;
  const loading = !!workspacePath && !gitState.loaded;
  /** 做完 git 操作后调: 主进程强制重算, 结果经推送回到 gitState */
  const refresh = useCallback(async () => {
    if (workspacePath) await refreshGitState(workspacePath);
  }, [workspacePath]);

  // 首次拿到状态时全选所有 tracked changes
  const initRef = useRef(false);
  useEffect(() => { initRef.current = false; }, [workspacePath]);
  useEffect(() => {
    if (initRef.current || !status || status.files.length === 0) return;
    initRef.current = true;
    const tracked = status.files.filter((f) => f.area !== 'untracked').map((f) => f.path);
    if (tracked.length > 0) setCheckedFiles(new Set(tracked));
  }, [status]);

  // ── 分组 ──
  const conflicts = useMemo(() => status?.files.filter((f) => f.area === 'conflict') || [], [status]);
  const changes = useMemo(() => status?.files.filter((f) => f.area !== 'untracked' && f.area !== 'conflict') || [], [status]);
  const untracked = useMemo(() => status?.files.filter((f) => f.area === 'untracked') || [], [status]);
  const totalChanges = conflicts.length + changes.length + untracked.length;

  // ── Checkbox toggle ──
  const toggleFile = (path: string) => {
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const toggleGroupAll = (files: GitFileStatus[]) => {
    const paths = files.map((f) => f.path);
    const allChecked = paths.every((p) => checkedFiles.has(p));
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (allChecked) next.delete(p); else next.add(p);
      }
      return next;
    });
  };

  // ── Commit (& optionally push) ──
  /** 内部主流程 — stage + commit. opts.thenPush=true 时成功后接 git push. */
  const doCommit = async (opts: { thenPush?: boolean } = {}): Promise<void> => {
    if (!commitMsg.trim()) {
      onToast(isZh ? '请输入提交消息' : 'Please enter a commit message', 'warning');
      textareaRef.current?.focus();
      return;
    }
    const filesToCommit = [...checkedFiles];
    if (filesToCommit.length === 0) {
      onToast(isZh ? '没有选中任何文件' : 'No files selected', 'warning');
      return;
    }
    setCommitting(true);
    try {
      await (window as any).neox.gitStage(workspacePath, filesToCommit);
      const result = await (window as any).neox.gitCommit(workspacePath, commitMsg.trim(), amend);
      const shortHash = (result?.hash ?? '').slice(0, 7);
      setCommitMsg('');
      setAmend(false);
      setCheckedFiles(new Set());
      await refresh();

      if (!opts.thenPush) {
        onToast(isZh ? `已提交: ${shortHash}` : `Committed: ${shortHash}`, 'success');
        return;
      }

      /* 推送阶段 — 即便失败也保留 commit, 不要回滚. 给用户明确错码 + 后续动作. */
      const pushRes = await (window as any).neox.gitPush(workspacePath);
      if (pushRes?.ok) {
        onToast(isZh ? `已提交并推送: ${shortHash}` : `Committed & pushed: ${shortHash}`, 'success');
        return;
      }
      const code = pushRes?.code;
      let hint = '';
      if (code === 'NO_REMOTE') {
        hint = isZh
          ? '没有远端仓库 — 可在终端 git remote add origin <url> 后重试'
          : 'No remote repository — run git remote add origin <url> in a terminal, then retry';
      }
      else if (code === 'NO_UPSTREAM') {
        /* 没 upstream 时直接尝试 set-upstream + 当前分支再推一次, 用户最常见的场景. */
        try {
          const branch = await (window as any).neox.gitCurrentBranch?.(workspacePath);
          if (branch) {
            const retry = await (window as any).neox.gitPush(workspacePath, { remote: 'origin', branch, setUpstream: true });
            if (retry?.ok) {
              onToast(
                isZh
                  ? `已提交并推送 (设置上游 origin/${branch}): ${shortHash}`
                  : `Committed & pushed (set upstream origin/${branch}): ${shortHash}`,
                'success',
              );
              return;
            }
          }
        } catch { /* 落到通用错误提示 */ }
        hint = isZh
          ? '当前分支没有上游, 已尝试 --set-upstream origin 但仍失败'
          : 'Current branch has no upstream; tried --set-upstream origin but it still failed';
      }
      else if (code === 'AUTH_FAILED') hint = isZh ? '推送凭证错 — 检查 SSH key / token 是否正确' : 'Push auth failed — check your SSH key / token';
      else if (code === 'NON_FAST_FORWARD') hint = isZh ? '远端有新提交需先 pull / rebase' : 'Remote has new commits — pull / rebase first';
      else if (code === 'NETWORK') hint = isZh ? '网络不通 — 检查代理或网络' : 'Network unreachable — check proxy or connection';

      const msg = pushRes?.error ?? (isZh ? '推送失败' : 'push failed');
      onToast(
        isZh
          ? `已提交 ${shortHash}, 推送失败: ${hint || msg}`
          : `Committed ${shortHash}, but push failed: ${hint || msg}`,
        'error',
      );
    } catch (err: any) {
      onToast(isZh ? `提交失败: ${friendlyOpError(err)}` : `Commit failed: ${friendlyOpError(err)}`, 'error');
    } finally {
      setCommitting(false);
    }
  };

  /** 旧名 handleCommit 留作单击按钮的回调, 直接走 doCommit() 不带 push. */
  const handleCommit = () => doCommit();
  const handleCommitAndPush = () => doCommit({ thenPush: true });


  // ── AI generate commit message ──
  const handleGenerateMsg = useCallback(async () => {
    if (!workspacePath) return;
    const neox = (window as any).neox;
    if (!neox?.gitGenerateCommitMsg) {
      onToast(isZh ? 'AI 生成功能不可用' : 'AI generation is unavailable', 'error');
      return;
    }

    setGenerating(true);
    setCommitMsg('');

    // Set up streaming listeners
    const removeChunk = neox.onGitCommitMsgChunk?.((chunk: string) => {
      setCommitMsg((prev) => prev + chunk);
    });
    const removeDone = neox.onGitCommitMsgDone?.(() => {
      setGenerating(false);
      textareaRef.current?.focus();
      removeChunk?.();
      removeDone?.();
      removeError?.();
    });
    // eslint-disable-next-line prefer-const
    let removeError: (() => void) | undefined;
    removeError = neox.onGitCommitMsgError?.((err: string) => {
      setGenerating(false);
      onToast(isZh ? `生成失败: ${err}` : `Generation failed: ${err}`, 'error');
      removeChunk?.();
      removeDone?.();
      removeError?.();
    });

    try {
      await neox.gitGenerateCommitMsg(workspacePath, [...checkedFiles]);
    } catch (err: any) {
      setGenerating(false);
      onToast(isZh ? `生成失败: ${friendlyOpError(err)}` : `Generation failed: ${friendlyOpError(err)}`, 'error');
      removeChunk?.();
      removeDone?.();
      removeError?.();
    }
  }, [checkedFiles, workspacePath, onToast, isZh]);

  // ── 路径解析 ──

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleCommit();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault();
      if (generating || checkedCount === 0) return;
      void handleGenerateMsg();
    }
  };
  const absPathOf = useCallback((relPath: string): string => {
    if (!workspacePath) return relPath;
    return `${workspacePath.replace(/\/$/, '')}/${relPath}`;
  }, [workspacePath]);

  // ── File click → 右侧面板打开 ──
  const openFile = (relPath: string) => {
    const abs = absPathOf(relPath);
    if (onPreviewSurface) onPreviewSurface(abs);
    else onOpenFile(abs);
  };
  const handleFileClick = (file: GitFileStatus) => openFile(file.path);

  // ── 单文件 git actions ──
  const handleStageOne = useCallback(async (file: GitFileStatus) => {
    try {
      await (window as any).neox.gitStage(workspacePath, [file.path]);
      await refresh();
    } catch (e: any) { onToast(isZh ? `暂存失败: ${friendlyOpError(e)}` : `Stage failed: ${friendlyOpError(e)}`, 'error'); }
  }, [workspacePath, refresh, onToast, isZh]);

  const handleUnstageOne = useCallback(async (file: GitFileStatus) => {
    try {
      await (window as any).neox.gitUnstage(workspacePath, [file.path]);
      await refresh();
    } catch (e: any) { onToast(isZh ? `取消暂存失败: ${friendlyOpError(e)}` : `Unstage failed: ${friendlyOpError(e)}`, 'error'); }
  }, [workspacePath, refresh, onToast, isZh]);

  const handleDiscardOne = useCallback(async (file: GitFileStatus) => {
    const ok = await confirmAsync({
      title: isZh ? '还原文件' : 'Revert file',
      message: isZh ? `还原 "${file.path}" 到 HEAD?` : `Revert "${file.path}" to HEAD?`,
      description: isZh ? '该文件的未提交改动将丢失.' : 'Uncommitted changes to this file will be lost.',
      variant: 'danger',
      confirmLabel: isZh ? '还原' : 'Revert',
    });
    if (!ok) return;
    try {
      await (window as any).neox.gitDiscardFile(workspacePath, file.path, 'tracked');
      onToast(isZh ? `已还原 ${file.path}` : `Reverted ${file.path}`, 'success');
      await refresh();
    } catch (e: any) { onToast(isZh ? `还原失败: ${friendlyOpError(e)}` : `Revert failed: ${friendlyOpError(e)}`, 'error'); }
  }, [workspacePath, refresh, onToast, isZh]);

  const handleDeleteOne = useCallback(async (file: GitFileStatus) => {
    const ok = await confirmAsync({
      title: isZh ? '删除文件' : 'Delete file',
      message: isZh ? `删除 "${file.path}"?` : `Delete "${file.path}"?`,
      description: isZh ? '物理删除该文件 (untracked).' : 'Permanently delete this untracked file.',
      variant: 'danger',
      confirmLabel: isZh ? '删除' : 'Delete',
    });
    if (!ok) return;
    try {
      await (window as any).neox.gitDiscardFile(workspacePath, file.path, 'untracked');
      onToast(isZh ? `已删除 ${file.path}` : `Deleted ${file.path}`, 'success');
      await refresh();
    } catch (e: any) { onToast(isZh ? `删除失败: ${friendlyOpError(e)}` : `Delete failed: ${friendlyOpError(e)}`, 'error'); }
  }, [workspacePath, refresh, onToast, isZh]);

  const handleAddToGitignoreOne = useCallback(async (file: GitFileStatus) => {
    try {
      const result = await (window as any).neox.gitAppendGitignore(workspacePath, [file.path]);
      if (result.added.length > 0) {
        onToast(isZh ? `已加入 .gitignore: ${result.added[0]}` : `Added to .gitignore: ${result.added[0]}`, 'success');
      } else {
        onToast(isZh ? '.gitignore 已包含该规则' : '.gitignore already contains this rule', 'info');
      }
      await refresh();
    } catch (e: any) { onToast(isZh ? `加入 .gitignore 失败: ${friendlyOpError(e)}` : `Failed to update .gitignore: ${friendlyOpError(e)}`, 'error'); }
  }, [workspacePath, refresh, onToast, isZh]);

  const handleAddBucketToGitignore = useCallback(async (patterns: string[]) => {
    if (patterns.length === 0) return;
    try {
      const result = await (window as any).neox.gitAppendGitignore(workspacePath, patterns);
      const n = result.added.length;
      onToast(
        n > 0
          ? (isZh ? `已加入 ${n} 条 .gitignore 规则` : `Added ${n} .gitignore rule${n > 1 ? 's' : ''}`)
          : (isZh ? '规则已存在, 未变更' : 'Rules already exist, nothing changed'),
        n > 0 ? 'success' : 'info',
      );
      await refresh();
    } catch (e: any) { onToast(isZh ? `加入 .gitignore 失败: ${friendlyOpError(e)}` : `Failed to update .gitignore: ${friendlyOpError(e)}`, 'error'); }
  }, [workspacePath, refresh, onToast, isZh]);

  const handleViewDiff = useCallback((file: GitFileStatus) => {
    const abs = absPathOf(file.path);
    if (onViewDiff) {
      onViewDiff(abs);
    } else {
      onToast(isZh ? 'diff 预览暂未接入, 请用编辑器查看' : 'Diff preview is not wired up yet — opening in the editor', 'info');
      onOpenFile(abs);
    }
  }, [absPathOf, onViewDiff, onOpenFile, onToast, isZh]);

  const handleCopyPath = useCallback((file: GitFileStatus, relative: boolean) => {
    const text = relative ? file.path : absPathOf(file.path);
    void navigator.clipboard.writeText(text).then(
      () => onToast(
        isZh
          ? `已复制${relative ? '相对' : ''}路径`
          : `Copied ${relative ? 'relative ' : ''}path`,
        'success',
      ),
      () => onToast(isZh ? '复制失败' : 'Copy failed', 'error'),
    );
  }, [absPathOf, onToast, isZh]);

  // ── Render file row (IDEA style) ──
  const renderFileRow = (file: GitFileStatus) => {
    const checked = checkedFiles.has(file.path);
    const name = fileName(file.path);
    const dir = dirName(file.path);
    const color = fileColor(file);

    return (
      <div
        key={`${file.area}-${file.path}`}
        className="cp-file-row"
        onClick={() => handleFileClick(file)}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ file, anchor: { x: e.clientX, y: e.clientY } });
        }}
      >
        <input
          type="checkbox"
          className="cp-checkbox"
          checked={checked}
          onChange={(e) => { e.stopPropagation(); toggleFile(file.path); }}
          onClick={(e) => e.stopPropagation()}
        />
        {/* 真 brand logo SVG (simple-icons), 没识别就 generic 文件图标占位 — 列严格对齐 */}
        <FileTypeIcon path={file.path} size={14} className="cp-file-type-icon" />
        <span className="cp-file-name" style={{ color }}>{name}</span>
        {dir && <span className="cp-file-dir">{dir}</span>}
      </div>
    );
  };

  // ── 智能分组 untracked ──
  const untrackedBuckets: Bucket<GitFileStatus>[] = useMemo(
    () => classifyUntracked(untracked),
    [untracked],
  );

  /* 初始化 bucket 折叠状态 — 每个 bucket 第一次见时按 defaultCollapsed 设, 之后随用户操作 */
  useEffect(() => {
    setBucketCollapsed((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const b of untrackedBuckets) {
        if (!(b.key in next)) {
          next[b.key] = b.defaultCollapsed;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [untrackedBuckets]);

  // ── Loading / not git ──
  if (loading && !status) {
    return (
      <div className="commit-panel">
        <div className="cp-header"><span className="cp-header-title">{isZh ? '提交' : 'Commit'}</span></div>
        <div className="commit-panel-loading"><Icons.Loader /><span className="neox-text-shimmer">{isZh ? '加载中...' : 'Loading...'}</span></div>
      </div>
    );
  }
  if (status === null) {
    return (
      <div className="commit-panel">
        <div className="cp-header"><span className="cp-header-title">{isZh ? '提交' : 'Commit'}</span></div>
        <div className="commit-panel-empty"><Icons.GitBranch /><span>{gitState.error
          ? (isZh ? `读取 Git 状态失败: ${gitState.error}` : `Failed to read git status: ${gitState.error}`)
          : (isZh ? '不是 Git 仓库' : 'Not a git repository')}</span></div>
      </div>
    );
  }

  const changesAllChecked = changes.length > 0 && changes.every((f) => checkedFiles.has(f.path));
  const changesSomeChecked = changes.some((f) => checkedFiles.has(f.path));
  const untrackedAllChecked = untracked.length > 0 && untracked.every((f) => checkedFiles.has(f.path));
  const untrackedSomeChecked = untracked.some((f) => checkedFiles.has(f.path));

  const checkedCount = checkedFiles.size;

  const commitBlockedReason: string | null = committing
    ? (isZh ? '正在提交…' : 'Committing…')
    : checkedCount === 0
      ? (isZh ? '先勾选要提交的文件' : 'Select the files to commit first')
      : !commitMsg.trim()
        ? (isZh ? '先写一句提交消息 (可以点「生成消息」让 AI 写)' : 'Write a commit message first (or hit Generate)')
        : null;


  return (
    <div className="commit-panel">
      {/* ═══════════════ 1. 标题栏 ═══════════════ */}
      <div className="cp-header">
        <span className="cp-header-title">{isZh ? '提交' : 'Commit'}</span>
        <div className="cp-header-actions">
          <button className="cp-icon-btn" title={isZh ? '搁置更改 (Stash)' : 'Stash changes'} onClick={async () => {
            try {
              await (window as any).neox.gitStash(workspacePath, `stash ${new Date().toLocaleString()}`);
              onToast(isZh ? '搁置成功' : 'Changes stashed', 'success'); refresh();
            } catch (e: any) { onToast(isZh ? `搁置失败: ${friendlyOpError(e)}` : `Stash failed: ${friendlyOpError(e)}`, 'error'); }
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
          </button>
          <button className="cp-icon-btn" title={isZh ? '弹出搁置 (Stash Pop)' : 'Pop stash'} onClick={async () => {
            try {
              await (window as any).neox.gitStashPop(workspacePath);
              onToast(isZh ? '已恢复搁置的更改' : 'Stashed changes restored', 'success'); refresh();
            } catch (e: any) { onToast(isZh ? `恢复失败: ${friendlyOpError(e)}` : `Restore failed: ${friendlyOpError(e)}`, 'error'); }
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </button>
          <button className="cp-icon-btn" onClick={refresh} title={isZh ? '刷新' : 'Refresh'}><Icons.Refresh /></button>
        </div>
      </div>

      {/* ═══════════════ 2. 文件树（flex: 1 占满空间）═══════════════ */}
      <div className="cp-file-tree">
        <GitStatusLimitNote truncated={status.truncated} untrackedMode={status.untrackedMode} />
        {/* ── 合并冲突 (置顶, 警告色; 解决后 stage 标记已解决才能完成合并) ── */}
        {conflicts.length > 0 && (
          <div className="cp-group cp-group--conflict">
            <div className="cp-group-header">
              <span className="cp-conflict-icon" aria-hidden="true">⚠</span>
              <span className="cp-group-label">{isZh ? '合并冲突' : 'Merge conflicts'}</span>
              <span className="cp-group-count">
                {isZh ? `${conflicts.length} 个文件 · 需解决` : `${conflicts.length} file${conflicts.length > 1 ? 's' : ''} · needs resolution`}
              </span>
            </div>
            <div className="cp-group-files">
              <CappedRows items={conflicts} render={renderFileRow} />
            </div>
          </div>
        )}

        {/* ── 更改 N 个文件 ── */}
        {changes.length > 0 && (
          <div className="cp-group">
            <div
              className="cp-group-header"
              onClick={() => setChangesCollapsed(!changesCollapsed)}
            >
              <span className={`cp-chevron ${changesCollapsed ? 'collapsed' : ''}`}>
                <Icons.ChevronDown />
              </span>
              <input
                type="checkbox"
                className="cp-checkbox"
                checked={changesAllChecked}
                ref={(el) => { if (el) el.indeterminate = changesSomeChecked && !changesAllChecked; }}
                onChange={(e) => { e.stopPropagation(); toggleGroupAll(changes); }}
                onClick={(e) => e.stopPropagation()}
              />
              <span className="cp-group-label">{isZh ? '改动' : 'Changes'}</span>
              <span className="cp-group-count">{isZh ? `${changes.length} 个文件` : `${changes.length} file${changes.length > 1 ? 's' : ''}`}</span>
            </div>
            {!changesCollapsed && (
              <div className="cp-group-files">
                <CappedRows items={changes} render={renderFileRow} />
              </div>
            )}
          </div>
        )}

        {/* ── 未进行版本管理的文件 (智能分组: deps/build/tmp/ide/byDir/loose) ── */}
        {untracked.length > 0 && (
          <div className="cp-group">
            <div
              className="cp-group-header"
              onClick={() => setUntrackedCollapsed(!untrackedCollapsed)}
            >
              <span className={`cp-chevron ${untrackedCollapsed ? 'collapsed' : ''}`}>
                <Icons.ChevronDown />
              </span>
              <input
                type="checkbox"
                className="cp-checkbox"
                checked={untrackedAllChecked}
                ref={(el) => { if (el) el.indeterminate = untrackedSomeChecked && !untrackedAllChecked; }}
                onChange={(e) => { e.stopPropagation(); toggleGroupAll(untracked); }}
                onClick={(e) => e.stopPropagation()}
              />
              <span className="cp-group-label">{isZh ? '未进行版本管理的文件' : 'Unversioned files'}</span>
              <span className="cp-group-count">{isZh ? `${untracked.length} 个文件` : `${untracked.length} file${untracked.length > 1 ? 's' : ''}`}</span>
            </div>
            {!untrackedCollapsed && (
              <div className="cp-untracked-buckets">
                {untrackedBuckets.map((bucket) => {
                  const collapsed = bucketCollapsed[bucket.key] ?? bucket.defaultCollapsed;
                  const canSuggestIgnore = bucket.suggestedPatterns.length > 0;
                  return (
                    <div key={bucket.key} className={`cp-bucket cp-bucket--${bucket.key}`}>
                      <div
                        className="cp-bucket__header"
                        onClick={() => setBucketCollapsed((p) => ({ ...p, [bucket.key]: !collapsed }))}
                      >
                        <span className={`cp-chevron ${collapsed ? 'collapsed' : ''}`}>
                          <Icons.ChevronDown />
                        </span>
                        <span className="cp-bucket__label">{isZh ? bucket.label : BUCKET_LABEL_EN[bucket.key].label}</span>
                        <span className="cp-bucket__count">{bucket.files.length}</span>
                        <span className="cp-bucket__desc">{isZh ? bucket.description : BUCKET_LABEL_EN[bucket.key].description}</span>
                        {canSuggestIgnore && (
                          <button
                            type="button"
                            className="cp-bucket__ignore-btn"
                            title={isZh
                              ? `将 ${bucket.suggestedPatterns.join(', ')} 加入 .gitignore`
                              : `Add ${bucket.suggestedPatterns.join(', ')} to .gitignore`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleAddBucketToGitignore(bucket.suggestedPatterns);
                            }}
                          >
                            + .gitignore
                          </button>
                        )}
                      </div>
                      {!collapsed && (
                        <div className="cp-group-files cp-bucket__files">
                          <CappedRows items={bucket.files} render={renderFileRow} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── 干净 ── */}
        {totalChanges === 0 && (
          <div className="commit-panel-empty">
            <Icons.Check />
            <span>{isZh ? '没有可提交的更改, 工作区干净' : 'Nothing to commit, working tree clean'}</span>
          </div>
        )}
      </div>

      {/* ═══════════════ 3. 底部固定区 ═══════════════ */}
      <div className="cp-bottom">
        {/* Amend */}
        <label className="cp-amend-row">
          <input
            type="checkbox"
            className="cp-checkbox"
            checked={amend}
            onChange={() => setAmend(!amend)}
          />
          <span className="cp-amend-label">{isZh ? '修正(M)' : 'Amend'}</span>
        </label>

        {/* 提交消息 */}
        <div className="cp-message-label-row">
          <span className="cp-message-label">{isZh ? '提交消息' : 'Commit message'}</span>
          <button
            className={`cp-ai-gen-btn${generating ? ' generating' : ''}`}
            title={checkedCount === 0
              ? (isZh ? '先勾选要提交的文件 —— 生成消息要读这些改动' : 'Select the files to commit first — the message is generated from those changes')
              : (isZh ? 'AI 生成提交消息 (⌘G)' : 'Generate commit message with AI (⌘G)')}
            disabled={generating || checkedCount === 0}
            onClick={handleGenerateMsg}
          >
            {generating ? (
              <><span className="cp-ai-spin"><Icons.Loader /></span><span>{isZh ? '生成中…' : 'Generating…'}</span></>
            ) : (
              <><span className="cp-ai-sparkle">✦</span><span>{isZh ? '生成消息' : 'Generate'}</span></>
            )}
          </button>
        </div>
        <textarea
          ref={textareaRef}
          className={`cp-message-input${generating ? ' generating' : ''}`}
          placeholder={generating ? '' : (isZh ? '提交消息' : 'Commit message')}
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={handleKeyDown}
        />

        <div className="cp-button-row">
          <button
            className="cp-commit-btn primary"
            disabled={commitBlockedReason !== null}
            title={commitBlockedReason ?? undefined}
            onClick={handleCommit}
          >
            {isZh ? `提交(${checkedCount})` : `Commit (${checkedCount})`}
          </button>
          <button
            className="cp-commit-btn"
            disabled={commitBlockedReason !== null}
            title={commitBlockedReason ?? undefined}
            onClick={handleCommitAndPush}
          >
            {isZh ? '提交并推送(P)' : 'Commit & Push'}
          </button>
        </div>
      </div>

      {/* 右键菜单 — portal 渲染避免被 panel overflow clip */}
      {contextMenu && (
        <FileRowContextMenu
          anchor={contextMenu.anchor}
          filePath={contextMenu.file.path}
          area={contextMenu.file.area as FileArea}
          onClose={() => setContextMenu(null)}
          onOpen={() => openFile(contextMenu.file.path)}
          onViewDiff={() => handleViewDiff(contextMenu.file)}
          onStage={() => void handleStageOne(contextMenu.file)}
          onUnstage={() => void handleUnstageOne(contextMenu.file)}
          onDiscard={() => void handleDiscardOne(contextMenu.file)}
          onDelete={() => void handleDeleteOne(contextMenu.file)}
          onAddToGitignore={() => void handleAddToGitignoreOne(contextMenu.file)}
          onCopyPath={() => handleCopyPath(contextMenu.file, false)}
          onCopyRelativePath={() => handleCopyPath(contextMenu.file, true)}
        />
      )}
    </div>
  );
};

export default CommitPanel;
