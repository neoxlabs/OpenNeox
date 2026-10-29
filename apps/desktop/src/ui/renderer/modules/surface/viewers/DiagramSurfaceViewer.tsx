/**
 * DiagramSurfaceViewer — mermaid 图 viewer
 *
 * source 直接当 mermaid 源码渲染. file 模式时读 .mmd 文件内容,
 * inline 模式时直接用 content 字段.
 *
 * 用 mermaid.js 懒加载渲染, 主题跟随 :root[data-theme].
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Surface } from '../../../state/surfaceStore';
import { useVisibilityInterval } from '../../../hooks/useVisibilityInterval';
import { useI18n } from '../../../hooks/useI18n';
import { dispatchHint } from '../../../components/notifyEvents';
import { getNeoxMermaid, normalizeMermaidSource } from '../../../components/mermaidTheme';

interface Props {
  surface: Surface;
}

/* 跟 timeline 同一个入口, 同一套 Neox 主题色 (见 components/mermaidTheme.ts) */
const getMermaid = getNeoxMermaid;

function detectIsDark(): boolean {
  const t = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null;
  if (t === 'light') return false;
  if (t === 'dark') return true;
  if (typeof matchMedia !== 'undefined') return matchMedia('(prefers-color-scheme: dark)').matches;
  return true;
}

let renderIdCounter = 0;

export const DiagramSurfaceViewer: React.FC<Props> = ({ surface }) => {
  const { isZh } = useI18n();
  const [source, setSource] = useState<string>('');
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(detectIsDark);
  const idRef = useRef(`mermaid-sfc-${++renderIdCounter}`);

  /* 主题切换 */
  useEffect(() => {
    const update = () => setIsDark(detectIsDark());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  /* 读 source — file or inline. file 源走 visibility-aware polling (后台 tab 不烧 CPU). */
  const lastContentRef = useRef('');
  const loadRef = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    lastContentRef.current = '';

    const load = async () => {
      if (surface.source.type === 'inline') {
        if (!cancelled) setSource(surface.source.content);
        return;
      }
      if (surface.source.type !== 'file') {
        if (!cancelled) setError(isZh ? 'diagram surface 仅支持 file / inline source' : 'Diagram surface only supports file/inline source');
        return;
      }
      try {
        const api = (window as any).neox;
        const reader = api?.surfaceReadFile ?? api?.readFile;
        const result = await reader?.(surface.source.path);
        if (cancelled) return;
        if (result?.success === false) {
          setError(result.error || 'read failed');
          return;
        }
        const text = typeof result === 'string' ? result : (result?.content ?? '');
        if (text === lastContentRef.current) return;
        lastContentRef.current = text;
        setSource(text);
        setError(null);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || String(err));
      }
    };

    loadRef.current = load;
    void load();
    return () => { cancelled = true; };
  }, [surface.source, isZh]);

  useVisibilityInterval(() => loadRef.current(), surface.source.type === 'file' ? 400 : 0);

  /* 渲染 mermaid */
  useEffect(() => {
    if (!source.trim()) {
      setSvg(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const mermaid = await getMermaid(isDark);
        if (cancelled) return;
        const { svg: rendered } = await mermaid.render(idRef.current + '-' + Date.now(), normalizeMermaidSource(source));
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || String(err));
          setSvg(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [source, isDark]);

  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragOriginRef = useRef({ x: 0, y: 0, startX: 0, startY: 0 });
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(1);

  const naturalSize = useCallback((): { w: number; h: number } | null => {
    const svgEl = stageRef.current?.querySelector('svg');
    if (!svgEl) return null;
    const vb = svgEl.getAttribute('viewBox');
    if (vb) {
      const p = vb.trim().split(/[\s,]+/).map(Number);
      if (p.length === 4 && p[2] > 0 && p[3] > 0) return { w: p[2], h: p[3] };
    }
    const b = svgEl.getBoundingClientRect();
    const sc = scaleRef.current || 1;
    return b.width > 0 && b.height > 0 ? { w: b.width / sc, h: b.height / sc } : null;
  }, []);

  const computeFit = useCallback((): number => {
    const c = canvasRef.current;
    const nat = naturalSize();
    if (!c || !nat) return 1;
    const cb = c.getBoundingClientRect();
    const pad = 24;
    const fit = Math.min((cb.width - pad) / nat.w, (cb.height - pad) / nat.h);
    if (!Number.isFinite(fit) || fit <= 0) return 1;
    /* 上限 2× —— 小图放大到能看清即可, 再大就失真; 下限 0.25× 跟滚轮一致 */
    return Math.max(0.25, Math.min(2, fit));
  }, [naturalSize]);

  const [natSize, setNatSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => { scaleRef.current = scale; }, [scale]);

  const fitToView = useCallback(() => {
    setPos({ x: 0, y: 0 });
    setScale(computeFit());
  }, [computeFit]);

  useEffect(() => {
    setScale(1);
    scaleRef.current = 1;
    setPos({ x: 0, y: 0 });
  }, [surface.id]);

  /* svg 换了就重新 fit —— 等一帧让浏览器把 svg 真正布局出来再量 */
  useEffect(() => {
    if (!svg) return;
    const raf = requestAnimationFrame(() => {
      scaleRef.current = 1;
      setNatSize(naturalSize());
      const f = computeFit();
      setPos({ x: 0, y: 0 });
      setScale(f);
    });
    return () => cancelAnimationFrame(raf);
  }, [svg, computeFit, naturalSize]);

  /* 面板宽度变了 (拖分栏 / 收侧栏) 也重新 fit */
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !svg) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setScale(computeFit()));
    });
    ro.observe(c);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [svg, computeFit]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setScale((s) => Math.max(0.25, Math.min(8, e.deltaY < 0 ? s * 1.15 : s / 1.15)));
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
  /* 双击 = 适应画布 (更常用); 工具条上另有 1:1 给真 100% */
  const reset = useCallback(() => { fitToView(); }, [fitToView]);
  const actualSize = useCallback(() => { setScale(1); setPos({ x: 0, y: 0 }); }, []);

  /* 导出 SVG — saveFileDialog + surfaceWriteFile (blob anchor 在 Electron 下不稳). */
  const onDownload = useCallback(async () => {
    if (!svg) return;
    const api = (window as any).neox;
    if (!api?.saveFileDialog || !api?.surfaceWriteFile) {
      /* 兜底老路径 */
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${surface.title || 'diagram'}.svg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return;
    }
    try {
      const base = (surface.title || 'diagram').replace(/\.svg$/i, '');
      const picked = await api.saveFileDialog({
        title: isZh ? '导出 SVG' : 'Export SVG',
        defaultPath: `${base}.svg`,
        filters: [{ name: 'SVG', extensions: ['svg'] }, { name: 'All Files', extensions: ['*'] }],
      });
      if (!picked) return;
      const r = await api.surfaceWriteFile(picked, svg, { encoding: 'utf-8' });
      if (r?.success === false) throw new Error(r.error || 'write failed');
      dispatchHint(isZh ? `已导出: ${picked}` : `Exported: ${picked}`, 'success');
    } catch (e: any) {
      dispatchHint((isZh ? '导出失败: ' : 'Export failed: ') + (e?.message || String(e)), 'warning');
    }
  }, [svg, surface.title, isZh]);

  /* 复制 mermaid 源码 — 拿去改 / 喂回 agent / 贴文档 */
  const onCopySource = useCallback(() => {
    if (!source) return;
    navigator.clipboard.writeText(source).then(
      () => dispatchHint(isZh ? '已复制 Mermaid 源码' : 'Mermaid source copied', 'success'),
      () => dispatchHint(isZh ? '复制失败' : 'Copy failed', 'warning'),
    );
  }, [source, isZh]);

  if (error) {
    return (
      <div className="sfc-diagram sfc-diagram--error">
        <div className="sfc-empty__title">{isZh ? 'Mermaid 渲染失败' : 'Mermaid render failed'}</div>
        <pre className="sfc-empty__msg">{error}</pre>
        {source && <pre className="sfc-diagram__src">{source}</pre>}
      </div>
    );
  }
  if (!svg) {
    return <div className="sfc-empty"><div className="sfc-empty__title">{isZh ? '渲染中…' : 'Rendering…'}</div></div>;
  }
  return (
    <div
      className={`sfc-image sfc-image--diagram${dragging ? ' is-dragging' : ''}`}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onDoubleClick={reset}
    >
      <div className="sfc-image__toolbar">
        <button type="button" onClick={() => setScale(s => Math.min(8, s * 1.15))} title={isZh ? '放大' : 'Zoom in'}>+</button>
        <button type="button" onClick={() => setScale(s => Math.max(0.25, s / 1.15))} title={isZh ? '缩小' : 'Zoom out'}>−</button>
        <button type="button" onClick={fitToView} title={isZh ? '适应画布 (双击)' : 'Fit to view (double-click)'}>{isZh ? '适应' : 'Fit'}</button>
        <button type="button" onClick={actualSize} title={isZh ? '实际尺寸 100%' : 'Actual size 100%'}>1:1</button>
        <button type="button" onClick={onCopySource} title={isZh ? '复制 Mermaid 源码' : 'Copy Mermaid source'}>
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
            <path d="M2.5 9.5V3a1 1 0 0 1 1-1H9" />
          </svg>
        </button>
        <button type="button" onClick={() => void onDownload()} title={isZh ? '导出 SVG…' : 'Export SVG…'}>⬇</button>
        <span className="sfc-image__zoom">{Math.round(scale * 100)}%</span>
      </div>
      <div className="sfc-image__canvas" ref={canvasRef}>
        <div
          ref={stageRef}
          className="sfc-diagram__stage"
          dangerouslySetInnerHTML={{ __html: svg }}
          style={{
            /* 显式钉成自然尺寸 —— 否则 svg 的 width:100% 会跟着容器变, scale 没有稳定基准 */
            ...(natSize ? { width: `${natSize.w}px`, height: `${natSize.h}px` } : null),
            transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
            transition: dragging ? 'none' : 'transform .15s ease',
            transformOrigin: 'center center',
          }}
        />
      </div>
    </div>
  );
};

export default DiagramSurfaceViewer;
