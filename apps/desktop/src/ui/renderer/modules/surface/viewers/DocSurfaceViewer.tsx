/**
 * DocSurfaceViewer — markdown 文档 viewer
 *
 * file 模式: 通过 neox.readFile / fs.watch 读文件 + 监听变化, agent 改文件后自动刷新.
 * inline 模式: 直接渲染传入字符串.
 *
 * 复用 components/Markdown.tsx, GFM / mermaid / katex / 图片全支持.
 *
 * 工具条 (右上浮动):
 *   [目录 ▾]  [复制] [另存 .md] [导出 PDF]  |  [预览 | 源码]
 *   · 目录: 长文档跳节 — 解析 heading (跳过代码块), 点击 scrollIntoView
 *   · 复制: 复制 markdown 原文
 *   · 另存: saveFileDialog + surfaceWriteFile (inline 产物落盘的唯一出口)
 *   · PDF: 抓取已渲染 DOM (mermaid/katex 都是渲染后的) → exportHtmlToPdf
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeReadonlyView from './CodeReadonlyView';
import type { Surface } from '../../../state/surfaceStore';
import { useVisibilityInterval } from '../../../hooks/useVisibilityInterval';
import { useI18n } from '../../../hooks/useI18n';
import { dispatchHint } from '../../../components/notifyEvents';
import { kbd } from '../../../utils/keymap';
import { PreviewSkeleton } from './previewPerf/PreviewSkeleton';
import { PreviewErrorState } from './previewPerf/PreviewErrorState';
import { ProgressiveMarkdown } from './previewPerf/ProgressiveMarkdown';

interface Props {
  surface: Surface;
  workspacePath?: string;
}

type DocMode = 'preview' | 'source';

interface TocEntry {
  level: number;
  title: string;
  key: string;
}

/** 解析 markdown headings — 跳过 fenced code block 里的 "# ..." 行. */
function parseToc(content: string): TocEntry[] {
  const out: TocEntry[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  let fenceMark = '';
  for (const line of content.split('\n')) {
    const fence = /^(```+|~~~+)/.exec(line.trimStart());
    if (fence) {
      if (!inFence) { inFence = true; fenceMark = fence[1][0]; }
      else if (fence[1][0] === fenceMark) { inFence = false; }
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const title = m[2].replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!title) continue;
    const n = (seen.get(title) ?? 0) + 1;
    seen.set(title, n);
    out.push({ level: m[1].length, title, key: `${title}#${n}` });
  }
  return out;
}

export const DocSurfaceViewer: React.FC<Props> = ({ surface, workspacePath }) => {
  const { isZh } = useI18n();
  const [mode, setMode] = useState<DocMode>('preview');
  const [content, setContent] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const tocWrapRef = useRef<HTMLDivElement>(null);

  const lastMtimeRef = useRef(0);
  const loadDocRef = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    lastMtimeRef.current = 0;
    setLoading(true);
    const fallback =
      typeof surface.metadata?.fallbackContent === 'string'
        ? surface.metadata.fallbackContent
        : undefined;
    const boundWorkspace =
      (typeof surface.metadata?.workspacePath === 'string' && surface.metadata.workspacePath)
      || workspacePath;
    const load = async () => {
      if (surface.source.type === 'inline') {
        if (!cancelled) {
          setContent(surface.source.content);
          setError(null);
          setLoading(false);
        }
        return;
      }
      if (surface.source.type !== 'file') {
        if (!cancelled) {
          setError(isZh ? 'doc surface 仅支持 file 或 inline source' : 'Doc surface only supports file or inline source');
        }
        return;
      }
      try {
        const api = (window as any).neox;
        /* Surface viewer 用 surfaceReadFile; 带上会话 workspace, 切工程也不拒载. */
        const reader = api?.surfaceReadFile ?? api?.readFile;
        if (!reader) {
          if (!cancelled) {
            if (fallback !== undefined) {
              setContent(fallback);
              setError(null);
            } else {
              setError(isZh ? 'neox.surfaceReadFile 不可用' : 'neox.surfaceReadFile unavailable');
            }
          }
          return;
        }
        const readOpts = {
          ...(boundWorkspace ? { workspacePath: boundWorkspace } : {}),
          /* 250ms 轮询只看 mtime: 文件没变时主进程直接回 unchanged, 不把几 MB 正文反复搬过来
           * (大 Markdown 尤其致命 —— 每 250ms 传一遍全文, 主进程和渲染进程都在白烧 CPU)。 */
          ...(lastMtimeRef.current ? { ifChangedSince: lastMtimeRef.current } : {}),
        };
        let result = await reader(surface.source.path, readOpts);
        /* 自愈: 偶发边界拒绝时先 remember 再读一次, 用户无感 */
        if (result?.success === false && /access denied|outside workspace/i.test(String(result.error || ''))) {
          try {
            await api?.surfaceRememberAccess?.({
              path: surface.source.path,
              root: boundWorkspace,
              capability: 'read',
            });
          } catch { /* ignore */ }
          result = await reader(surface.source.path, readOpts);
        }
        if (cancelled) return;
        if (result?.unchanged) {
          setLoading(false);
          return;
        }
        if (result?.success === false) {
          if (fallback !== undefined) {
            setContent(fallback);
            setError(null);
            return;
          }
          /* 不把底层沙箱文案甩给用户 */
          const raw = String(result.error || 'read failed');
          setError(/access denied|outside workspace/i.test(raw)
            ? (isZh ? '文档预览暂时不可用，请稍后重试' : 'Document preview temporarily unavailable')
            : raw);
          setLoading(false);
          return;
        }
        const text = typeof result === 'string' ? result : (result?.content ?? '');
        const mtime = typeof result === 'object' ? (result?.mtimeMs ?? result?.mtime ?? 0) : 0;
        if (mtime && mtime === lastMtimeRef.current) { setLoading(false); return; }
        lastMtimeRef.current = mtime;
        setContent(text);
        setError(null);
        setLoading(false);
        setVersion(v => v + 1);
      } catch (err: any) {
        if (!cancelled) {
          if (fallback !== undefined) {
            setContent(fallback);
            setError(null);
          } else {
            setError(err?.message || String(err));
          }
          setLoading(false);
        }
      }
    };
    loadDocRef.current = load;
    void load();
    return () => { cancelled = true; };
  }, [surface.source, surface.metadata, workspacePath, isZh, reloadNonce]);

  useVisibilityInterval(() => loadDocRef.current(), surface.source.type === 'file' ? 250 : 0);

  const basePath = useMemo(() => {
    if (surface.source.type === 'file') return surface.source.path;
    return undefined;
  }, [surface.source]);

  const toc = useMemo(() => parseToc(content), [content]);

  /* TOC popover: 点外面 / Esc 关 */
  useEffect(() => {
    if (!tocOpen) return;
    const onDown = (e: MouseEvent) => {
      if (tocWrapRef.current?.contains(e.target as Node)) return;
      setTocOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTocOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [tocOpen]);

  /* 跳节 — 在渲染容器里按 heading 文本找元素 (同标题第 n 个). */
  const jumpToHeading = useCallback((entry: TocEntry) => {
    setTocOpen(false);
    if (mode !== 'preview') setMode('preview');
    /* preview 模式切换后 DOM 可能下一帧才有 — rAF 一拍再找 */
    requestAnimationFrame(() => {
      const root = previewRef.current;
      if (!root) return;
      const nth = Number(entry.key.split('#').pop() ?? '1');
      const headings = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'));
      /* 先按精确匹配数第 n 个 (跟 parseToc 的去重口径一致); 全都没中再退回前缀匹配
       * (渲染后的 heading 可能带 anchor 符号等尾巴). */
      let count = 0;
      for (const h of headings) {
        if ((h.textContent || '').trim() === entry.title) {
          count++;
          if (count === nth) {
            h.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
        }
      }
      const prefixHit = headings.find(h => (h.textContent || '').trim().startsWith(entry.title));
      prefixHit?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [mode]);

  const copyMarkdown = useCallback(() => {
    if (!content) return;
    navigator.clipboard.writeText(content).then(
      () => dispatchHint(isZh ? '已复制 Markdown' : 'Markdown copied', 'success'),
      () => dispatchHint(isZh ? '复制失败' : 'Copy failed', 'warning'),
    );
  }, [content, isZh]);

  const saveAsMarkdown = useCallback(async () => {
    if (!content) return;
    try {
      const api = (window as any).neox;
      if (!api?.saveFileDialog || !api?.surfaceWriteFile) {
        dispatchHint(isZh ? '保存能力不可用 (bridge 缺失)' : 'Save unavailable (bridge missing)', 'warning');
        return;
      }
      const base = (surface.source.type === 'file'
        ? surface.source.path.split(/[/\\]/).pop()?.replace(/\.(md|mdx|markdown)$/i, '')
        : surface.title) || 'document';
      const defaultDir = workspacePath?.replace(/\/$/, '');
      const picked = await api.saveFileDialog({
        title: isZh ? '另存为 Markdown' : 'Save as Markdown',
        defaultPath: defaultDir ? `${defaultDir}/${base}.md` : `${base}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All Files', extensions: ['*'] }],
      });
      if (!picked) return;
      const r = await api.surfaceWriteFile(picked, content, { encoding: 'utf-8' });
      if (r?.success === false) {
        dispatchHint((isZh ? '保存失败: ' : 'Save failed: ') + (r.error || ''), 'warning');
        return;
      }
      dispatchHint(isZh ? `已保存: ${picked}` : `Saved: ${picked}`, 'success');
    } catch (e: any) {
      dispatchHint((isZh ? '保存失败: ' : 'Save failed: ') + (e?.message || String(e)), 'warning');
    }
  }, [content, surface.source, surface.title, workspacePath, isZh]);

  /* 导出 PDF — 抓已渲染 DOM (mermaid/katex/代码高亮都是最终形态) → printToPDF.
   * 只在 preview 模式可用 (source 模式没有渲染 DOM). */
  const exportPdf = useCallback(async () => {
    const root = previewRef.current;
    if (!root) {
      dispatchHint(isZh ? '请先切到预览模式再导出 PDF' : 'Switch to preview mode before exporting PDF', 'warning');
      return;
    }
    try {
      const api = (window as any).neox;
      if (!api?.saveFileDialog || !api?.exportHtmlToPdf) {
        dispatchHint(isZh ? '导出能力不可用 (bridge 缺失)' : 'Export unavailable (bridge missing)', 'warning');
        return;
      }
      const base = (surface.source.type === 'file'
        ? surface.source.path.split(/[/\\]/).pop()?.replace(/\.(md|mdx|markdown)$/i, '')
        : surface.title) || 'document';
      const defaultDir = workspacePath?.replace(/\/$/, '');
      const picked = await api.saveFileDialog({
        title: isZh ? '导出 PDF' : 'Export PDF',
        defaultPath: defaultDir ? `${defaultDir}/${base}.pdf` : `${base}.pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }, { name: 'All Files', extensions: ['*'] }],
      });
      if (!picked) return;
      const html = `<!DOCTYPE html>
<html lang="${isZh ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<title>${base}</title>
<style>
  @page { margin: 1.2cm; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif;
    font-size: 14px; line-height: 1.7; color: #1a1a1a; margin: 0; padding: 0;
  }
  h1, h2, h3, h4, h5, h6 { font-weight: 600; margin: 1.2em 0 0.5em; line-height: 1.3; }
  h1 { font-size: 24px; } h2 { font-size: 20px; } h3 { font-size: 17px; }
  p { margin: 0.6em 0; }
  ul, ol { padding-left: 1.6em; margin: 0.6em 0; }
  a { color: #6366f1; }
  /* ⚠️ 标题被 rehype-autolink-headings 包了一层 <a> (behavior: wrap) —— 不还原颜色的话
   * PDF 里从大标题到每个章标题全是蓝色带下划线, 像一页链接目录 (2026-09-13 实拍)。 */
  h1 a, h2 a, h3 a, h4 a, h5 a, h6 a { color: inherit; text-decoration: none; }
  /* 表格按 Apple 那套: 大圆角容器 + 只留横向发丝线 + 表头不填色。
   * 原先是"每格都画线 + 灰底表头"的网格表, 导出的 PDF 一眼就是 Excel 相。 */
  table {
    width: 100%; margin: 1.1em 0; font-size: 13px;
    border-collapse: separate; border-spacing: 0;
    border: 1px solid rgba(26,26,26,.10); border-radius: 12px; overflow: hidden;
  }
  th, td { border: 0; padding: 10px 14px; text-align: left; vertical-align: top; font-variant-numeric: tabular-nums; }
  th { background: transparent; font-size: 12px; font-weight: 590; color: #5b6270; border-bottom: 1px solid rgba(26,26,26,.11); }
  tbody tr + tr td { border-top: 1px solid rgba(26,26,26,.07); }
  tbody td:first-child { color: #1a1a1a; font-weight: 510; }
  img, svg { max-width: 100%; height: auto; }
  blockquote { border-left: 3px solid #6366f1; padding: 4px 0 4px 12px; margin: 1em 0; color: #525252; }
  code { font-family: "JetBrains Mono", monospace; font-size: 0.9em; background: #f4f4f5; padding: 1px 5px; border-radius: 3px; }
  pre { background: #f4f4f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  .md-code-copy, button { display: none !important; }

  /* ── 报告皮肤 + 图表配色 (2026-09-13) ───────────────────────────────────
   * 这里导出的是**已渲染 DOM**, 但一条应用 CSS 都不会跟着走 —— 图表的填色全部写成
   * var(--nchart-c1) 这类变量, 不把变量带上就等于没有颜色; 题注/来源行/双栏插图/
   * 报告表格也会掉回浏览器默认样式。所以凡是报告用到的那几条, 这里都要有一份。 */
  :root {
    --nchart-c1: #4f7cff; --nchart-c2: #eb6834; --nchart-c3: #1baf7a;
    --nchart-c4: #eda100; --nchart-c5: #e87ba4; --nchart-c6: #4a3aa7;
    --neox-bg-card: #ffffff;
    --neox-fg-primary: #1a1a1a; --neox-fg-secondary: #5b6270; --neox-fg-tertiary: #8a919e;
    --ncard-fs-sub: 0.88em; --ncard-fs-meta: 0.82em;
  }
  /* 图要有块感: 极淡的分组底 + 大圆角, 把它从正文里托起来 (不然图沉进段落里) */
  .ncard--chart.nchart--report {
    background: rgba(26,26,26,.03); border: 1px solid rgba(26,26,26,.06);
    border-radius: 14px; padding: 14px 16px 10px; margin: 2px 0 4px;
  }
  .nx-figcap { margin: 22px 0 8px; font-size: 13px; font-weight: 650; color: #1a1a1a; }
  .nx-fignote { margin: 10px 0 2px; font-size: 13px; line-height: 1.75; color: #5b6270; }
  .nx-figsrc { margin: 6px 0 18px; font-size: 12px; line-height: 1.6; color: #8a919e; }
  .nx-figs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin: 16px 0; }
  .nchart__plot svg, .nchart__cloud svg { width: 100%; height: auto; display: block; }
  .nchart__grid { stroke: rgba(26,26,26,.08); stroke-width: 1; }
  .nchart__axis { stroke: rgba(26,26,26,.12); stroke-width: 1; }
  .nchart__tick, .nchart__cat { font-size: 12px; fill: #8a919e; }
  .nchart__col-val { font-size: 12px; font-weight: 500; fill: #5b6270; }
  .nchart__unit { font-size: 12px; fill: #8a919e; }
  .nchart__delta { font-size: 12px; font-weight: 600; fill: #5b6270; }
  .nchart__pie { display: flex; align-items: center; justify-content: center; gap: 26px; }
  .nchart__pie-box, .nchart__pie-svg { width: 176px; height: 176px; }
  .nchart__pie-slice { stroke: #fff; stroke-width: 2.5; }
  .nchart__legend { list-style: none; margin: 0; padding: 0; max-width: 300px; }
  .nchart__legend li { display: flex; align-items: center; gap: 10px; margin: 6px 0; font-size: 13px; }
  .nchart__legend i { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .nchart__legend-val { margin-left: auto; color: #8a919e; }
  .nchart__legend--top { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 6px; padding: 0; max-width: none; }
  .nchart__legend--top li { display: flex; align-items: center; gap: 7px; margin: 0; font-size: 12px; color: #5b6270; }
  .nchart__legend--top i { width: 9px; height: 9px; border-radius: 3px; flex: none; }
  .nchart__line-path { fill: none; stroke: #4f7cff; stroke-width: 2; }
  .nchart__line-area { fill: rgba(79,124,255,.10); stroke: none; }
  .nchart__line-dot { fill: #4f7cff; stroke: #fff; stroke-width: 1.5; }
  /* 信息图形状: 相邻层之间靠一道底色缝分开 (不画深色边框) —— 不带这条 PDF 里各层会糊成一块 */
  .nchart__stackfig-band, .nchart__targetfig-ring { stroke: #fff; stroke-width: 2; }
  .nchart__stackfig .nchart__cat, .nchart__targetfig .nchart__cat { text-anchor: start; fill: #1a1a1a; }
  .nchart__stackfig .nchart__col-val, .nchart__targetfig .nchart__col-val { text-anchor: start; }
  .nchart__cloud-w--t0 { fill: #4f7cff; font-weight: 650; }
  .nchart__cloud-w--t1 { fill: #4a5a8a; font-weight: 550; }
  .nchart__cloud-w--t2 { fill: #8a919e; font-weight: 450; }
  /* 时间线 —— 这份内联样式里原来一条都没有 (2026-09-13 实拍), 导出 PDF 时整张图退化成
     无缩进的裸列表。报告里它是"一条轨道": 时间独立成左列, 轴加粗, 首末节点实心。 */
  .ntl__list { list-style: none; margin: 0; padding: 0; }
  .ntl__it { display: grid; grid-template-columns: 76px 20px 1fr; gap: 0 14px; padding: 11px 0; align-items: start; position: relative; }
  .ntl__it::before { content: ''; position: absolute; left: 99px; top: 30px; bottom: -11px; width: 2px; background: rgba(79,124,255,.3); }
  .ntl__it:last-child::before { display: none; }
  .ntl__when { font-size: 13px; text-align: right; padding-top: 2px; color: #5b6270; white-space: nowrap; }
  .ntl__glyph { width: 20px; height: 20px; margin-top: 1px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: rgba(79,124,255,.14); color: #4f7cff; }
  .ntl__it.is-edge .ntl__glyph { background: #4f7cff; color: #fff; }
  .ntl__body { min-width: 0; }
  .ntl__title { font-size: 14px; font-weight: 600; color: #1a1a1a; line-height: 1.45; }
  .ntl__desc { margin-top: 3px; font-size: 13px; color: #5b6270; line-height: 1.5; }
  .nhead, .ncard__figure > .nhead { display: none; }   /* 卡头在报告里是重复的题注 */

  /* ── 分页 ── 一张图或一张表被切到两页上, 是导出 PDF 最常见的难看法 */
  @media print {
    .ncard-wrap, .nx-fig, .md-table-wrapper, table { break-inside: avoid; page-break-inside: avoid; }
    tr, .nchart__plot { break-inside: avoid; page-break-inside: avoid; }
    h1, h2, h3, .nx-figcap { break-after: avoid; page-break-after: avoid; }
    h2 { break-before: auto; margin-top: 1.6em; }
  }
</style>
</head>
<body>${root.innerHTML}</body>
</html>`;
      const r = await api.exportHtmlToPdf(html, picked);
      if (r?.success === false) {
        dispatchHint((isZh ? '导出失败: ' : 'Export failed: ') + (r.error || ''), 'warning');
        return;
      }
      dispatchHint(isZh ? `已导出 PDF: ${picked}` : `PDF exported: ${picked}`, 'success');
    } catch (e: any) {
      dispatchHint((isZh ? '导出失败: ' : 'Export failed: ') + (e?.message || String(e)), 'warning');
    }
  }, [surface.source, surface.title, workspacePath, isZh]);

  const previewFileSourcePath = surface.source.type === 'file' ? surface.source.path : null;
  if (error) {
    /* 文件被删 / 挪走是最常见的情况 (临时目录里写的方案, 过几天就清了) —— 说人话, 原始报错折成小字 */
    return (
      <PreviewErrorState
        rawError={error}
        isZh={isZh}
        onRetry={() => { setError(null); setReloadNonce(n => n + 1); }}
        onOpenExternal={previewFileSourcePath ? () => {
          setExternalError(null);
          void (async () => {
            try {
              const r = await (window as any).neox?.surfaceOpenExternal?.(previewFileSourcePath);
              if (r?.success === false) setExternalError(r.error || (isZh ? '打开失败' : 'failed to open'));
            } catch (err: any) {
              setExternalError(err?.message || String(err));
            }
          })();
        } : undefined}
        externalError={externalError}
      />
    );
  }
  if (!content) {
    if (loading) return <PreviewSkeleton kind="doc" label={isZh ? '正在加载文档…' : 'Loading document…'} />;
    return (
      <div className="sfc-empty">
        <div className="sfc-empty__title">{isZh ? '空文档' : 'Empty document'}</div>
      </div>
    );
  }

  const toolIcon = (path: React.ReactNode) => (
    <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {path}
    </svg>
  );

  return (
    <div className="sfc-doc-wrap">
      {/* 工具条 — 右上 absolute 浮 chip; chrome bar 在它上方一层, 不会冲突 */}
      <div className="sfc-doc__mode" role="toolbar" aria-label={isZh ? '文档工具' : 'Document tools'}>
        {toc.length >= 3 && (
          <div className="sfc-doc__toc-wrap" ref={tocWrapRef}>
            <button
              type="button"
              className={`sfc-doc__mode-btn sfc-doc__toc-btn${tocOpen ? ' is-active' : ''}`}
              onClick={() => setTocOpen(o => !o)}
              title={isZh ? '目录 — 跳转到章节' : 'Table of contents — jump to a section'}
              aria-expanded={tocOpen}
              aria-haspopup="menu"
            >
              {toolIcon(<><path d="M5 3.5 H12" /><path d="M5 7 H12" /><path d="M5 10.5 H12" /><circle cx="2.5" cy="3.5" r=".7" fill="currentColor" stroke="none" /><circle cx="2.5" cy="7" r=".7" fill="currentColor" stroke="none" /><circle cx="2.5" cy="10.5" r=".7" fill="currentColor" stroke="none" /></>)}
              <span>{isZh ? '目录' : 'TOC'}</span>
            </button>
            {tocOpen && (
              <div className="sfc-doc__toc-menu" role="menu">
                {toc.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    role="menuitem"
                    className={`sfc-doc__toc-item sfc-doc__toc-item--l${Math.min(entry.level, 4)}`}
                    onClick={() => jumpToHeading(entry)}
                    title={entry.title}
                  >
                    {entry.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          className="sfc-doc__mode-btn"
          onClick={copyMarkdown}
          title={isZh ? '复制 Markdown 原文' : 'Copy raw Markdown'}
          aria-label={isZh ? '复制' : 'Copy'}
        >
          {toolIcon(<><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" /><path d="M2.5 9.5V3a1 1 0 0 1 1-1H9" /></>)}
        </button>
        <button
          type="button"
          className="sfc-doc__mode-btn"
          onClick={() => void saveAsMarkdown()}
          title={isZh ? '另存为 .md 文件' : 'Save as .md file'}
          aria-label={isZh ? '另存为' : 'Save as'}
        >
          {toolIcon(<><path d="M2.5 2.5 H9.5 L11.5 4.5 V11.5 H2.5 Z" /><path d="M4.5 2.5 V5.5 H8.5 V2.5" /><rect x="4.5" y="8" width="5" height="3.5" /></>)}
        </button>
        <button
          type="button"
          className="sfc-doc__mode-btn"
          onClick={() => void exportPdf()}
          disabled={mode !== 'preview'}
          title={mode === 'preview'
            ? (isZh ? '按当前渲染效果导出 PDF' : 'Export the rendered view as PDF')
            : (isZh ? '切到预览模式后可导出 PDF' : 'Switch to preview to export PDF')}
          aria-label={isZh ? '导出 PDF' : 'Export PDF'}
        >
          {toolIcon(<><path d="M7 2 V9" /><path d="M4.5 6.5 L7 9 L9.5 6.5" /><path d="M2.5 11.5 H11.5" /></>)}
          <span>PDF</span>
        </button>
        <span className="sfc-doc__mode-divider" aria-hidden="true" />
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'preview'}
          className={`sfc-doc__mode-btn${mode === 'preview' ? ' is-active' : ''}`}
          onClick={() => setMode('preview')}
          title={isZh ? '渲染预览' : 'Rendered preview'}
        >{isZh ? '预览' : 'Preview'}</button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'source'}
          className={`sfc-doc__mode-btn${mode === 'source' ? ' is-active' : ''}`}
          onClick={() => setMode('source')}
          title={isZh ? `源码 (Monaco · 支持 ${kbd('mod+f')} 搜索 / 行号 / 跳转)` : `Source (Monaco · ${kbd('mod+f')} search / line numbers)`}
        >{isZh ? '源码' : 'Source'}</button>
      </div>

      {mode === 'preview' ? (
        <div className="sfc-doc" key={version} ref={previewRef}>
          <ProgressiveMarkdown content={content} basePath={basePath} workspacePath={workspacePath} />
        </div>
      ) : (
        <div className="sfc-doc-source">
          <CodeReadonlyView content={content} language="markdown" />
        </div>
      )}
    </div>
  );
};

export default DocSurfaceViewer;
