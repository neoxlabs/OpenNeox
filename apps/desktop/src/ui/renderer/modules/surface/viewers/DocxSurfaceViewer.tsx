/**
 * DocxSurfaceViewer — .docx 高保真只读 viewer.
 *
 *   首选 docx-preview 高保真渲染 (保留样式/分页/图片/表格).
 *   如果第三方解析器碰到边缘 OOXML 崩溃, 自动降级到 mammoth 语义 HTML;
 *   如果文件只是错误地写成 .docx 扩展名, 按文本预览并明确提示.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Surface } from '../../../state/surfaceStore';
import { useNeoxRuntime } from '../../../app/NeoxRuntimeContext';
import { useSurfaceFileLock } from '../../../hooks/useSurfaceFileLock';
import { useVisibilityInterval } from '../../../hooks/useVisibilityInterval';
import { useI18n } from '../../../hooks/useI18n';
import { KindHomeView } from './KindHomeView';
import { useAutoReloadOnFsChange } from './useAutoReloadOnFsChange';
import { PreviewSkeleton } from './previewPerf/PreviewSkeleton';
import { PreviewErrorState } from './previewPerf/PreviewErrorState';
import { peekDocxText } from './previewPerf/docxFastPeek';
import './previewPerf/docxFastPeek.css';
import { retryLabel, retryOrReload } from './staleModule';

/** 等某个元素真的进了 DOM (React 提交完成) 再开始重活 —— 否则 docx-preview
 *  的同步解析会把这段时间的主线程占满, setState 的文字根本来不及上屏。 */
async function waitForDom(selector: string, timeoutMs = 1200): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (document.querySelector(selector)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
}

interface Props {
  surface: Surface;
}

let docxPreviewPromise: Promise<typeof import('docx-preview')> | null = null;
const loadDocxPreview = () => {
  if (!docxPreviewPromise) {
    docxPreviewPromise = import('docx-preview');
  }
  return docxPreviewPromise;
};

let mammothPromise: Promise<any> | null = null;
const loadMammoth = () => {
  if (!mammothPromise) {
    mammothPromise = import('mammoth/mammoth.browser.js' as any).then((m: any) => m.default ?? m);
  }
  return mammothPromise;
};

type RenderMode = 'native' | 'compat' | 'plain';

interface RenderNotice {
  mode: RenderMode;
  title: string;
  detail?: string;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const normalized = base64.replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
  const bin = atob(normalized);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

function fileNameOf(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

function extOf(title: string): string {
  const base = fileNameOf(title).toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1) : '';
}

function isZipLike(buffer: ArrayBuffer): boolean {
  const view = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4));
  return view.length >= 2 && view[0] === 0x50 && view[1] === 0x4b;
}

function isOleDocLike(buffer: ArrayBuffer): boolean {
  const view = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8));
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return ole.every((b, i) => view[i] === b);
}

function decodeLikelyText(buffer: ArrayBuffer): string | null {
  if (buffer.byteLength === 0) return '';
  const bytes = new Uint8Array(buffer);
  const sample = bytes.slice(0, Math.min(bytes.length, 4096));
  let printable = 0;
  let control = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127)) printable++;
    else control++;
  }
  if (printable / Math.max(1, printable + control) < 0.86) return null;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function clearNode(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderCompatHtml(container: HTMLElement, html: string, isZh: boolean): void {
  clearNode(container);
  const article = document.createElement('article');
  article.className = 'sfc-docx-compat';
  article.innerHTML = html || `<p>${isZh ? '文档没有可提取文本。' : 'No extractable text in this document.'}</p>`;
  container.appendChild(article);
}

function renderPlainText(container: HTMLElement, text: string, title: string, isZh: boolean): void {
  clearNode(container);
  const article = document.createElement('article');
  article.className = 'sfc-docx-plain';

  const heading = document.createElement('div');
  heading.className = 'sfc-docx-plain__title';
  heading.textContent = title;

  const pre = document.createElement('pre');
  pre.textContent = text || (isZh ? '文件为空。' : 'File is empty.');

  article.appendChild(heading);
  article.appendChild(pre);
  container.appendChild(article);
}

const SingleDocxView: React.FC<Props> = ({ surface }) => {
  const { isZh } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<RenderNotice | null>(null);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  /* 首屏快速文字预览 (S-05): docx-preview 第一页出来前先给几段正文, 出了就撤 */
  const [peekLines, setPeekLines] = useState<string[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lockPath = surface.source.type === 'file' ? surface.source.path : null;
  const fileLock = useSurfaceFileLock(lockPath, surface.id);
  useAutoReloadOnFsChange(lockPath, useCallback(() => setRetryNonce((n) => n + 1), []));
  const title = surface.title || (lockPath ? fileNameOf(lockPath) : 'Word');
  const ext = (lockPath ? extOf(lockPath) : '') || extOf(title);

  const lastMtimeRef = useRef(0);
  const loadDocxRef = useRef<() => void>(() => {});

  const openExternal = async () => {
    if (!lockPath) return;
    setExternalError(null);
    try {
      const api = (window as any).neox;
      const opener = api?.surfaceOpenExternal;
      if (!opener) {
        setExternalError(isZh ? 'surfaceOpenExternal bridge 不可用' : 'surfaceOpenExternal bridge unavailable');
        return;
      }
      const result = await opener(lockPath);
      if (result?.success === false) setExternalError(result.error || (isZh ? '打开失败' : 'failed to open'));
    } catch (err: any) {
      setExternalError(err?.message || String(err));
    }
  };

  useEffect(() => {
    let cancelled = false;
    lastMtimeRef.current = 0;
    setPeekLines(null);

    const loadAndRender = async () => {
      try {
        let arrayBuffer: ArrayBuffer;
        let mtime = 0;
        if (surface.source.type === 'file') {
          const path = surface.source.path;
          const api = (window as any).neox;
          const reader = api?.surfaceReadFile;
          if (!reader) {
            if (!cancelled) {
              setError(isZh ? 'surfaceReadFile bridge 不可用' : 'surfaceReadFile bridge unavailable');
              setLoading(false);
            }
            return;
          }
          const result = await reader(path, { encoding: 'base64', ifChangedSince: lastMtimeRef.current || undefined });
          if (cancelled || result?.unchanged) return;
          if (result?.success === false) {
            setError(result.error || 'read failed');
            setLoading(false);
            return;
          }
          const base64 = typeof result === 'string' ? result : (result?.content ?? '');
          mtime = typeof result === 'object' ? (result?.mtimeMs ?? result?.mtime ?? 0) : 0;
          if (mtime && mtime === lastMtimeRef.current) return;
          if (!base64) {
            setError(isZh ? '文件为空或读取失败' : 'File is empty or could not be read');
            setLoading(false);
            return;
          }
          arrayBuffer = base64ToArrayBuffer(base64);
        } else if (surface.source.type === 'inline') {
          if (lastMtimeRef.current === -1) return;
          lastMtimeRef.current = -1;
          try {
            arrayBuffer = base64ToArrayBuffer(surface.source.content);
          } catch {
            setError(isZh ? 'inline content 不是有效 base64 .docx' : 'Inline content is not a valid base64 .docx');
            setLoading(false);
            return;
          }
        } else {
          setError(isZh ? 'docx surface 仅支持 file 或 inline source' : 'Docx surfaces only support file or inline sources');
          setLoading(false);
          return;
        }

        const container = containerRef.current;
        if (!container) return;
        const firstRender = !container.hasChildNodes();
        const keepScroll = container.scrollTop;
        if (firstRender) setLoading(true);
        setError(null);
        setNotice(null);
        setExternalError(null);
        container.classList.remove('sfc-docx__scroll--compat', 'sfc-docx__scroll--plain');


        if (ext === 'doc' || isOleDocLike(arrayBuffer)) {
          setError(isZh
            ? '旧版 .doc 是二进制 Office 格式。请把这个标签关掉, 在文件树上双击 (Neox 会自动用 LibreOffice 转换预览); 或点下方「系统应用打开」。'
            : 'Legacy .doc is a binary Office format. Close this tab and double-click the file in the tree (Neox converts it via LibreOffice), or use "Open in system app" below.');
          setLoading(false);
          if (mtime) lastMtimeRef.current = mtime;
          return;
        }

        if (!isZipLike(arrayBuffer)) {
          const text = decodeLikelyText(arrayBuffer);
          if (text !== null) {
            container.classList.add('sfc-docx__scroll--plain');
            renderPlainText(container, text, title, isZh);
            setNotice({
              mode: 'plain',
              title: isZh ? '这不是有效 Word 包，已按文本预览' : 'Not a valid Word package — showing as plain text',
              detail: isZh
                ? '文件扩展名是 .docx，但内容不是 OOXML/Zip。需要真正的 Word 文件时，应通过 Word 创建工具或 Office/WPS 导出。'
                : 'The extension is .docx but the content is not OOXML/Zip. For a real Word file, export from the Word tool or Office/WPS.',
            });
            setLoading(false);
            if (mtime) lastMtimeRef.current = mtime;
            return;
          }
          setError(isZh ? '这不是有效 .docx 文件：未检测到 OOXML/Zip 结构。' : 'Not a valid .docx file: no OOXML/Zip structure detected.');
          setLoading(false);
          if (mtime) lastMtimeRef.current = mtime;
          return;
        }

        if (firstRender) {
          const lines = await peekDocxText(arrayBuffer);
          if (cancelled) return;
          if (lines.length > 0) {
            setPeekLines(lines);
            /* 文字已经能看了 —— 骨架让位, 不等第一页排版 */
            setLoading(false);
            await waitForDom('.sfc-docx-peek');
            if (cancelled) return;
          }
        }

        let nativeError: unknown = null;
        try {
          const docxPreview = await loadDocxPreview();
          if (cancelled) return;
          /* 首屏直渲 (S-05): 容器里还没有内容时, 直接画进可见容器 —— docx-preview 是逐页
           * 追加 DOM 的, 用户第一页出现就能看, 不必等整份文档画完 (大文档全量要好几分钟)。
           * 已有内容时仍然屏外画完再整体换上, 避免滚动位置被拽回顶上。 */
          const stage = document.createElement('div');
          stage.className = container.className;
          stage.style.cssText = 'position:fixed;left:-100000px;top:0;width:' + (container.clientWidth || 800) + 'px;visibility:hidden;pointer-events:none';
          if (!firstRender) document.body.appendChild(stage);
          const target = firstRender ? container : stage;
          let revealObserver: MutationObserver | null = null;
          if (firstRender) {
            /* 第一页一出现就撤骨架 —— 不等 renderAsync 整体完成 */
            revealObserver = new MutationObserver(() => {
              if (container.childElementCount > 0) {
                setLoading(false);
                setPeekLines(null);
              }
            });
            revealObserver.observe(container, { childList: true });
          }
          try {
          await docxPreview.renderAsync(arrayBuffer, target, undefined, {
            className: 'sfc-docx-page',
            inWrapper: true,
            ignoreWidth: true,
            ignoreHeight: true,
            ignoreFonts: false,
            breakPages: false,
            ignoreLastRenderedPageBreak: true,
            experimental: true,
            renderHeaders: false,
            renderFooters: false,
            renderFootnotes: true,
            renderEndnotes: true,
          });
          if (cancelled) return;
          /* 表格按纸宽排: Word 里的表格带固定宽度 (tblW / 每格 w), 右栏一窄纸跟着窄, 表格不变 → 右边几列被裁 (QA P2-5)。
           * 预览不求逐像素, 去掉固定宽度交给浏览器按内容分列宽 */
          for (const table of Array.from(target.querySelectorAll('table'))) {
            table.style.width = '100%';
            table.style.maxWidth = '100%';
            table.style.tableLayout = 'auto';
            for (const cell of Array.from(table.querySelectorAll('td, th, col'))) (cell as HTMLElement).style.width = '';
          }
          /* 点线样式是 docx-preview 量完版面后异步补的, 所以按目录段落样式 (xxx_toc1) 认, 稍后再补一遍 */
          const markToc = (root: ParentNode) => {
            for (const tab of Array.from(root.querySelectorAll<HTMLElement>('[class$="-tab-stop"]'))) {
              const p = tab.closest('p');
              if (!p) continue;
              /* 项目符号后的制表位: 应该只跳到悬挂缩进处 (十几 pt), docx-preview 量成 34pt, 「·」和正文中间空一大截 */
              const hang = -parseFloat(p.style.textIndent || '0');
              if (hang > 0 && /^[·•●○■◆▪\-–\d.()（）]{1,4}$/.test((tab.parentElement?.textContent ?? '').replace(/\s/g, ''))) {
                tab.style.setProperty('--nx-hang', `${Math.max(2, hang - 6)}pt`);
                tab.classList.add('nx-docx-bullet-tab'); /* docx-preview 之后还会重算 word-spacing, 交给 CSS !important 压住 */
                continue;
              }
              if (!(/_toc\d/i.test(p.className) || /dotted|dashed/.test(tab.style.textDecoration))) continue;
              p.classList.add('nx-docx-toc-line');
              tab.parentElement?.classList.add('nx-docx-toc-tail');
              tab.classList.add('nx-docx-toc-leader');
            }
          };
          markToc(target);
          window.setTimeout(() => markToc(container), 400);
          if (!firstRender) container.replaceChildren(...Array.from(stage.childNodes));
          } finally {
            revealObserver?.disconnect();
            stage.remove();
          }
          if (!firstRender) container.scrollTop = keepScroll;
          setNotice(null);
        } catch (err) {
          nativeError = err;
          try {
            const mammoth = await loadMammoth();
            if (cancelled) return;
            const result = await mammoth.convertToHtml({ arrayBuffer });
            container.classList.add('sfc-docx__scroll--compat');
            renderCompatHtml(container, result?.value ?? '', isZh);
            setNotice({
              mode: 'compat',
              title: isZh ? '已切换到兼容预览' : 'Switched to compatibility preview',
              detail: isZh
                ? `高保真 Word 渲染器无法解析这个文件：${(nativeError as any)?.message || String(nativeError)}。当前展示文本、标题、列表、表格等主要内容。`
                : `The high-fidelity Word renderer could not parse this file: ${(nativeError as any)?.message || String(nativeError)}. Showing text, headings, lists and tables.`,
            });
          } catch (compatErr: any) {
            clearNode(container);
            setError(isZh
              ? `Word 预览失败：${(nativeError as any)?.message || String(nativeError)}\n兼容预览也失败：${compatErr?.message || String(compatErr)}`
              : `Word preview failed: ${(nativeError as any)?.message || String(nativeError)}\nCompatibility preview also failed: ${compatErr?.message || String(compatErr)}`);
            setLoading(false);
            if (mtime) lastMtimeRef.current = mtime;
            return;
          }
        }
        if (cancelled) return;
        setLoading(false);
        setError(null);
        if (mtime) lastMtimeRef.current = mtime;
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || String(err));
          setLoading(false);
        }
      }
    };

    loadDocxRef.current = loadAndRender;
    void loadAndRender();
    return () => { cancelled = true; };
  }, [surface.source, retryNonce]);

  useVisibilityInterval(() => loadDocxRef.current(), surface.source.type === 'file' ? 250 : 0);

  return (
    <div className="sfc-docx" style={{ position: 'relative' }}>
      {!fileLock.owned && fileLock.conflictWith && (
        <div className="sfc-lock-banner">
          <span>{isZh
            ? `⚠ 已被另一会话编辑 (surface: ${fileLock.conflictWith.slice(0, 8)}…), 你的修改可能被覆盖`
            : `⚠ Being edited in another session (surface: ${fileLock.conflictWith.slice(0, 8)}…) — your changes may be overwritten`}</span>
          <button type="button" onClick={fileLock.takeOver}>{isZh ? '强制接管' : 'Take over'}</button>
        </div>
      )}
      {loading && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex' }}>
          <PreviewSkeleton kind="docx" label={isZh ? '正在加载 Word 文档…' : 'Loading Word document…'} />
        </div>
      )}
      {error && (
        <PreviewErrorState
          rawError={error}
          isZh={isZh}
          onRetry={() => retryOrReload(error, () => setRetryNonce((n) => n + 1))}
          onOpenExternal={lockPath ? () => { void openExternal(); } : undefined}
          externalError={externalError}
          retryLabel={retryLabel(error, isZh)}
        />
      )}
      {peekLines && peekLines.length > 0 && (
        <div className="sfc-docx-peek" role="status" aria-label={isZh ? '正在排版，先显示正文文字' : 'Formatting — showing text first'}>
          <div className="sfc-docx-peek__inner">
            {peekLines.map((line, i) => <p key={i}>{line}</p>)}
            <p className="sfc-docx-peek__more">{isZh ? '正在排版完整版…' : 'Formatting the full document…'}</p>
          </div>
        </div>
      )}
      {!loading && !error && notice && (
        <div className={`sfc-docx__notice sfc-docx__notice--${notice.mode}`}>
          <span className="sfc-docx__notice-badge">
            {notice.mode === 'compat' ? (isZh ? '兼容' : 'Compat') : notice.mode === 'plain' ? (isZh ? '文本' : 'Text') : (isZh ? '预览' : 'Preview')}
          </span>
          <span className="sfc-docx__notice-title">{notice.title}</span>
          {notice.detail && <span className="sfc-docx__notice-detail">{notice.detail}</span>}
          {lockPath && (
            <button
              type="button"
              className="sfc-docx__notice-action"
              onClick={() => { void openExternal(); }}
            >{isZh ? '系统应用打开' : 'Open in system app'}</button>
          )}
        </div>
      )}
      <div
        ref={containerRef}
        className="sfc-docx__scroll"
        style={{ display: error ? 'none' : undefined, visibility: loading && !error ? 'hidden' : undefined }}
      />
    </div>
  );
};

export const DocxSurfaceViewer: React.FC<Props> = ({ surface }) => {
  const { activeSession, workspacePath } = useNeoxRuntime();
  const sessionId = activeSession?.id ?? '';

  const tabs = useMemo(() => {
    const raw = (surface.metadata?.tabs as Array<{ id: string; url: string; title?: string }> | undefined);
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
    return <KindHomeView kind="docx" sessionId={sessionId} surfaceId={surface.id} workspacePath={workspacePath} />;
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

  return <SingleDocxView key={activeTab.url} surface={fakeSurface} />;
};

export default DocxSurfaceViewer;
