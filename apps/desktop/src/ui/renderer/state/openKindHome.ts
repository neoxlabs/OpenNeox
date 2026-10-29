
import { ingestSurfaceEvent, type SurfaceKind } from './surfaceStore';

/* kind → 默认标题 (home placeholder 的 surface.title) */
const KIND_TITLE: Partial<Record<SurfaceKind, string>> = {
  code: '源代码',
  web: '浏览器',
  plan: '方案',
  todo: '清单',
};

export function openKindHome(opts: { sessionId: string; kind: SurfaceKind; title?: string }): void {
  const { sessionId, kind } = opts;
  if (!sessionId) return;
  const title = opts.title ?? KIND_TITLE[kind] ?? kind;
  ingestSurfaceEvent(sessionId, {
    action: 'open',
    surface: {
      id: `sfc-${kind}-home-${Date.now()}`,
      kind,
      source: { type: 'inline', content: '' },
      title,
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      /* isHome 让 SurfacePanel 在 renderViewer 中拦截渲染统一 home 引导页 */
      metadata: { isHome: true },
    },
  }, { reveal: true });
}
