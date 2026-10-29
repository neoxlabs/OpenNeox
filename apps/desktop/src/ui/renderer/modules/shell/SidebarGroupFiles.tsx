import React, { useCallback, useState } from 'react';
import FileExplorer from '../explorer/components/FileExplorer';
import { useNeoxRuntime } from '../../app/NeoxRuntimeContext';
import { openSurfaceFromPath } from '../../state/openSurfaceFromPath';
import { ensureSurfaceVisible } from '../../state/panelLayoutStore';
import { dispatchHint } from '../../components/notifyEvents';

export const SidebarGroupFiles: React.FC<{ path: string; zh: boolean }> = ({ path, zh }) => {
  const runtime = useNeoxRuntime();
  const [selected, setSelected] = useState<string | null>(null);

  const openFile = useCallback((p: string) => {
    const ok = openSurfaceFromPath({
      sessionId: runtime.activeSession?.id || runtime.workspacePath || '__agent__',
      path: p,
      workspacePath: path,
    });
    if (ok) { ensureSurfaceVisible(); return; }
    dispatchHint(zh ? '这个文件类型不能预览, 已在文件管理器中定位' : 'Cannot preview this file type; revealing it instead', 'info');
    try { void (window as any).neox?.fsRevealInFinder?.(p); } catch { /* 老宿主没有这个 IPC */ }
  }, [runtime.activeSession?.id, runtime.workspacePath, path, zh]);

  return (
    <div className="neox-group-files" onClick={(e) => e.stopPropagation()}>
      {/* 点的不是当前项目时会先静默切过去; 切换落地前读目录会被拒 (只放行已打开的工作区),
          树就空着不再重读 —— 以当前工作区为 key, 切换完成后重挂一次 */}
      <FileExplorer
        key={runtime.workspacePath || ''}
        workspacePath={path}
        selectedFile={selected}
        onSelectFile={(p) => setSelected(p || null)}
        onOpenFile={openFile}
        hideHeader
        respondsToGlobalActions={false}
      />
    </div>
  );
};

export default SidebarGroupFiles;
