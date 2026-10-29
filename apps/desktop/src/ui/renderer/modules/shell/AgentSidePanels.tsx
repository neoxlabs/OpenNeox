import React, { useCallback } from 'react';
import CommitPanel from '../vcs/components/CommitPanel';
import { VcsPanelProvider } from '../../state/vcsContext';
import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';
import { openSurfaceFromPath } from '../../state/openSurfaceFromPath';
import { ingestSurfaceEvent } from '../../state/surfaceStore';
import { friendlyOpError, dispatchPanelToast } from '../../components/notifyEvents';
import { useI18n } from '../../hooks/useI18n';

/* ============================================================
 * AgentSidePanels — rail 切换的侧栏面板
 *
 *   · AgentGitSidebar — 源代码管理 (复用真版 CommitPanel + VcsPanelProvider)
 *
 *   工具/编排两个占位 sidebar 已删 — 真接通 runtime.tools / Plan canvas 后再加.
 *   样式复用 .ide-side / .ide-side__head 一套, 视觉跟文件树侧栏一致.
 * ============================================================ */

/* AgentGitSidebar — 源代码管理 (rail 切到 git 时显示)
 *   · 复用 CommitPanel (IDEA 风格, 含 staged/unstaged 树 + AI commit msg)
 *   · 自己提供 VcsPanelProvider context — workspacePath 由父级注入
 *   · onToast / onOpenFile 走最薄的实现 (postMessage 给已有 toast 通道; 文件打开
 *     先用 dispatchEvent 让 workspace 接管) */
export interface AgentGitSidebarProps {
  workspacePath: string;
  /** 右侧面板开不了时的退路 — 缺省弹"没有活动会话"提示 */
  onOpenFile?: (path: string) => void;
  /** 简易 toast — 缺省走 'neox:toast' 自定义事件 */
  onToast?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

export const AgentGitSidebar: React.FC<AgentGitSidebarProps> = ({ workspacePath, onOpenFile, onToast }) => {
  const runtime = useNeoxRuntimeOptional();
  const { isZh } = useI18n();
  const sessionId = runtime?.activeSession?.id ?? '';

  /* 同上: 'neox:open-file' 也没有监听方。这条只有"没有 activeSession"时才会走到
   * (有会话时下面直接开 Surface), 与其静默什么都不发生, 不如说清楚为什么。 */
  const handleOpenFile = onOpenFile || ((path: string) => {
    dispatchPanelToast(
      isZh ? `当前没有活动会话，无法打开 ${path.split('/').pop() || path}` : `No active session — cannot open ${path.split('/').pop() || path}`,
      'warning',
    );
  });
  const handleToast = onToast || ((msg: string, type?: 'info' | 'success' | 'warning' | 'error') => {
    dispatchPanelToast(msg, type ?? 'info');
  });

  /* 点击文件 → 右栏 Surface 打开 (code kind).
   *   没 activeSession 时 fallback 到 onOpenFile. */
  const handlePreviewSurface = useCallback((absPath: string) => {
    if (!sessionId) {
      handleOpenFile(absPath);
      return;
    }
    const ok = openSurfaceFromPath({ sessionId, path: absPath, workspacePath });
    if (!ok) {
      /* 扩展名不支持 Surface 预览 (如 .lock / 二进制) → fallback */
      handleOpenFile(absPath);
    }
  }, [sessionId, workspacePath, handleOpenFile]);

  /* Agent 模式: 查看 diff → 走 diff surface (kind='diff'), 后端读 git diff 给字符串 */
  const handleViewDiff = useCallback(async (absPath: string) => {
    if (!sessionId) { handleToast(isZh ? '当前无活动会话, 无法预览 diff' : 'No active session — cannot preview diff', 'warning'); return; }
    const relPath = workspacePath && absPath.startsWith(workspacePath)
      ? absPath.slice(workspacePath.length).replace(/^\/+/, '')
      : absPath;
    try {
      /* 先尝试 unstaged diff, 没内容再要 staged. 双空就是没改动. */
      let diffText = await (window as any).neox.gitDiffFile(workspacePath, relPath, false);
      if (!diffText) {
        diffText = await (window as any).neox.gitDiffFile(workspacePath, relPath, true);
      }
      if (!diffText) { handleToast(isZh ? '该文件无 diff (或还没暂存)' : 'No diff for this file (or not staged yet)', 'info'); return; }
      const title = `diff: ${relPath.split('/').pop() || relPath}`;
      ingestSurfaceEvent(sessionId, {
        action: 'open',
        surface: {
          id: `sfc-diff-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
          kind: 'diff',
          source: { type: 'inline', content: diffText },
          title,
          pinned: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }, { reveal: true });
    } catch (e: any) {
      handleToast(isZh ? `读取 diff 失败: ${friendlyOpError(e)}` : `Failed to read diff: ${friendlyOpError(e)}`, 'error');
    }
  }, [sessionId, workspacePath, handleToast, isZh]);

  return (
    <aside className="neox-shell__sidebar ide-sidebar" aria-label={isZh ? '源代码管理' : 'Source control'}>
      <VcsPanelProvider value={{ workspacePath, onToast: handleToast, onOpenFile: handleOpenFile }}>
        <CommitPanel
          onPreviewSurface={handlePreviewSurface}
          onViewDiff={handleViewDiff}
        />
      </VcsPanelProvider>
    </aside>
  );
};

export default {
  AgentGitSidebar,
};
