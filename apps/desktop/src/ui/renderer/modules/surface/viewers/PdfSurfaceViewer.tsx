
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Surface } from '../../../state/surfaceStore';
import { useNeoxRuntime } from '../../../app/NeoxRuntimeContext';
import { KindHomeView } from './KindHomeView';
import { useAutoReloadOnFsChange } from './useAutoReloadOnFsChange';
import { useI18n } from '../../../hooks/useI18n';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { retryLabel, retryOrReload } from './staleModule';
import { PreviewErrorState } from './previewPerf/PreviewErrorState';

interface Props {
  surface: Surface;
}

/* lazy import — pdfjs-dist 解构 + workerSrc 一次性设置. */
let pdfjsPromise: Promise<any> | null = null;
const loadPdfjs = async () => {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs: any = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
};

/** 单文件 PDF 渲染 — key=tab.url 切 tab 自然 unmount 重建. */
const SinglePdfView: React.FC<Props> = ({ surface }) => {
  const { isZh } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const docRef = useRef<any>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  /* Agent 边写边出 PDF 时, 文件一变就重画 (4.0.1 重做): 原来先清空容器再一页页画 —— 每次闪白、跳回第一页,
   * 用户只看到「在刷新」, 新写的内容在最下面看不到。现在后台画好整份再一次换上; 用户没手动往上翻过
   * (或正停在底部) 就平滑滚到最新内容, 像跟着在写; 翻到中间看的保持原位。 */
  const [updating, setUpdating] = useState(false);
  const userScrolledRef = useRef(false);
  const pdfPath = surface.source.type === 'file' ? surface.source.path : null;
  useAutoReloadOnFsChange(pdfPath, useCallback(() => setRetryNonce((n) => n + 1), []));

  /* 只认用户自己动的滚动 (滚轮 / 拖滚动条 / 键盘); 程序滚到底触发的 scroll 不算 */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const mark = () => { userScrolledRef.current = true; };
    el.addEventListener('wheel', mark, { passive: true });
    el.addEventListener('pointerdown', mark, { passive: true });
    el.addEventListener('keydown', mark);
    return () => {
      el.removeEventListener('wheel', mark);
      el.removeEventListener('pointerdown', mark);
      el.removeEventListener('keydown', mark);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        /* Step 1: 读 PDF 二进制 */
        let data: Uint8Array;
        if (surface.source.type === 'inline') {
          try {
            const bin = atob(surface.source.content);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            data = arr;
          } catch {
            setError(isZh ? 'inline content 不是有效 base64 PDF' : 'Inline content is not a valid base64 PDF');
            setLoading(false);
            return;
          }
        } else if (surface.source.type === 'file') {
          const path = surface.source.path;
          const api = (window as any).neox;
          const reader = api?.surfaceReadFile;
          if (!reader) {
            setError(isZh ? 'surfaceReadFile bridge 不可用' : 'surfaceReadFile bridge unavailable');
            setLoading(false);
            return;
          }
          const result = await reader(path, { encoding: 'base64' });
          if (cancelled) return;
          if (result?.success === false) {
            setError(result.error || 'read failed');
            setLoading(false);
            return;
          }
          const base64 = typeof result === 'string' ? result : (result?.content ?? '');
          if (!base64) {
            setError(isZh ? '文件为空或读取失败' : 'File is empty or could not be read');
            setLoading(false);
            return;
          }
          const bin = atob(base64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          data = arr;
        } else {
          setError(isZh ? 'PDF surface 仅支持 file 或 inline source' : 'PDF surfaces only support file or inline sources');
          setLoading(false);
          return;
        }

        /* Step 2: 加载 PDF.js + 解 PDF */
        const pdfjs = await loadPdfjs();
        if (cancelled) return;
        const loadingTask = pdfjs.getDocument({ data });
        const doc = await loadingTask.promise;
        if (cancelled) {
          try { await doc.destroy(); } catch { /* ignore */ }
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);

        /* Step 3: 渲染每一页 — 容器宽度自适应。画进离屏的 fresh, 全画完再一次换上 (不闪白、不跳顶) */
        const container = containerRef.current;
        if (!container) return;
        const isUpdate = container.childElementCount > 0;
        if (isUpdate) setUpdating(true);
        const fresh = document.createDocumentFragment();

        const containerWidth = container.clientWidth - 32;
        const dpr = Math.max(1, window.devicePixelRatio || 1);

        for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
          if (cancelled) return;
          const page = await doc.getPage(pageNum);
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = containerWidth / baseViewport.width;
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement('canvas');
          canvas.className = 'sfc-pdf__page';
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          ctx.scale(dpr, dpr);

          const wrapper = document.createElement('div');
          wrapper.className = 'sfc-pdf__page-wrap';
          const label = document.createElement('div');
          label.className = 'sfc-pdf__page-label';
          label.textContent = `${pageNum} / ${doc.numPages}`;
          wrapper.appendChild(canvas);
          wrapper.appendChild(label);
          /* 第一次打开边画边上 (先看到第一页); 更新时进离屏, 画完一次换 */
          (isUpdate ? fresh : container).appendChild(wrapper);

          await page.render({ canvasContext: ctx, viewport }).promise;
          page.cleanup();
        }
        if (cancelled) return;

        if (isUpdate) {
          const prevTop = container.scrollTop;
          const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
          const follow = !userScrolledRef.current || nearBottom;
          container.replaceChildren(fresh);
          if (follow) {
            /* 先停在原处, 下一帧再平滑滚到底 —— 看得见是「往下长出了新内容」, 不是瞬移 */
            container.scrollTop = prevTop;
            requestAnimationFrame(() => container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' }));
          } else {
            container.scrollTop = prevTop;
          }
          setUpdating(false);
        }

        setLoading(false);
        setError(null);
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || String(err));
          setLoading(false);
        }
      }
    };

    void init();

    return () => {
      cancelled = true;
      setUpdating(false);
      if (docRef.current) {
        try { docRef.current.destroy(); } catch { /* ignore */ }
        docRef.current = null;
      }
    };
  }, [surface.source, retryNonce]);

  const pdfSourcePath = surface.source.type === 'file' ? surface.source.path : null;
  return (
    <div className="sfc-pdf">
      {loading && (
        <div className="sfc-empty">
          <div className="sfc-empty__title neox-text-shimmer">{isZh ? 'PDF 加载中…' : 'Loading PDF…'}</div>
        </div>
      )}
      {error && (
        <PreviewErrorState
          rawError={error}
          isZh={isZh}
          onRetry={() => retryOrReload(error, () => setRetryNonce((n) => n + 1))}
          onOpenExternal={pdfSourcePath ? () => {
            setExternalError(null);
            void (async () => {
              try {
                const r = await (window as any).neox?.surfaceOpenExternal?.(pdfSourcePath);
                if (r?.success === false) setExternalError(r.error || (isZh ? '打开失败' : 'failed to open'));
              } catch (err: any) {
                setExternalError(err?.message || String(err));
              }
            })();
          } : undefined}
          externalError={externalError}
          retryLabel={retryLabel(error, isZh)}
        />
      )}
      <div
        ref={containerRef}
        className="sfc-pdf__pages"
        style={{ display: error ? 'none' : undefined }}
      />
      {!loading && !error && pageCount > 0 && (
        <div className={`sfc-pdf__meta${updating ? ' is-updating' : ''}`}>
          {updating
            ? <span className="neox-text-shimmer">{isZh ? '正在更新…' : 'Updating…'}</span>
            : (isZh ? `共 ${pageCount} 页` : `${pageCount} page${pageCount === 1 ? '' : 's'}`)}
        </div>
      )}
    </div>
  );
};

/** PDF host — 跟 docx/sheet 同范式: 多 tab 数据通过 metadata 暴露, chrome 由 SurfacePanel 接管. */
export const PdfSurfaceViewer: React.FC<Props> = ({ surface }) => {
  const { activeSession, workspacePath } = useNeoxRuntime();
  const sessionId = activeSession?.id ?? '';

  const tabs = useMemo(() => {
    const raw = (surface.metadata?.tabs as Array<{ id: string; url: string; title?: string }> | undefined);
    /* 过滤 inline placeholder (旧 home 请求误存的 stale tab, 挡 home view) */
    const cleaned = (raw ?? []).filter(t => !String(t.url ?? '').startsWith('inline-'));
    if (cleaned.length > 0) return cleaned;
    if (surface.source.type === 'file') {
      return [{ id: surface.id, url: surface.source.path, title: surface.title }];
    }
    if (surface.source.type === 'inline' && surface.source.content) {
      return [{ id: surface.id, url: `inline-${surface.id}`, title: surface.title || 'inline' }];
    }
    return [];
  }, [surface.metadata, surface.source, surface.id, surface.title]);

  const activeTabId = (surface.metadata?.activeTabId as string | undefined) ?? tabs[0]?.id;
  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];

  if (!activeTab) {
    return <KindHomeView kind="pdf" sessionId={sessionId} surfaceId={surface.id} workspacePath={workspacePath} />;
  }

  const isInline = activeTab.url.startsWith('inline-');
  const fakeSurface: Surface = {
    ...surface,
    id: activeTab.id,
    title: activeTab.title || activeTab.url.split(/[/\\]/).pop() || '',
    source: isInline
      ? (surface.source.type === 'inline' ? surface.source : { type: 'file', path: activeTab.url })
      : { type: 'file', path: activeTab.url },
  };

  return <SinglePdfView key={activeTab.url} surface={fakeSurface} />;
};

export default PdfSurfaceViewer;
