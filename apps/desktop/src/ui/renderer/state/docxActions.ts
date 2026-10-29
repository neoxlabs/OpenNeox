/**
 * docxActions — Word (.docx) surface 的 UI 动作 (Home / 打开).
 *
 *   Phase 1 viewer 是只读 (mammoth → HTML), 不带新建 — 用户要新建 word 走 agent
 *   工具 (word pack 解锁 → word_create). 现阶段 home 只一个"打开"CTA.
 */

import { openSurfaceFromPath } from './openSurfaceFromPath';
import { ingestSurfaceEvent } from './surfaceStore';

/** "打开 Word" — OS 文件选择器 (filter .docx/.doc) → ingest 到 docx host. */
export async function openExistingDocx(opts: { sessionId: string; workspacePath?: string }): Promise<boolean> {
  const { sessionId, workspacePath } = opts;
  if (!sessionId) return false;
  const api = (window as any).neox;
  if (!api?.openFileDialog) return false;
  const picked = await api.openFileDialog({
    defaultPath: workspacePath,
    filters: [
      { name: 'Word Document', extensions: ['docx', 'doc'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (!picked) return false;
  openSurfaceFromPath({ sessionId, path: picked, workspacePath });
  return true;
}

/** 进入 Word 专题 home 引导页 (空 tabs host). */
export function openDocxHome(opts: { sessionId: string }): void {
  const { sessionId } = opts;
  if (!sessionId) return;
  ingestSurfaceEvent(sessionId, {
    action: 'open',
    surface: {
      id: `sfc-docx-home-${Date.now()}`,
      kind: 'docx',
      source: { type: 'inline', content: '' },
      title: 'Word',
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: { isHome: true },
    },
  }, { reveal: true });
}
