
import { Presentation, renderDeckPreviewHtml } from '@neoxlabs/pptx-renderer';
import type { DeckPreviewSlide } from '@neoxlabs/pptx-renderer';
import { SURFACE_MARKER, type SurfaceMarkerPayload } from '../surface/surfaceTypes.js';

export interface DeckOutlineItem {
  title: string;
  /** 这一页打算用哪个组件 (flow / kpi / compare / cover ...) */
  component?: string;
}

export interface DeckSessionState {
  sessionId: string;
  /** 右侧 surface 的 id —— 全程复用同一个, 才叫"看着它长出来" */
  surfaceId: string;
  title: string;
  styleId: string;
  styleName: string;
  pres: Presentation;
  slides: DeckPreviewSlide[];
  createdAt: number;
  /** 预览 HTML 的落盘位置 —— surface 盯的就是这个文件 */
  previewPath: string;
  /** deck_export 的默认目标 (deck_begin 时就定好, 免得导出时再猜) */
  outputPath: string;
}

const sessions = new Map<string, DeckSessionState>();

/** 只在这里造 surfaceId, 保证同一 session 的所有 update 都打到同一个 tab */
function surfaceIdFor(sessionId: string): string {
  return `sfc-deck-${sessionId}`;
}

export function beginDeck(opts: {
  sessionId: string;
  title: string;
  styleId: string;
  styleName: string;
  outline: DeckOutlineItem[];
  slideSize?: { width: number; height: number };
  previewPath: string;
  outputPath: string;
}): DeckSessionState {
  const pres = Presentation.create({
    slideSize: opts.slideSize ?? { width: 1280, height: 720 },
  });
  const st: DeckSessionState = {
    sessionId: opts.sessionId,
    surfaceId: surfaceIdFor(opts.sessionId),
    title: opts.title,
    styleId: opts.styleId,
    styleName: opts.styleName,
    pres,
    slides: opts.outline.map((o) => ({
      title: o.title,
      component: o.component,
      state: 'planned' as const,
    })),
    createdAt: Date.now(),
    previewPath: opts.previewPath,
    outputPath: opts.outputPath,
  };
  sessions.set(opts.sessionId, st);
  return st;
}

export function getDeck(sessionId: string): DeckSessionState | undefined {
  return sessions.get(sessionId);
}

export function endDeck(sessionId: string): void {
  sessions.delete(sessionId);
}

/** 标记某页开始画 —— 右侧那张卡会亮边框 + 呼吸点 */
export function markBuilding(sessionId: string, index: number): void {
  const st = sessions.get(sessionId);
  if (!st || !st.slides[index]) return;
  st.slides[index] = { ...st.slides[index]!, state: 'building' };
}

/**
 * 某页画完 —— 传入已经 add 到 pres 上的 slide 在 model 里的下标。
 * 分开传是因为"大纲第 3 页"和"presentation 里第几张"不一定对得上
 * (前面可能有页失败了没进 model)。
 */
export function completeSlide(sessionId: string, index: number, modelSlideIndex: number): void {
  const st = sessions.get(sessionId);
  if (!st || !st.slides[index]) return;
  const slide = st.pres.model.slides[modelSlideIndex];
  st.slides[index] = { ...st.slides[index]!, state: 'done', slide };
}

/** 某页画砸了 —— 不静默跳过, 右侧要红着告诉用户哪一页没成 */
export function failSlide(sessionId: string, index: number, error: string): void {
  const st = sessions.get(sessionId);
  if (!st || !st.slides[index]) return;
  st.slides[index] = { ...st.slides[index]!, state: 'failed', error };
}

/** 当前状态渲染成预览 HTML —— 写文件的那条路要它 */
export function deckPreviewHtml(sessionId: string): string | null {
  const st = sessions.get(sessionId);
  if (!st) return null;
  return renderDeckPreviewHtml(st.pres.model, st.slides, {
    title: st.title,
    styleName: st.styleName,
  });
}

/**
 * 开 surface 的 payload —— **整个 deck 只发这一次**。
 *
 * 走 source.type='file' 而不是 inline, 有两个硬理由:
 *   1. inline 意味着每页都要把整份预览 HTML (十几 KB, 含每页的内联 SVG) 塞进
 *      工具返回值, 也就是塞进模型上下文。二十页就是几百 KB 的纯噪音, 而且正是
 *      这类超长工具 payload 在把 JSON 撑炸 (create_slides 的 5 页硬闸门同源)。
 *   2. HtmlSurfaceViewer 对 file 源本来就在可见时 400ms 轮询重载。所以后续每页
 *      只要把同一个文件重写一遍, 右侧自己就刷新了 —— 一个 marker 都不用再发。
 *
 * 结论: deck_begin 发一次 open, deck_add_slide 只写文件、返回一行进度。
 */
export function deckSurfacePayload(
  sessionId: string,
  opts: { first?: boolean; filePath?: string },
): SurfaceMarkerPayload | null {
  const st = sessions.get(sessionId);
  if (!st) return null;

  const source = opts.filePath
    ? { type: 'file' as const, path: opts.filePath }
    : { type: 'inline' as const, content: deckPreviewHtml(sessionId) ?? '' };

  if (opts.first) {
    return {
      [SURFACE_MARKER]: true,
      action: 'open',
      surface: {
        id: st.surfaceId,
        kind: 'html',
        source,
        title: st.title || '演示文稿',
        pinned: false,
        createdAt: st.createdAt,
        updatedAt: Date.now(),
      },
    } as SurfaceMarkerPayload;
  }
  return {
    [SURFACE_MARKER]: true,
    action: 'update',
    surfaceId: st.surfaceId,
    patch: { source, updatedAt: Date.now() },
  } as SurfaceMarkerPayload;
}

/** 进度摘要 —— 给工具的文字返回值用, 让模型也知道自己走到哪了 */
export function deckProgress(sessionId: string): { done: number; failed: number; total: number } {
  const st = sessions.get(sessionId);
  if (!st) return { done: 0, failed: 0, total: 0 };
  return {
    done: st.slides.filter((s) => s.state === 'done').length,
    failed: st.slides.filter((s) => s.state === 'failed').length,
    total: st.slides.length,
  };
}
