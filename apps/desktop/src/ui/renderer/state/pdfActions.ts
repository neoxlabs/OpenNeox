/**
 * pdfActions — PDF surface 的 UI 动作 (Home / 打开).
 *
 *   PDF 没"新建"刚需 (pdf 是输出格式不是创作格式), home 里只一个"打开"CTA + 拖入提示.
 *   将来如果加 "agent 把 word/markdown 转 pdf" 之类的可以扩 createPdf, 现阶段不做.
 */

import { openSurfaceFromPath } from './openSurfaceFromPath';
import { ingestSurfaceEvent } from './surfaceStore';

/** "打开 PDF" — OS 文件选择器 (filter .pdf) → 走 openSurfaceFromPath → ingest 到 pdf host. */
export async function openExistingPdf(opts: { sessionId: string; workspacePath?: string }): Promise<boolean> {
  const { sessionId, workspacePath } = opts;
  if (!sessionId) return false;
  const api = (window as any).neox;
  if (!api?.openFileDialog) return false;
  const picked = await api.openFileDialog({
    defaultPath: workspacePath,
    filters: [
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (!picked) return false;
  openSurfaceFromPath({ sessionId, path: picked, workspacePath });
  return true;
}

/** 进入 PDF 专题 home 引导页 (空 tabs host). */
export function openPdfHome(opts: { sessionId: string }): void {
  const { sessionId } = opts;
  if (!sessionId) return;
  ingestSurfaceEvent(sessionId, {
    action: 'open',
    surface: {
      id: `sfc-pdf-home-${Date.now()}`,
      kind: 'pdf',
      source: { type: 'inline', content: '' },
      title: 'PDF',
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: { isHome: true },
    },
  }, { reveal: true });
}
