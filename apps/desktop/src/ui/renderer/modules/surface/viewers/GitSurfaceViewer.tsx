import React, { useCallback, useEffect, useState } from 'react';
import { GitCard } from '../../ide-workspace/GitCard';
import { openSurfaceFromPath } from '../../../state/openSurfaceFromPath';
import { useI18n } from '../../../hooks/useI18n';
import { EmptyState } from '../../../components/settings-base/EmptyState';
import { NeoxIllus } from '../../../media/illus';
import type { Surface } from '../../../state/surfaceStore';

function parseUnifiedDiffToChangedLines(unified: string): Array<{ start: number; end: number; kind: 'add' | 'del' | 'modify' }> {
  const out: Array<{ start: number; end: number; kind: 'add' | 'del' | 'modify' }> = [];
  if (!unified.trim()) return out;
  let newLine = 0;
  let pendingDel = 0;
  let run: { start: number; end: number; kind: 'add' | 'modify' } | null = null;
  const flush = () => { if (run) { out.push(run); run = null; } };

  for (const raw of unified.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { flush(); pendingDel = 0; newLine = Number(hunk[1]); continue; }
    if (newLine === 0) continue;                        /* 还在 ---/+++ 文件头 */
    if (raw.startsWith('---') || raw.startsWith('+++')) continue;
    if (raw.startsWith('\\')) continue;                  /* "\ No newline at end of file" */

    if (raw.startsWith('-')) {
      pendingDel += 1;                                  /* 不占新文件的行, 不推进 newLine */
      continue;
    }
    if (raw.startsWith('+')) {
      const kind: 'add' | 'modify' = pendingDel > 0 ? 'modify' : 'add';
      if (pendingDel > 0) pendingDel -= 1;
      if (run && run.kind === kind && run.end === newLine - 1) run.end = newLine;
      else { flush(); run = { start: newLine, end: newLine, kind }; }
      newLine += 1;
      continue;
    }
    /* 上下文行 —— 结束当前连续段, 剩余的纯删除丢弃 (新文件里无处可标) */
    flush();
    pendingDel = 0;
    newLine += 1;
  }
  flush();
  return out;
}

interface Props {
  surface: Surface;
  workspacePath?: string;
  sessionId: string;
}

export const GitSurfaceViewer: React.FC<Props> = ({ workspacePath, sessionId }) => {
  const { isZh } = useI18n();
  const [gitRoot, setGitRoot] = useState(workspacePath ?? '');

  useEffect(() => {
    if (!workspacePath) { setGitRoot(''); return; }
    let cancelled = false;
    void (async () => {
      try {
        const s = await (window as any)?.neox?.gitStatus?.(workspacePath);
        if (!cancelled && s?.root) setGitRoot(s.root);
        else if (!cancelled) setGitRoot(workspacePath);
      } catch {
        if (!cancelled) setGitRoot(workspacePath);
      }
    })();
    return () => { cancelled = true; };
  }, [workspacePath]);

  /* porcelain 路径相对 git root (可能高于 workspacePath) */
  const abs = useCallback(
    (p: string) => {
      if (!p) return gitRoot || workspacePath || '';
      if (p.startsWith('/')) return p;
      const base = (gitRoot || workspacePath || '').replace(/\/+$/, '');
      return base ? `${base}/${p}` : p;
    },
    [gitRoot, workspacePath],
  );

  const handleOpenFile = useCallback((path: string) => {
    if (!sessionId) return;
    openSurfaceFromPath({ sessionId, path: abs(path), workspacePath });
  }, [sessionId, workspacePath, abs]);

  const handleOpenDiff = useCallback(async (path: string, original: string, modified: string, staged?: boolean) => {
    if (!sessionId) return;
    const filePath = abs(path);
    const hasPair = typeof original === 'string' && typeof modified === 'string'
      && (original.length > 0 || modified.length > 0);

    if (hasPair) {
      openSurfaceFromPath({
        sessionId,
        path: filePath,
        workspacePath,
        preferKind: 'code',
        /* 快照正文 — History 不能读工作区脏文件顶掉 commit 内容 */
        fallbackContent: modified,
        /* 改前全文 — 源码/单窗上下 diff 用 (红删区 + 绿增) */
        diffOriginal: original,
        /* 窄栏左右放不下, 默认上下比对 (源码/单窗同一套) */
        defaultDiffViewMode: 'preview',
      });
      return;
    }

    let unified = '';
    try {
      const r = await (window as any)?.neox?.gitDiffFile?.(workspacePath, path, !!staged);
      unified = typeof r === 'string' ? r : String(r?.diff ?? r?.stdout ?? '');
    } catch { /* 解析不出就当没有改动标记, 仍然打开文件 */ }

    openSurfaceFromPath({
      sessionId,
      path: filePath,
      workspacePath,
      preferKind: 'code',
      changedLines: parseUnifiedDiffToChangedLines(unified),
      defaultDiffViewMode: 'preview',
    });
  }, [sessionId, workspacePath, abs]);

  if (!workspacePath) {
    return (
      <EmptyState
        className="gc__empty-state"
        icon={null}
        art={NeoxIllus.git}
        title={isZh ? '还没有项目' : 'No project yet'}
        desc={isZh ? 'Git 要先有一个项目目录才能看改动' : 'Git needs a project folder before it can show changes'}
        actions={(
          <button
            type="button"
            className="nx-btn nx-btn--sm nx-btn--primary"
            /* 用现成的事件把侧栏切成工作区面板, 让用户在那儿选 —— 不在这里自己拼一套
             * openFolderDialog + setWorkspace。切项目牵动 sessions / recent 列表 /
             * 模式绑定好几处, AppShell 那条流程做的事比"选个目录"多得多, 复制一份
             * 迟早跟它漂开。 */
            onClick={() => window.dispatchEvent(new CustomEvent('neox:ide:open-workspace-hub'))}
          >
            {isZh ? '选择项目' : 'Choose project'}
          </button>
        )}
      />
    );
  }

  return (
    <div className="sfc-git">
      <GitCard
        workspacePath={workspacePath}
        onOpenFile={handleOpenFile}
        onOpenDiff={handleOpenDiff}
      />
    </div>
  );
};

export default GitSurfaceViewer;
