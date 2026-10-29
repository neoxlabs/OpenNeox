/**
 * PptxSurfaceViewer — .pptx Surface viewer (Codex 风格)
 *
 * 架构:
 *   surfaceReadFile 拿 pptx bytes → 自研 parsePptx() → Presentation 数据模型 → SlideView 组件渲染.
 *   零后端进程 / 零下载 / 零权限提示 / 零平台差异 — 纯浏览器侧 JS.
 *
 * UI 布局 (对齐 Codex 截图):
 *   ┌─────────┬────────────────────────┐
 *   │ 缩略图 1│                         │
 *   │ 缩略图 2│      当前 slide 大图    │
 *   │ 缩略图 3│                         │
 *   │  ...    │                         │
 *   └─────────┴────────────────────────┘
 *
 *   键盘: ↑ ↓ / PgUp PgDn / Home End 翻页. 数字键跳 (未实现).
 *   点缩略图切当前.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Surface } from '../../../state/surfaceStore';
import { useNeoxRuntime } from '../../../app/NeoxRuntimeContext';
import { useI18n } from '../../../hooks/useI18n';
import { KindHomeView } from './KindHomeView';
import { parsePptx, SlideView, type PresentationModel as Presentation } from '../pptxEngine';
import { useAutoReloadOnFsChange } from './useAutoReloadOnFsChange';
import { kbd, MOD_LABEL } from '../../../utils/keymap';
import { PreviewSkeleton } from './previewPerf/PreviewSkeleton';
import { PreviewErrorState } from './previewPerf/PreviewErrorState';
import { useLazyVisible } from './previewPerf/useLazyVisible';

interface Props {
  surface: Surface;
}

function fileNameOf(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() || p;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const normalized = base64.replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
  const bin = atob(normalized);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

type PptxSlideModel = React.ComponentProps<typeof SlideView>['slide'];

/** 单张缩略图 — 接近视口才真正渲染 (40 页的 deck 不必一次建 40 棵 SVG 子树). */
const PptxThumb: React.FC<{
  index: number;
  active: boolean;
  slide: PptxSlideModel;
  presentation: Presentation;
  placeholderHeight: number;
  onSelect: () => void;
}> = ({ index, active, slide, presentation, placeholderHeight, onSelect }) => {
  const { ref, visible } = useLazyVisible<HTMLButtonElement>({ rootMargin: '480px' });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: 4,
        border: active ? '2px solid var(--neox-primary-600, #6366f1)' : '2px solid transparent',
        borderRadius: 6,
        background: 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
      }}
      aria-label={`Slide ${index + 1}`}
      aria-current={active ? 'true' : undefined}
    >
      <span style={{ fontSize: 10, color: 'var(--neox-fg-muted, #888)', width: 14, textAlign: 'right' }}>{index + 1}</span>
      {visible
        ? <SlideView slide={slide} presentation={presentation} containerWidth={112} thumbnail />
        : <span aria-hidden="true" style={{ display: 'inline-block', width: 112, height: placeholderHeight }} />}
    </button>
  );
};

/** 单文件 pptx 视图 — 拿 bytes → parse → 双栏渲染. */
const SinglePptxView: React.FC<Props> = ({ surface }) => {
  const { isZh } = useI18n();
  const [presentation, setPresentation] = useState<Presentation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(800);
  const disposedRef = useRef(false);
  const [zoom, setZoom] = useState(1);
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 4;

  const sourcePath = surface.source.type === 'file' ? surface.source.path : null;

  useLayoutEffect(() => {
    if (!stageRef.current) return;
    const measure = () => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (rect && rect.width > 0) {
        setStageWidth(Math.max(200, rect.width - 32));
      }
    };
    measure();
    const raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setStageWidth(Math.max(200, e.contentRect.width - 32));
      }
    });
    ro.observe(stageRef.current);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [presentation]);

  /* 加载 + 解析 */
  useEffect(() => {
    disposedRef.current = false;
    setPresentation(null);
    setError(null);
    setLoading(true);
    setActiveIdx(0);

    (async () => {
      if (!sourcePath) {
        setError(isZh ? 'pptx surface 仅支持 file source' : 'pptx surface only supports file source');
        setLoading(false);
        return;
      }
      const api = (window as any).neox;
      const reader = api?.surfaceReadFile;
      if (!reader) {
        setError('surfaceReadFile bridge 不可用');
        setLoading(false);
        return;
      }
      try {
        const result = await reader(sourcePath, { encoding: 'base64' });
        if (disposedRef.current) return;
        if (result?.success === false) {
          setError(result.error || 'read failed');
          setLoading(false);
          return;
        }
        const base64 = typeof result === 'string' ? result : (result?.content ?? '');
        if (!base64) {
          setError(isZh ? '文件为空或读取失败' : 'File is empty or unreadable');
          setLoading(false);
          return;
        }
        const buf = base64ToArrayBuffer(base64);
        const pres = await parsePptx(buf);
        if (disposedRef.current) return;
        if (!pres.slides.length) {
          setError(isZh ? 'pptx 里没有任何 slide' : 'No slides in this pptx');
          setLoading(false);
          return;
        }
        setPresentation(pres);
        setLoading(false);
      } catch (err: any) {
        if (disposedRef.current) return;
        setError(err?.message || String(err));
        setLoading(false);
      }
    })();

    return () => { disposedRef.current = true; };
  }, [sourcePath, retryNonce, isZh]);

  useAutoReloadOnFsChange(sourcePath, useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []));

  /* 键盘翻页 + 缩放 (Cmd/Ctrl + +/-/0) */
  useEffect(() => {
    if (!presentation) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      /* 缩放快捷键 · Cmd/Ctrl + = / + / - / 0 */
      if (e.metaKey || e.ctrlKey) {
        if (e.key === '=' || e.key === '+') { setZoom(z => Math.min(MAX_ZOOM, z + 0.1)); e.preventDefault(); return; }
        if (e.key === '-') { setZoom(z => Math.max(MIN_ZOOM, z - 0.1)); e.preventDefault(); return; }
        if (e.key === '0') { setZoom(1); e.preventDefault(); return; }
      }
      const max = presentation.slides.length - 1;
      if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'ArrowRight') {
        setActiveIdx(i => Math.min(max, i + 1)); e.preventDefault();
      } else if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'ArrowLeft') {
        setActiveIdx(i => Math.max(0, i - 1)); e.preventDefault();
      } else if (e.key === 'Home') {
        setActiveIdx(0); e.preventDefault();
      } else if (e.key === 'End') {
        setActiveIdx(max); e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presentation]);

  /* Cmd/Ctrl + 滚轮 = 缩放 (跟浏览器/Preview.app 一致的手感) */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.001;
      setZoom(z => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z + delta)));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [presentation]);

  const openExternal = useCallback(async () => {
    if (!sourcePath) return;
    setExternalError(null);
    const api = (window as any).neox;
    try {
      const r = await api?.surfaceOpenExternal?.(sourcePath);
      if (r?.success === false) setExternalError(r.error || (isZh ? '打开失败' : 'failed to open'));
    } catch (err: any) {
      setExternalError(err?.message || String(err));
    }
  }, [sourcePath, isZh]);

  if (loading) {
    return <PreviewSkeleton kind="pptx" label={isZh ? '正在解析 PowerPoint…' : 'Parsing PowerPoint…'} />;
  }

  if (error) {
    return (
      <PreviewErrorState
        rawError={error}
        isZh={isZh}
        onRetry={() => setRetryNonce(n => n + 1)}
        onOpenExternal={sourcePath ? openExternal : undefined}
        externalError={externalError}
      />
    );
  }

  if (!presentation) return null;
  const activeSlide = presentation.slides[activeIdx];
  const ratio = presentation.slideWidth > 0 ? presentation.slideHeight / presentation.slideWidth : 0.5625;
  const thumbPlaceholderHeight = Math.max(40, Math.round(112 * ratio));

  return (
    <div className="pptx-viewer" style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0, background: 'var(--neox-bg-canvas, #181818)' }}>
      {/* 左侧缩略图列表 */}
      <div
        className="pptx-viewer__thumbs"
        style={{
          width: 156,
          flexShrink: 0,
          overflowY: 'auto',
          padding: 12,
          borderRight: '1px solid var(--neox-line-soft, #2a2a2a)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {presentation.slides.map((s, i) => (
          <PptxThumb
            key={i}
            index={i}
            active={i === activeIdx}
            slide={s}
            presentation={presentation}
            placeholderHeight={thumbPlaceholderHeight}
            onSelect={() => setActiveIdx(i)}
          />
        ))}
      </div>

      {/* 右侧大图 · 垂直居中 + 缩放 (Cmd/Ctrl+wheel · +/-/0 快捷键 · toolbar 按钮) */}
      <div
        ref={stageRef}
        className="pptx-viewer__stage"
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: 'auto',
          padding: 16,
          display: 'flex',
          alignItems: 'center',   /* 垂直居中 */
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        {activeSlide && (
          <SlideView
            slide={activeSlide}
            presentation={presentation}
            containerWidth={Math.max(200, stageWidth * zoom)}
          />
        )}
        {/* 缩放 toolbar · 悬浮右下 · 半透明 · flat 风格 */}
        <div
          style={{
            position: 'absolute',
            right: 16,
            bottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            padding: 4,
            background: 'var(--neox-bg-elevated, #2b2b2b)',
            border: '1px solid var(--neox-line-soft, #2a2a2a)',
            borderRadius: 8,
            boxShadow: '0 2px 8px rgba(0,0,0,.35)',
            fontSize: 12,
            color: 'var(--neox-fg-secondary, #666)',
            userSelect: 'none',
          }}
        >
          <button
            type="button"
            onClick={() => setZoom(z => Math.max(MIN_ZOOM, z - 0.1))}
            title={isZh ? `缩小 (${MOD_LABEL}−)` : `Zoom out (${MOD_LABEL}−)`}
            style={zoomBtnStyle}
            aria-label="zoom out"
          >−</button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            title={isZh ? `实际大小 · 适合窗口 (${kbd('mod+0')})` : `Reset zoom (${kbd('mod+0')})`}
            style={{ ...zoomBtnStyle, minWidth: 48, fontVariantNumeric: 'tabular-nums' }}
          >{Math.round(zoom * 100)}%</button>
          <button
            type="button"
            onClick={() => setZoom(z => Math.min(MAX_ZOOM, z + 0.1))}
            title={isZh ? `放大 (${MOD_LABEL}+)` : `Zoom in (${MOD_LABEL}+)`}
            style={zoomBtnStyle}
            aria-label="zoom in"
          >+</button>
        </div>
      </div>
    </div>
  );
};

const zoomBtnStyle: React.CSSProperties = {
  minWidth: 28,
  height: 24,
  padding: '0 8px',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  borderRadius: 4,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

/** Host — 多 tab 转发 */
export const PptxSurfaceViewer: React.FC<Props> = ({ surface }) => {
  const { activeSession, workspacePath } = useNeoxRuntime();
  const sessionId = activeSession?.id ?? '';

  const tabs = useMemo(() => {
    const raw = (surface.metadata?.tabs as Array<{ id: string; url: string; title?: string }> | undefined);
    const cleaned = (raw ?? []).filter(t => !String(t.url ?? '').startsWith('inline-'));
    if (cleaned.length > 0) return cleaned;
    if (surface.source.type === 'file') {
      return [{ id: surface.id, url: surface.source.path, title: surface.title }];
    }
    return [];
  }, [surface.metadata, surface.source, surface.id, surface.title]);

  const activeTabId = (surface.metadata?.activeTabId as string | undefined) ?? tabs[0]?.id;
  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];

  if (!activeTab) {
    return <KindHomeView kind="pptx" sessionId={sessionId} surfaceId={surface.id} workspacePath={workspacePath} />;
  }

  const fakeSurface: Surface = {
    ...surface,
    id: activeTab.id,
    title: activeTab.title || fileNameOf(activeTab.url),
    source: { type: 'file', path: activeTab.url },
  };

  return <SinglePptxView key={activeTab.url} surface={fakeSurface} />;
};

export default PptxSurfaceViewer;
