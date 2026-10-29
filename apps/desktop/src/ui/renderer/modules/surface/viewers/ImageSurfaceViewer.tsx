/**
 * ImageSurfaceViewer — 静态图片 viewer
 *
 * 支持 source 三种:
 *   - file: 本地路径 → neox-asset://local/<path> (Electron 协议)
 *   - inline: data:image/...;base64,... 或 raw base64 字符串
 *   - url: http(s) 远端图片
 *
 * 操作: 滚轮缩放(0.25× ~ 8×), 拖动平移, 双击 reset, 右上一键下载.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileTypeIcon } from '../../../components/FileTypeIcon';
import { useAutoReloadOnFsChange } from './useAutoReloadOnFsChange';
import type { Surface } from '../../../state/surfaceStore';
import { useI18n } from '../../../hooks/useI18n';
import { dispatchHint } from '../../../components/notifyEvents';
import { PreviewErrorState } from './previewPerf/PreviewErrorState';
import { absoluteToAssetUrl } from '../../../../shared/assetUrlPath';

interface Props {
  surface: Surface;
}

/** 猜文件扩展名 — 按 source 形态: file 路径后缀 > data URL mime > 内容嗅探, 兜底 png. */
function guessImageExt(surface: Surface): string {
  if (surface.source.type === 'file') {
    const base = surface.source.path.split(/[/\\]/).pop() ?? '';
    const dot = base.lastIndexOf('.');
    if (dot >= 0) return base.slice(dot + 1).toLowerCase();
  }
  if (surface.source.type === 'url') {
    const m = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.exec(surface.source.url);
    if (m) return m[1].toLowerCase();
  }
  if (surface.source.type === 'inline') {
    const c = surface.source.content;
    const dataMime = /^data:image\/([a-z0-9+.-]+)/i.exec(c);
    if (dataMime) {
      const sub = dataMime[1].toLowerCase();
      if (sub.includes('svg')) return 'svg';
      if (sub === 'jpeg') return 'jpg';
      return sub;
    }
    const head = c.trimStart().slice(0, 64).toLowerCase();
    if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  }
  return 'png';
}

const fileToAssetUrl = absoluteToAssetUrl;

function svgTextToDataUrl(text: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}

function isSvgMarkup(text: string): boolean {
  const head = text.trimStart().slice(0, 64).toLowerCase();
  return head.startsWith('<svg') || head.startsWith('<?xml');
}

function isSvgSurface(surface: Surface): boolean {
  if (surface.kind === 'svg') return true;
  if (surface.source.type === 'file') return /\.svg$/i.test(surface.source.path);
  if (surface.source.type === 'inline') return isSvgMarkup(surface.source.content);
  if (surface.source.type === 'url') return /\.svg(\?|#|$)/i.test(surface.source.url);
  return false;
}

function resolveSrc(surface: Surface): string {
  if (surface.source.type === 'file') return fileToAssetUrl(surface.source.path);
  if (surface.source.type === 'url') return surface.source.url;
  if (surface.source.type === 'inline') {
    const c = surface.source.content;
    if (c.startsWith('data:') || c.startsWith('http:') || c.startsWith('https:')) return c;
    if (isSvgMarkup(c)) return svgTextToDataUrl(c);
    /* 裸 base64 兜底 — 默认 png */
    return `data:image/png;base64,${c}`;
  }
  return '';
}

function fallbackSvgSrc(surface: Surface): string | null {
  const fallback = typeof surface.metadata?.fallbackContent === 'string'
    ? surface.metadata.fallbackContent
    : '';
  if (fallback && isSvgMarkup(fallback)) return svgTextToDataUrl(fallback);
  return null;
}

export const ImageSurfaceViewer: React.FC<Props> = ({ surface }) => {
  const { isZh } = useI18n();
  const [scale, setScale] = useState<number>(1);
  /* 当前 fit-to-view 对应的比例 —— 药丸上 Fit 与 100% 互切要拿它做判据 */
  const [fitScale, setFitScale] = useState(1);
  const [scaleInitialized, setScaleInitialized] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragOriginRef = useRef({ x: 0, y: 0, startX: 0, startY: 0 });
  const [loadError, setLoadError] = useState(false);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [overrideSrc, setOverrideSrc] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const svgLike = isSvgSurface(surface);
  const resolved = resolveSrc(surface);
  const src = overrideSrc || resolved;
  const filePath = surface.source.type === 'file' ? surface.source.path : null;
  useAutoReloadOnFsChange(filePath, useCallback(() => setRetryNonce((n) => n + 1), []));

  /* surface 切换时重置 (含 retry 状态) */
  useEffect(() => {
    setScale(1);
    setScaleInitialized(false);
    setPos({ x: 0, y: 0 });
    setLoadError(false);
    setOverrideSrc(null);
  }, [surface.id, resolved]);

  const applyFitToView = useCallback((img: HTMLImageElement) => {
    const canvas = canvasRef.current;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih) {
      setScale(1);
      setScaleInitialized(true);
      return;
    }
    const cw = canvas?.clientWidth ?? 0;
    const ch = canvas?.clientHeight ?? 0;
    if (!cw || !ch) {
      /* 面板刚打开布局还没完成 — 下一帧再量, 同时先放开可见避免黑屏 */
      setScale(1);
      setScaleInitialized(true);
      requestAnimationFrame(() => {
        const c2 = canvasRef.current;
        const cw2 = c2?.clientWidth ?? 0;
        const ch2 = c2?.clientHeight ?? 0;
        if (!cw2 || !ch2) return;
        const fit2 = Math.min(1, cw2 / iw, ch2 / ih);
        setFitScale(fit2);
        setScale(fit2);
      });
      return;
    }
    /* fit-to-view: 只在图 > 框时缩小; 图 ≤ 框保持 1:1 (不放大小图) */
    const fit = Math.min(1, cw / iw, ch / ih);
    setFitScale(fit);
    setScale(fit);
    setScaleInitialized(true);
  }, []);

  const fitModeRef = useRef(true);
  fitModeRef.current = Math.abs(scale - fitScale) < 0.005;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const img = imgRef.current;
        if (!img || !fitModeRef.current || !img.naturalWidth || !img.naturalHeight) return;
        const fit = Math.min(1, canvas.clientWidth / img.naturalWidth, canvas.clientHeight / img.naturalHeight);
        if (!fit) return;
        setFitScale(fit);
        setScale(fit);
        setPos({ x: 0, y: 0 });
      });
    });
    ro.observe(canvas);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  /* 首帧 fit-to-view: img.onLoad 触发, 算 natural 尺寸 vs 容器尺寸的 min ratio */
  const onImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    if (scaleInitialized) return;
    applyFitToView(e.currentTarget);
  }, [scaleInitialized, applyFitToView]);

  /* 兜底: 无论 onLoad 是否因 0 尺寸早退, 最多 120ms 后强制可见, 防 SVG 永久黑屏 */
  useEffect(() => {
    if (scaleInitialized || loadError) return;
    const t = window.setTimeout(() => {
      setScaleInitialized(true);
      const img = imgRef.current;
      if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
        applyFitToView(img);
      }
    }, 120);
    return () => window.clearTimeout(t);
  }, [src, retryNonce, scaleInitialized, loadError, applyFitToView]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const isPinch = e.ctrlKey;                 // macOS trackpad pinch → ctrlKey
    const sensitivity = isPinch ? 0.006 : 0.0018;
    setScale((s) => {
      const next = s * Math.exp(-e.deltaY * sensitivity);
      return Math.max(0.1, Math.min(10, next));
    });
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    setDragging(true);
    dragOriginRef.current = { x: e.clientX, y: e.clientY, startX: pos.x, startY: pos.y };
  }, [pos]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    const { x, y, startX, startY } = dragOriginRef.current;
    setPos({ x: startX + (e.clientX - x), y: startY + (e.clientY - y) });
  }, [dragging]);

  const onMouseUp = useCallback(() => setDragging(false), []);

  const reset = useCallback(() => {
    setScale(1);
    setPos({ x: 0, y: 0 });
  }, []);

  /* 面包屑 —— 目录太深时只留尾部 5 段, 前面用 … 收起
   * (整条路径铺开会把画布挤没; Cursor 也是这么处理长路径的)。 */
  const crumbSegments = React.useMemo(() => {
    if (!filePath) return [] as string[];
    const segs = filePath.split(/[/\\]/).filter(Boolean);
    return segs.length > 6 ? ['…', ...segs.slice(-5)] : segs;
  }, [filePath]);

  const isFit = Math.abs(scale - fitScale) < 0.005;
  const toggleFit = React.useCallback(() => {
    setScale((s) => (Math.abs(s - fitScale) < 0.005 ? 1 : fitScale));
  }, [fitScale]);

  /* 另存为 — 走 saveFileDialog + surfaceWriteFile, 比 <a download> 可靠 (custom
   * protocol / 跨域 URL 下 anchor download 在 Electron 里经常静默不生效).
   *   file 源: 重读 base64 → 写目标路径
   *   inline: data URL 解 payload / SVG 文本直接写
   *   url:    fetch → base64 (失败退回 anchor download 尽力一试) */
  const onDownload = useCallback(async () => {
    const api = (window as any).neox;
    const fallbackAnchor = () => {
      const a = document.createElement('a');
      a.href = src;
      a.download = surface.title || 'image';
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    if (!api?.saveFileDialog || !api?.surfaceWriteFile) {
      fallbackAnchor();
      return;
    }
    try {
      const ext = guessImageExt(surface);
      const baseName = (surface.title || 'image').replace(/\.[a-z0-9]+$/i, '') || 'image';
      const picked = await api.saveFileDialog({
        title: isZh ? '图片另存为' : 'Save image as',
        defaultPath: `${baseName}.${ext}`,
        filters: [{ name: 'Image', extensions: [ext] }, { name: 'All Files', extensions: ['*'] }],
      });
      if (!picked) return;

      let payload: { content: string; encoding: 'base64' | 'utf-8' } | null = null;
      if (surface.source.type === 'file') {
        const r = await api.surfaceReadFile?.(surface.source.path, { encoding: 'base64' });
        const b64 = typeof r === 'string' ? r : (r?.content ?? '');
        if (r?.success === false || !b64) throw new Error(r?.error || (isZh ? '读取源文件失败' : 'failed to read source file'));
        payload = { content: b64, encoding: 'base64' };
      } else if (surface.source.type === 'inline') {
        const c = surface.source.content;
        const dataMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(c);
        if (dataMatch) {
          payload = dataMatch[2]
            ? { content: dataMatch[3], encoding: 'base64' }
            : { content: decodeURIComponent(dataMatch[3]), encoding: 'utf-8' };
        } else {
          const head = c.trimStart().slice(0, 64).toLowerCase();
          payload = (head.startsWith('<svg') || head.startsWith('<?xml'))
            ? { content: c, encoding: 'utf-8' }
            : { content: c, encoding: 'base64' };   /* 裸 base64 */
        }
      } else {
        /* http(s) 远端 — fetch 转 base64, CORS 拒绝时退 anchor */
        try {
          const resp = await fetch(surface.source.url);
          const buf = await resp.arrayBuffer();
          let bin = '';
          const bytes = new Uint8Array(buf);
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
          }
          payload = { content: btoa(bin), encoding: 'base64' };
        } catch {
          fallbackAnchor();
          return;
        }
      }
      const w = await api.surfaceWriteFile(picked, payload.content, { encoding: payload.encoding });
      if (w?.success === false) throw new Error(w.error || 'write failed');
      dispatchHint(isZh ? `已保存: ${picked}` : `Saved: ${picked}`, 'success');
    } catch (e: any) {
      dispatchHint((isZh ? '保存失败: ' : 'Save failed: ') + (e?.message || String(e)), 'warning');
    }
  }, [src, surface, isZh]);

  return (
    <div
      className={`sfc-image${dragging ? ' is-dragging' : ''}${svgLike ? ' sfc-image--svg' : ''}`}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onDoubleClick={reset}
    >
      {filePath && (
        <div className="sfc-image__crumbs" title={filePath}>
          <span className="sfc-image__crumb-icon">
            <FileTypeIcon path={filePath} size={13} />
          </span>
          {crumbSegments.map((seg, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="sfc-image__crumb-sep" aria-hidden>›</span>}
              <span className={`sfc-image__crumb${i === crumbSegments.length - 1 ? ' is-leaf' : ''}`}>{seg}</span>
            </React.Fragment>
          ))}
        </div>
      )}
      <div className="sfc-image__canvas" ref={canvasRef}>
        {loadError ? (
          <PreviewErrorState
            rawError={`${isZh ? '图片加载失败' : 'Failed to load image'}: ${src.slice(0, 180)}`}
            isZh={isZh}
            onRetry={() => { setLoadError(false); setRetryNonce((n) => n + 1); }}
            onOpenExternal={filePath ? () => {
              setExternalError(null);
              void (async () => {
                try {
                  const r = await (window as any).neox?.surfaceOpenExternal?.(filePath);
                  if (r?.success === false) setExternalError(r.error || (isZh ? '打开失败' : 'failed to open'));
                } catch (err: any) {
                  setExternalError(err?.message || String(err));
                }
              })();
            } : undefined}
            externalError={externalError}
          />
        ) : (
          <img
            ref={imgRef}
            /* retryNonce 加到 query — base64 dataURL 加 ?n= 无效, 但 file/url 会重新请求.
             *  data URI 失败极少, 通常都是 file/url 路径问题. */
            src={src.startsWith('data:') ? src : `${src}${src.includes('?') ? '&' : '?'}__n=${retryNonce}`}
            alt={surface.title || 'image surface'}
            draggable={false}
            onLoad={onImgLoad}
            onError={() => {
              /* file 加载失败 → 尝试 fallbackContent data URL (刚写完的 SVG) */
              if (!overrideSrc) {
                const fb = fallbackSvgSrc(surface);
                if (fb) {
                  setOverrideSrc(fb);
                  setLoadError(false);
                  setScaleInitialized(false);
                  return;
                }
              }
              setLoadError(true);
            }}
            style={{
              transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
              transition: dragging ? 'none' : 'transform .15s ease',
              /* 首帧未 initialize 时先隐, 免"1× 大图闪一下再缩" (仅 ~ 首帧, 加载完立刻显) */
              visibility: scaleInitialized ? 'visible' : 'hidden',
            }}
          />
        )}
      </div>
      <div className="sfc-image__zoombar" role="toolbar" aria-label={isZh ? '缩放' : 'Zoom'}>
        <button
          type="button"
          className="sfc-image__zoombtn"
          onClick={() => setScale((s) => Math.max(0.25, s / 1.15))}
          title={isZh ? '缩小' : 'Zoom out'}
          aria-label={isZh ? '缩小' : 'Zoom out'}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="7" cy="7" r="4.5" /><line x1="10.4" y1="10.4" x2="14" y2="14" /><line x1="5" y1="7" x2="9" y2="7" />
          </svg>
        </button>
        <button
          type="button"
          className="sfc-image__zoombtn"
          onClick={() => setScale((s) => Math.min(8, s * 1.15))}
          title={isZh ? '放大' : 'Zoom in'}
          aria-label={isZh ? '放大' : 'Zoom in'}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="7" cy="7" r="4.5" /><line x1="10.4" y1="10.4" x2="14" y2="14" />
            <line x1="5" y1="7" x2="9" y2="7" /><line x1="7" y1="5" x2="7" y2="9" />
          </svg>
        </button>
        <button
          type="button"
          className="sfc-image__zoomlabel"
          onClick={toggleFit}
          title={isFit ? (isZh ? '切到 100%' : 'Switch to 100%') : (isZh ? '适应窗口' : 'Fit to window')}
        >
          {isFit ? `${isZh ? '适应' : 'Fit'} (${Math.round(scale * 100)}%)` : `${Math.round(scale * 100)}%`}
        </button>
      </div>
    </div>
  );
};

export default ImageSurfaceViewer;
