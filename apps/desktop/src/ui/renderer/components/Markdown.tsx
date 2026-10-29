import { useI18n } from '../hooks/useI18n';
import { dispatchHint } from './notifyEvents';
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
/* 放大图 / 浮层开在操作发生的那个窗口 (文档可能在 Surface 独立窗口里) */
import { interactionDoc } from '../utils/ownerDoc';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { splitMarkdownBlocks } from './markdownBlocks';
import { createHeadKeyTracker, type HeadKeyTracker } from './markdownHeadKey';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownGfmOptions } from '../utils/markdownGfm';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { visit } from 'unist-util-visit';
import { NeoxCard, CHART_SUBTYPES } from './NeoxCards';
import { PLUGIN_STORE_LINK, openPluginInStore } from '../pages/plugins/pluginFocus';
import { isPreviewablePath } from '../state/openSurfaceFromPath';
import { useAgentModeVariant } from '../hooks/useAgentModeVariant';
import { FileTypeIcon } from './FileTypeIcon';
import { escapeUnknownHtmlTags } from './escapeUnknownHtmlTags';
import { normalizeLooseLists } from './normalizeLooseLists';
import { normalizeMath } from './normalizeMath';
import { remarkSoftBreaks } from './remarkSoftBreaks';
import { rehypeStatusMarks } from './rehypeStatusMarks';
import { settleOrphanInsets } from './orphanInsets';
import { CopyIconButton, tableToClipboard } from './CopyIconButton';

import 'katex/dist/katex.min.css';

/* ═══════════════════════════════════════════════════════════════════
 * 路径解析 — 把 .md 里的相对路径转成 neox-asset:// URL
 * ═══════════════════════════════════════════════════════════════════ */

// RFC 3986 scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ). 一定要带 `-`,
// 不然像 `neox-asset:` 这种带连字符的 scheme 会被误判为相对路径,
// 然后 normalizePath 把 `//` 压成 `/`, 生成双前缀的破 URL.
const ABSOLUTE_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

const normalizePath = (value: string): string => {
  const normalized = value.replace(/\\/g, '/');
  const isAbsolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
  const parts = normalized.split('/');
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop();
      continue;
    }
    stack.push(part);
  }

  const joined = stack.join('/');
  if (/^[A-Za-z]:$/.test(stack[0] || '')) return joined;
  return isAbsolute ? '/' + joined : joined;
};

const dirnameOf = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : normalized;
};

const toNeoxAssetUrl = absoluteToAssetUrl;

const resolveMarkdownFilePath = (url: string | undefined, basePath?: string, workspacePath?: string): string | undefined => {
  if (!url || ABSOLUTE_URL_RE.test(url) || !basePath) return undefined;
  if (url.startsWith('/')) {
    return workspacePath ? normalizePath(workspacePath + '/' + url.slice(1)) : undefined;
  }
  return normalizePath(dirnameOf(basePath) + '/' + url);
};

const resolveMarkdownUrl = (url: string | undefined, basePath?: string, workspacePath?: string): string | undefined => {
  const localPath = resolveMarkdownFilePath(url, basePath, workspacePath);
  if (localPath) return toNeoxAssetUrl(localPath);
  return url;
};

/* ═══════════════════════════════════════════════════════════════════
 * URL 白名单 — react-markdown v10 默认只放行 http/https/mailto/tel, 其它
 * 协议(包括我们的 neox-asset://)会被直接清成 "". 这里把本地协议也放行.
 * ═══════════════════════════════════════════════════════════════════ */

const markdownUrlTransform = (url: string): string => {
  if (!url) return url;
  if (url.startsWith('neox-asset:') || url.startsWith('file:') || url.startsWith('data:') || url.startsWith('blob:')) {
    return url;
  }
  /* 只放行「在插件页打开某插件」这一种 neox:// 链接 (plugin_store_search 给的), 其它 neox:// 照旧清掉 */
  if (PLUGIN_STORE_LINK.test(url)) return url;
  return defaultUrlTransform(url);
};

/* ═══════════════════════════════════════════════════════════════════
 * rehype 插件: 同步改写 img / a 的本地路径为 neox-asset:// URL
 *   — 无论是 markdown ![]() 还是 raw HTML <img>, 只要进 hast 都被捕获
 * ═══════════════════════════════════════════════════════════════════ */

function rehypeRewriteLocalLinks({ basePath, workspacePath }: { basePath?: string; workspacePath?: string }) {
  return (tree: any) => {
    visit(tree, 'element', (node: any) => {
      if (!node?.properties) return;
      if (node.tagName === 'img' && typeof node.properties.src === 'string') {
        const rewritten = resolveMarkdownUrl(node.properties.src, basePath, workspacePath);
        if (rewritten) node.properties.src = rewritten;
      } else if (node.tagName === 'a' && typeof node.properties.href === 'string') {
        const rewritten = resolveMarkdownUrl(node.properties.href, basePath, workspacePath);
        if (rewritten) node.properties.href = rewritten;
      }
    });
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * rehype 插件: GitHub-style alerts
 *   > [!NOTE]
 *   > content
 * 转成 <div class="md-alert md-alert-note">...</div>
 * ═══════════════════════════════════════════════════════════════════ */

function rehypeGithubAlerts() {
  return (tree: any) => {
    visit(tree, 'element', (node: any) => {
      if (node.tagName !== 'blockquote' || !Array.isArray(node.children)) return;

      const firstElement = node.children.find((c: any) => c?.type === 'element' && c.tagName === 'p');
      if (!firstElement) return;

      const pChildren: any[] = firstElement.children || [];
      const firstText = pChildren[0];
      if (!firstText || firstText.type !== 'text') return;

      const match = firstText.value.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\r?\n?/i);
      if (!match) return;

      const type = match[1].toLowerCase();
      firstText.value = firstText.value.slice(match[0].length);
      // remove empty leading text, and a following <br> that remark-gfm inserts
      if (firstText.value === '') pChildren.shift();
      if (pChildren[0]?.type === 'element' && pChildren[0].tagName === 'br') pChildren.shift();

      const titleText = type.charAt(0).toUpperCase() + type.slice(1);
      node.tagName = 'div';
      node.properties = {
        ...(node.properties || {}),
        className: ['md-alert', `md-alert-${type}`],
      };
      node.children = [
        {
          type: 'element',
          tagName: 'div',
          properties: { className: ['md-alert-title'] },
          children: [
            { type: 'element', tagName: 'span', properties: { className: ['md-alert-icon'] }, children: [] },
            { type: 'text', value: titleText },
          ],
        },
        ...node.children,
      ];
    });
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * remark 插件: 把 yaml/toml frontmatter 节点转成 styled code block
 * ═══════════════════════════════════════════════════════════════════ */

function remarkFrontmatterToBlock() {
  return (tree: any) => {
    visit(tree, (node: any) => {
      if (node.type === 'yaml' || node.type === 'toml') {
        node.type = 'code';
        node.lang = node.type === 'toml' ? 'toml' : 'yaml';
        node.meta = 'frontmatter';
        node.value = node.value;
      }
    });
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * Theme detection — look at :root[data-theme]
 * ═══════════════════════════════════════════════════════════════════ */

const detectIsDark = (): boolean => {
  const t = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null;
  if (t === 'light') return false;
  if (t === 'dark') return true;
  if (typeof matchMedia !== 'undefined') return matchMedia('(prefers-color-scheme: dark)').matches;
  return true;
};

const useIsDark = (): boolean => {
  const [isDark, setIsDark] = useState(detectIsDark);
  useEffect(() => {
    const el = document.documentElement;
    const update = () => setIsDark(detectIsDark());
    const mo = new MutationObserver(update);
    mo.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', update);
    return () => {
      mo.disconnect();
      mq.removeEventListener?.('change', update);
    };
  }, []);
  return isDark;
};

/* ═══════════════════════════════════════════════════════════════════
 * Shiki 懒加载 singleton
 * ═══════════════════════════════════════════════════════════════════ */

/* highlighter 本体搬到 ./shikiHighlighter —— Git 面板的 diff 也要用同一个单例,
 * 而它 import 不动这个模块 (remark/rehype 一整套)。这里只留 re-export 给老调用点。 */
export { SHIKI_LANGS, getShiki, LANG_ALIASES, resolveShikiLang } from './shikiHighlighter';
import type { ShikiToken } from './shikiHighlighter';
import { highlightInWorker } from './shikiWorkerClient';
import { getNeoxMermaid, normalizeMermaidSource } from './mermaidTheme';
import { absoluteToAssetUrl } from '../../shared/assetUrlPath';

/* ═══════════════════════════════════════════════════════════════════
 * Code block — 带行号 + 行选择 + copy, 支持 Shiki 高亮
 * ═══════════════════════════════════════════════════════════════════ */

const CodeBlock: React.FC<{ language?: string; children: string; isDark: boolean; frontmatter?: boolean }> = ({ language, children, isDark, frontmatter }) => {
  const { isZh } = useI18n();
  const [selectedLines, setSelectedLines] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  /* tokens 连同分词时的源码行一起存: 流式时 children 一直在长, 新高亮落地前旧 tokens 只能用在
   * 内容没变的行上 —— 按下标硬套会把最后那行 (还在长) 显示成旧文本。 */
  const [highlighted, setHighlighted] = useState<{ tokens: ShikiToken[][]; source: string[] } | null>(null);
  /* worker 里在途的那一次 + 它忙时到达的最新一版 (只留最新, 中间版本直接丢) */
  const highlightInFlightRef = useRef(false);
  const highlightQueuedRef = useRef<{ source: string; language?: string; theme: 'github-dark' | 'github-light' } | null>(null);
  const unmountedRef = useRef(false);
  /* 挂载时显式置回 false: StrictMode 开发态会模拟一次卸载再挂载 */
  useEffect(() => {
    unmountedRef.current = false;
    return () => { unmountedRef.current = true; };
  }, []);
  const lines = useMemo(() => children.replace(/\n$/, '').split('\n'), [children]);

  // IntersectionObserver 按需高亮 —— 仅 code block 进入视口才跑 Shiki WASM,
  // 避免滚动 timeline 时撞到同步 codeToTokens 长任务.
  // 一旦高亮过就保持 visible=true,离开视口不重置,避免反复 parse.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (isVisible) return;
    const el = containerRef.current;
    if (!el) return;
    // 如果浏览器不支持 IO (极罕见),直接标记可见,退回到旧行为
    if (typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setIsVisible(true);
            io.disconnect();
            break;
          }
        }
      },
      { rootMargin: '200px 0px' }, // 提前 200px 触发,滚进来前就开始准备
    );
    io.observe(el);
    return () => io.disconnect();
  }, [isVisible]);

  const requestHighlight = useCallback((job: { source: string; language?: string; theme: 'github-dark' | 'github-light' }) => {
    if (highlightInFlightRef.current) {
      highlightQueuedRef.current = job;
      return;
    }
    highlightInFlightRef.current = true;
    void highlightInWorker(job.source, job.language, job.theme).then((tokens) => {
      highlightInFlightRef.current = false;
      if (unmountedRef.current) return;
      if (tokens) setHighlighted({ tokens, source: job.source.split('\n') });
      const queued = highlightQueuedRef.current;
      highlightQueuedRef.current = null;
      if (queued) requestHighlight(queued);
    });
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    requestHighlight({ source: children.replace(/\n$/, ''), language, theme: isDark ? 'github-dark' : 'github-light' });
  }, [isVisible, children, language, isDark, requestHighlight]);

  const handleLineClick = useCallback((lineIdx: number, e: React.MouseEvent) => {
    setSelectedLines(prev => {
      const next = new Set(e.shiftKey ? prev : []);
      if (e.shiftKey && prev.size > 0) {
        const anchor = Math.min(...prev);
        const [lo, hi] = lineIdx >= anchor ? [anchor, lineIdx] : [lineIdx, anchor];
        for (let i = lo; i <= hi; i++) next.add(i);
      } else if (prev.has(lineIdx) && !e.shiftKey) {
        return new Set();
      } else {
        next.add(lineIdx);
      }
      return next;
    });
  }, []);

  const copyTimerRef = useRef<number | null>(null);
  const handleCopy = useCallback(async () => {
    const text = selectedLines.size > 0
      ? [...selectedLines].sort((a, b) => a - b).map(i => lines[i]).join('\n')
      : children;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      dispatchHint(
        isZh ? '复制失败 —— 剪贴板权限被拒或窗口未聚焦, 请重试' : 'Copy failed — clipboard was denied or the window isn’t focused. Try again.',
        'warning',
      );
      console.warn('[Markdown] clipboard write failed:', err);
      return;   /* 没写进去就别打勾 */
    }
    setCopied(true);
    /* 切换文件 / 多次复制时清掉旧 timer, 避免累积. */
    if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = null;
    }, 1500);
  }, [selectedLines, lines, children]);
  useEffect(() => () => {
    if (copyTimerRef.current != null) clearTimeout(copyTimerRef.current);
  }, []);

  const displayLang = frontmatter ? 'frontmatter' : language;

  const plainSnippet = !displayLang && lines.length <= 3;

  return (
    <div
      ref={containerRef}
      className={`md-code-block ${frontmatter ? 'md-code-frontmatter' : ''} ${plainSnippet ? 'md-code-block--plain' : ''}`}
      /* 少于 4 行 → 不画行号槽 (替代 `.md-code-block:not(:has(.md-code-line:nth-child(4)))`) */
      data-code-lines={lines.length < 4 ? 'few' : undefined}
    >
      <div className="md-code-header">
        {displayLang && <span className="md-code-lang">{displayLang}</span>}
        <span className="md-code-info">
          {selectedLines.size > 0 && (
            <span className="md-code-selected">{selectedLines.size} {selectedLines.size === 1 ? 'line' : 'lines'}</span>
          )}
          <button className="md-code-copy" onClick={() => { void handleCopy(); }}>
            {copied ? '✓' : 'Copy'}
          </button>
        </span>
      </div>
      <pre className={language ? `language-${language}` : ''}>
        <code>
          {lines.map((line, i) => {
            const tokens = highlighted && highlighted.source[i] === line ? highlighted.tokens[i] : undefined;
            return (
              <div
                key={i}
                className={`md-code-line ${selectedLines.has(i) ? 'selected' : ''}`}
                onClick={(e) => handleLineClick(i, e)}
              >
                <span className="md-code-linenum">{i + 1}</span>
                <span className="md-code-linetext">
                  {tokens && tokens.length > 0 ? (
                    tokens.map((tok, j) => (
                      <span
                        key={j}
                        style={{
                          color: tok.color,
                          fontStyle: tok.fontStyle === 1 ? 'italic' : undefined,
                          fontWeight: tok.fontStyle === 2 ? 'bold' : undefined,
                        }}
                      >
                        {tok.content}
                      </span>
                    ))
                  ) : (line || ' ')}
                </span>
              </div>
            );
          })}
        </code>
      </pre>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════
 * Mermaid block — 懒加载 mermaid 包, 每个 block 独立渲染
 * ═══════════════════════════════════════════════════════════════════ */


/* normalizeMermaidSource 定义在 mermaidTheme.ts —— 纯字符串函数, timeline 与 Surface 两条
 * 渲染路径共用。这里保留一个再导出, 既有 import (含单测) 不用改。 */
export { normalizeMermaidSource };

const getMermaid = getNeoxMermaid;

let mermaidIdCounter = 0;

const MERMAID_CACHE = new Map<string, string>();
const MERMAID_CACHE_MAX = 80;
/** 流式期 code 每 chunk 都在变, 稳定这么久才真渲染 —— 别把 mermaid 当逐帧渲染器用。 */
const MERMAID_SETTLE_MS = 220;

const MermaidBlock: React.FC<{ code: string; isDark: boolean }> = ({ code, isDark }) => {
  const { isZh: mzZh } = useI18n();
  const cacheKey = `${isDark ? 'd' : 'l'}|${code}`;
  /* 初值直接读缓存: 同一张图 (重挂 / 回滚 / 切会话再回来) 首帧即终态, 零位移 */
  const [svg, setSvg] = useState<string | null>(() => MERMAID_CACHE.get(cacheKey) ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const idRef = useRef(`mermaid-${++mermaidIdCounter}`);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoomed(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomed]);

  useEffect(() => {
    const hit = MERMAID_CACHE.get(cacheKey);
    if (hit) { setSvg(hit); setErr(null); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      (async () => {
        try {
          const mermaid = await getMermaid(isDark);
          if (cancelled) return;
          const { svg: rendered } = await mermaid.render(idRef.current + '-' + Date.now(), normalizeMermaidSource(code));
          if (cancelled) return;
          if (MERMAID_CACHE.size >= MERMAID_CACHE_MAX) {
            /* 有界: 丢最早插入的一批, Map 迭代顺序即插入顺序 */
            const drop = Math.ceil(MERMAID_CACHE_MAX / 4);
            let i = 0;
            for (const k of MERMAID_CACHE.keys()) { if (i++ >= drop) break; MERMAID_CACHE.delete(k); }
          }
          MERMAID_CACHE.set(cacheKey, rendered);
          setSvg(rendered);
          setErr(null);
        } catch (error: any) {
          if (!cancelled) setErr(String(error?.message || error));
          /* 刻意不 setSvg(null): 保留上一张图, 出错时高度不塌 (塌了就是一次抖动) */
        }
      })();
    }, MERMAID_SETTLE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [cacheKey, code, isDark]);

  /* 已有图就先显示图 —— 哪怕这一版语法出错 (流式打到一半的图必然语法不全)。
   * 原顺序是 err 优先, 于是流式期每来一个语法不完整的中间态就把图换成错误块,
   * 高度一塌一撑 = 一次抖动。等语法完整了自然会渲染出新图覆盖。 */
  if (svg) {
    return (
      <>
        <div
          className="md-mermaid md-mermaid--clickable"
          role="button"
          tabIndex={0}
          title={mzZh ? '点击放大' : 'Click to enlarge'}
          onClick={() => setZoomed(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setZoomed(true); } }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        {zoomed && createPortal(
          <div className="md-image-lightbox md-mermaid-lightbox" onClick={() => setZoomed(false)}>
            <div className="md-mermaid-lightbox__stage" dangerouslySetInnerHTML={{ __html: svg }} />
          </div>,
          interactionDoc().body,
        )}
      </>
    );
  }
  if (err) {
    return (
      <div className="md-mermaid md-mermaid-error">
        <div className="md-mermaid-error-title">Mermaid error</div>
        <pre className="md-mermaid-error-msg">{err}</pre>
        <pre className="md-mermaid-error-src">{code}</pre>
      </div>
    );
  }
  return <div className="md-mermaid md-mermaid-loading">Rendering diagram…</div>;
};

/* ═══════════════════════════════════════════════════════════════════
 * Image — click to zoom, broken-image fallback
 *   主路径: <img src="neox-asset://..."> 由 Electron 协议处理
 *   onError 兜底: 解出本地路径, 通过 IPC 读 data URL 重试一次
 * ═══════════════════════════════════════════════════════════════════ */

/** 从 neox-asset://local/<abs> 还原出本地绝对路径. */
const extractLocalPathFromAssetUrl = (url: string | undefined): string | undefined => {
  if (!url || !url.startsWith('neox-asset://local')) return undefined;
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
};

const SHORT_CELL_WIDTH = 14;
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[⺀-￯]/.test(ch) ? 2 : 1;
  return w;
}
export function pickShortColumns(rows: string[][], limit = SHORT_CELL_WIDTH): boolean[] {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const short = Array.from({ length: cols }, (_, i) =>
    rows.every((r) => displayWidth((r[i] ?? '').trim()) <= limit));
  return short.some((s) => !s) ? short : short.map(() => false);
}
function markShortColumns(table: HTMLTableElement | null): void {
  if (!table) return;
  const rows = Array.from(table.rows);
  const flags = pickShortColumns(rows.map((r) => Array.from(r.cells).map((c) => c.textContent ?? '')));
  /* 列数 ≥6 才退回横滚 —— 替代 `table:has(tr > :nth-child(6))` (滚动期 :has 祖先重算, work:M-03) */
  const columnCount = rows.reduce((max, r) => Math.max(max, r.cells.length), 0);
  if (columnCount >= 6) table.setAttribute('data-cols-wide', '');
  else table.removeAttribute('data-cols-wide');
  for (const r of rows) {
    Array.from(r.cells).forEach((c, i) => {
      if (flags[i]) c.setAttribute('data-nowrap', '');
      else c.removeAttribute('data-nowrap');
      /* 纯文本单元格 (不含行内 code) —— 替代 `td:not(:has(code)):not(:has(.md-inline-code))` */
      if (c.querySelector('code, .md-inline-code')) c.removeAttribute('data-plain');
      else c.setAttribute('data-plain', '');
    });
  }
}

const MarkdownTable: React.FC<{ children?: React.ReactNode; tableProps: Record<string, unknown> }> = ({ children, tableProps }) => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<{ more: boolean; cols: number }>({ more: false, cols: 0 });

  const measure = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const slack = el.scrollWidth - el.clientWidth;
    const more = slack > 2 && el.scrollLeft < slack - 2;
    if (!more) { setState((p) => (p.more ? { more: false, cols: 0 } : p)); return; }
    /* 用某一行单元格的右边界算"还有几列没露出来" —— 比按平均列宽估要准。
     * 必须只取一行: 'tr:first-child > *' 会同时命中 thead 和 tbody 各自的首行, 列数直接翻倍。 */
    const row = el.querySelector('tr');
    const right = el.getBoundingClientRect().right;
    let n = 0;
    if (row) {
      Array.from(row.children).forEach((c) => {
        if ((c as HTMLElement).getBoundingClientRect().right > right + 1) n += 1;
      });
    }
    setState((p) => (p.more === true && p.cols === n ? p : { more: true, cols: n }));
  }, []);

  /* 监听只挂一次。表格尺寸变化 (新行进来、容器变宽) ResizeObserver 自己会报。 */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const t = el.querySelector('table');
    if (t) ro.observe(t);
    el.addEventListener('scroll', measure, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', measure); };
  }, [measure]);

  const lastMarkAtRef = useRef(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const run = () => {
      lastMarkAtRef.current = performance.now();
      markShortColumns(el.querySelector('table'));
      measure();
    };
    const wait = 250 - (performance.now() - lastMarkAtRef.current);
    if (wait <= 0) { run(); return; }
    const timer = window.setTimeout(run, wait);
    return () => window.clearTimeout(timer);
  }, [measure, children]);

  return (
    <div className="md-table-scroller">
      <CopyIconButton
        className="md-table-copy"
        label={zh ? '复制表格' : 'Copy table'}
        getText={() => { const t = wrapRef.current?.querySelector('table'); return t ? tableToClipboard(t).text : ''; }}
        getHtml={() => { const t = wrapRef.current?.querySelector('table'); return t ? tableToClipboard(t).html : ''; }}
      />
      <div ref={wrapRef} className="md-table-wrapper" data-overflow={state.more ? 'true' : undefined}>
        <table {...tableProps}>{children}</table>
      </div>
      {state.more ? (
        <span className="md-table-more" aria-hidden="true">
          {state.cols > 0
            ? (zh ? `还有 ${state.cols} 列 →` : `${state.cols} more column(s) →`)
            : (zh ? '右侧还有内容 →' : 'More to the right →')}
        </span>
      ) : null}
    </div>
  );
};

const MarkdownImage: React.FC<React.ImgHTMLAttributes<HTMLImageElement>> = ({ src, alt, ...rest }) => {
  const { isZh: imgZh } = useI18n();
  const [zoomed, setZoomed] = useState(false);
  const [error, setError] = useState(false);
  const [fallbackSrc, setFallbackSrc] = useState<string | undefined>(undefined);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'done' | 'fail'>('idle');
  const triedFallbackRef = useRef(false);

  const effectiveSrc = fallbackSrc || src;

  if (error) {
    return <span className="md-image-broken" title={`Failed to load image: ${src}`}>🖼 {alt || src}</span>;
  }

  const handleError = async () => {
    if (triedFallbackRef.current) {
      console.warn('[Markdown] image failed to load (after fallback):', src);
      setError(true);
      return;
    }
    triedFallbackRef.current = true;

    const localPath = extractLocalPathFromAssetUrl(typeof src === 'string' ? src : undefined);
    if (!localPath) {
      setError(true);
      return;
    }

    const dataUrl = await fetchDataUrlForLocalPath(localPath);
    if (dataUrl) {
      setFallbackSrc(dataUrl);
    } else {
      setError(true);
    }
  };

  /* 复制图片 —— 跟 DirectImageTurns.handleCopyImage 同一口径 (fetch → blob → ClipboardItem)。
   * 一个坑: Chromium 的异步剪贴板只接受少数类型, image/png 之外 (jpeg/webp) 直接写会抛
   * NotAllowedError。所以非 png 先过一遍 canvas 转成 png —— 否则用户点了没反应, 而
   * 控制台的报错他看不到。 */
  const copyImage = async () => {
    /* effectiveSrc 是 string | undefined —— 没有 src 时按钮本来就不该能点到,
     * 但显式挡一下比断言安全: 断言错了是运行时炸, 挡住只是不复制。 */
    if (!effectiveSrc) { setCopyState('fail'); return; }
    const src = effectiveSrc;
    setCopyState('copying');
    try {
      const blob = await (await fetch(src)).blob();
      let out = blob;
      if (blob.type !== 'image/png') {
        out = await new Promise<Blob>((resolve, reject) => {
          const im = new Image();
          im.onload = () => {
            const c = document.createElement('canvas');
            c.width = im.naturalWidth; c.height = im.naturalHeight;
            const ctx = c.getContext('2d');
            if (!ctx) return reject(new Error('no 2d context'));
            ctx.drawImage(im, 0, 0);
            c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
          };
          im.onerror = () => reject(new Error('image load failed'));
          im.src = src;
        });
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': out })]);
      setCopyState('done');
      setTimeout(() => setCopyState('idle'), 1600);
    } catch (err) {
      console.warn('[md-image] copy failed', err);
      setCopyState('fail');
      setTimeout(() => setCopyState('idle'), 1600);
    }
  };

  return (
    <>
      <img
        {...rest}
        src={effectiveSrc}
        alt={alt || ''}
        loading="lazy"
        className="md-image"
        onClick={() => setZoomed(true)}
        onError={handleError}
      />
      {zoomed && createPortal(
        /* 同上: 图片灯箱一直也被祖先的 transform 困在对话列里 */
        <div className="md-image-lightbox" onClick={() => setZoomed(false)}>
          <img src={effectiveSrc} alt={alt || ''} />
          <div className="md-lightbox__bar" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="md-lightbox__btn"
              disabled={copyState === 'copying'}
              onClick={() => { void copyImage(); }}
            >
              {copyState === 'done' ? (imgZh ? '已复制' : 'Copied')
                : copyState === 'fail' ? (imgZh ? '复制失败' : 'Copy failed')
                : (imgZh ? '复制图片' : 'Copy image')}
            </button>
            <button type="button" className="md-lightbox__btn" onClick={() => setZoomed(false)}>{imgZh ? '关闭' : 'Close'}</button>
          </div>
        </div>,
        interactionDoc().body,
      )}
    </>
  );
};

/* ═══════════════════════════════════════════════════════════════════
 * 主组件
 * ═══════════════════════════════════════════════════════════════════ */

interface MarkdownProps {
  content: string;
  className?: string;
  basePath?: string;
  workspacePath?: string;
  /** 按顶层块分别解析 + memo (流式时只重解析最后一块), 见 markdownBlocks.ts。
   *  时间线消息开; 一次性渲染的文档/报告不需要。 */
  incremental?: boolean;
}

/**
 * 把本地绝对路径异步转成 data URL. 全局共享一层缓存,避免同一张图反复读盘.
 * 失败返回 undefined.
 */
const dataUrlCache = new Map<string, string>();
const dataUrlInflight = new Map<string, Promise<string | undefined>>();

const fetchDataUrlForLocalPath = (absPath: string): Promise<string | undefined> => {
  const cached = dataUrlCache.get(absPath);
  if (cached) return Promise.resolve(cached);
  const inflight = dataUrlInflight.get(absPath);
  if (inflight) return inflight;

  const api = (window as any).neox;
  if (!api?.readFileDataUrl) return Promise.resolve(undefined);

  const promise = (async () => {
    try {
      const result = await api.readFileDataUrl(absPath);
      if (result?.success && result.dataUrl) {
        dataUrlCache.set(absPath, result.dataUrl);
        return result.dataUrl as string;
      }
    } catch (err) {
      console.warn('[Markdown] readFileDataUrl threw:', err);
    } finally {
      dataUrlInflight.delete(absPath);
    }
    return undefined;
  })();

  dataUrlInflight.set(absPath, promise);
  return promise;
};

function inferCardKind(obj: any): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (Array.isArray(obj.items) && obj.items.length > 0 && typeof obj.items[0] === 'object' && obj.items[0]) {
    const it = obj.items[0];
    if ('cuisine' in it || 'priceRange' in it || ('rating' in it && 'address' in it)) return 'restaurant';
    if ('source' in it && 'title' in it) return 'news';
    if ('text' in it && ('priority' in it || 'title' in obj)) return 'todo';
  }
  if (obj.current && obj.location) return 'weather';
  if (Array.isArray(obj.columns) && Array.isArray(obj.rows)) return 'compare';
  if (Array.isArray(obj.series) && obj.type) return 'chart';
  if (typeof obj.path === 'string' && (obj.summary || Array.isArray(obj.highlights) || Array.isArray(obj.stats))) return 'report';
  if (Array.isArray(obj.nodes) && Array.isArray(obj.edges)) return 'flow';
  if (Array.isArray(obj.files) && (obj.status || obj.stats || obj.sections)) return 'summary';
  if (Array.isArray(obj.options) && (obj.from || obj.to || obj.type)) return 'booking';
  if (typeof obj.url === 'string' && /^https?:/.test(obj.url) && !obj.items && !obj.series) return 'link';
  if (typeof obj.src === 'string' && (obj.poster || /\.(mp4|webm|mov|m3u8)(\?|$)/i.test(obj.src) || /youtube\.com|youtu\.be|bilibili\.com|vimeo\.com/i.test(obj.src))) return 'video';
  if (typeof obj.src === 'string' && (obj.caption || obj.alt || /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(obj.src))) return 'image';
  return null;
}

/** 松散版 kind 推断 — 只看关键字面量, 不要求 JSON 已闭合。
 *  给"围栏语言写成裸 ```neox"的情况兜底: 流式写到一半 JSON.parse 必然失败,
 *  若此时掉回 CodeBlock, 用户会先看见一屏裸 JSON 再"啪"地变成卡片。
 *  用签名字段直接判 kind, 从第一个 token 起就渲染成卡 (NeoxCard 自带 pending 态)。 */
function inferCardKindLoose(raw: string): string | null {
  if (!raw || raw.length < 12) return null;
  const has = (k: string) => raw.includes(`"${k}"`);
  if (has('path') && (has('summary') || has('highlights'))) return 'report';
  if (has('nodes') && has('edges')) return 'flow';
  if (has('files') && (has('status') || has('stats') || has('sections'))) return 'summary';
  if (has('series') && has('type')) return 'chart';
  if (has('columns') && has('rows')) return 'compare';
  if (has('current') && has('location')) return 'weather';
  return null;
}

/** 从 start ('{') 起按字符串感知做花括号配平, 返回闭合下标; 未闭合 -1 */
function matchBraceEnd(s: string, start: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const CARD_XML_OPEN = /<neox-card:([a-z][\w-]*)\s*>/i;

export function unwrapCardXmlTags(text: string): string {
  if (!text.includes('<neox-card:')) return text;
  let out = '';
  let rest = text;
  for (;;) {
    const m = CARD_XML_OPEN.exec(rest);
    if (!m) { out += rest; break; }
    const kind = m[1].toLowerCase();
    out += rest.slice(0, m.index);
    const afterOpen = m.index + m[0].length;
    /* 闭标签允许 kind 不一致 (模型偶尔写 </neox-card>) —— 只要是我们的闭标签就收 */
    const closeRe = new RegExp(`</neox-card(?::${kind})?\\s*>`, 'i');
    const tail = rest.slice(afterOpen);
    const cm = closeRe.exec(tail);
    const inner = cm ? tail.slice(0, cm.index) : tail;   /* 没闭合 = 流式在途, 取到目前为止 */
    /* 里面常再套一层 ```json ... ``` —— 剥掉, 卡片要的是裸 body */
    const fenced = /^\s*```[a-z]*\s*\n([\s\S]*?)\n?\s*```\s*$/i.exec(inner);
    const body = (fenced ? fenced[1] : inner).trim();
    out += body ? `\n\n\`\`\`neox-card:${kind}\n${body}\n\`\`\`\n\n` : '';
    if (!cm) break;                                       /* 流式在途: 后面没东西了 */
    rest = tail.slice(cm.index + cm[0].length);
  }
  return out;
}

function wrapBareCardJson(text: string): string {
  if (!text.includes('{"')) return text;
  const segs = text.split('```');
  for (let s = 0; s < segs.length; s += 2) {   /* 偶数段 = 围栏外 */
    const seg = segs[s];
    if (!seg.includes('{"')) continue;
    let out = '';
    let i = 0;
    for (;;) {
      const start = seg.indexOf('{"', i);
      if (start === -1) { out += seg.slice(i); break; }
      out += seg.slice(i, start);
      const end = matchBraceEnd(seg, start);
      if (end === -1) { out += seg.slice(start); break; }   /* 未闭合 (流式在途) — 原样 */
      const raw = seg.slice(start, end + 1);
      let piece = raw;
      if (raw.length >= 40) {
        try {
          const kind = inferCardKind(JSON.parse(raw));
          /* 一律补 neox-card: 前缀 —— 工作向 kind (chart/summary) 没前缀不认 */
          if (kind) piece = `\n\n\`\`\`neox-card:${kind}\n${raw}\n\`\`\`\n\n`;
        } catch { /* 不是合法 JSON — 原样 */ }
      }
      out += piece;
      i = end + 1;
    }
    segs[s] = out;
  }
  return segs.join('```');
}

/* 按块渲染时的一块: 文本 / 插件 / 组件表都没变就整块跳过 (不重解析、不重建子树) */
const MarkdownBlock = React.memo(function MarkdownBlock({ text, remarkPlugins, rehypePlugins, components }: {
  text: string;
  remarkPlugins: any;
  rehypePlugins: any;
  components: Components;
}) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} urlTransform={markdownUrlTransform}>
      {text}
    </ReactMarkdown>
  );
});

const Markdown: React.FC<MarkdownProps> = ({ content, className, basePath, workspacePath, incremental = false }) => {
  const { isZh: mdZh } = useI18n();
  const { isWork } = useAgentModeVariant();
  const isDark = useIsDark();
  const containerRef = useRef<HTMLDivElement | null>(null);

  const lastInsetSettleAtRef = useRef(0);
  React.useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    if (!el.querySelector('.ncard-wrap')) return;
    let raf = 0;
    let timer = 0;
    const run = () => {
      raf = 0;
      lastInsetSettleAtRef.current = performance.now();
      try { settleOrphanInsets(el); } catch { /* 量布局失败不影响渲染 */ }
    };
    const schedule = () => {
      if (raf || timer) return;
      const wait = 200 - (performance.now() - lastInsetSettleAtRef.current);
      if (wait <= 0) raf = requestAnimationFrame(run);
      else timer = window.setTimeout(() => { timer = 0; raf = requestAnimationFrame(run); }, wait);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    for (const w of Array.from(el.querySelectorAll('.ncard-wrap'))) ro.observe(w);
    schedule();
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); if (timer) window.clearTimeout(timer); };
  }, [content]);

  // Preprocess:
  // 1. normalize LLM-style headings without space after #
  // 2. 把 raw HTML <img src="相对路径"> 改写成 neox-asset:// URL. 这样
  //    rehype-raw 解析后 properties.src 就已经是绝对 URL, 走 protocol handler.
  const normalizedContent = useMemo(() => {
    if (!content) return '';
    //    markdown(表格/标题)结构散成一坨裸文本。先把 \r\n 与单独 \r 全压成 \n。
    let result = content.replace(/\r\n?/g, '\n');
    // 1. normalize LLM-style headings without space after #
    result = result.replace(/^(#{1,6})(?=[^\s#])/gm, '$1 ');
    result = normalizeLooseLists(result);
    // 1.4 富卡被写成 XML 标签 (<neox-card:diff>…</neox-card:diff>) → 归一回围栏。
    //     JSON 通常已经被模型套进 ```json 围栏里了。
    result = unwrapCardXmlTags(result);
    // 1.5 裸卡 JSON 自愈: 模型漏写围栏的富卡 JSON → 推断 kind 补围栏进卡片渲染
    result = wrapBareCardJson(result);
    // 1.6 公式写法归一: 行内 $…$ / \(…\) / 单行 $$…$$ / \[…\], 公式里的 % 补转义。
    result = normalizeMath(result);

    if (basePath) {
      result = result.replace(
        /<img\b([^>]*?)\ssrc\s*=\s*(["'])([^"']+)\2([^>]*?)>/gi,
        (match, pre: string, quote: string, src: string, post: string) => {
          const resolved = resolveMarkdownUrl(src, basePath, workspacePath);
          if (!resolved || resolved === src) return match;
          return `<img${pre} src=${quote}${resolved}${quote}${post}>`;
        },
      );
    }

    /* 2. 白名单外的"标签形状"转成字面量。必须放在 <img> 改写之后 (img 在白名单里, 前后都不受影响),
     *    但一定要在 rehype-raw 之前 —— 否则模型正文里的 <timestamp>/<your-key>/Map<string, T>
     *    会被当成真元素解析, 那段字面量在界面上直接消失。 */
    result = escapeUnknownHtmlTags(result);

    return result;
  }, [content, basePath, workspacePath]);

  const remarkPlugins = useMemo(
    () => [
      [remarkFrontmatter, ['yaml', 'toml']] as any,
      remarkFrontmatterToBlock,
      [remarkGfm, markdownGfmOptions] as any,   /* singleTilde:false —— 单个 ~ 只是字符, 不是删除线 (见 utils/markdownGfm.ts) */
      /* 只认 $$…$$, 关掉单 $ 行内公式。
       * 单 $ 在聊天里常是钱: "FLAT50 = 固定 $50, FREESHIP = 固定 $12" 会被当成一段
       * 行内公式吃掉 —— 两个 $ 消失, 中间的正文被渲成数学斜体 (𝐹𝑅𝐸𝐸𝑆𝐻𝐼𝑃)。
       * 像公式的单 $…$ 和 \(…\) 由 normalizeMath 预先改写成 $$…$$。 */
      [remarkMath, { singleDollarTextMath: false }] as any,
      remarkSoftBreaks,   /* 段内单换行 = 真换行。聊天场景标配, 放在 gfm 之后 */
    ],
    [],
  );

  const rehypePlugins = useMemo(
    () => [
      rehypeRaw,
      [rehypeRewriteLocalLinks, { basePath, workspacePath }] as any,
      rehypeGithubAlerts,
      rehypeStatusMarks,
      rehypeSlug,
      [rehypeAutolinkHeadings, {
        behavior: 'wrap',
        properties: { className: ['md-heading-link'] },
      }] as any,
      [rehypeKatex, { strict: false, output: 'htmlAndMathml' }] as any,
    ],
    [basePath, workspacePath],
  );

  const components: Components = useMemo(
    () => ({
      code({ node, className: codeClassName, children, ...props }) {
        const match = /language-([\w:+.-]+)/.exec(codeClassName || '');
        const text = String(children);
        const isInline = !match && !text.includes('\n');

        if (isInline) {
          const rawText = text.trim();
          const open = () => window.dispatchEvent(new CustomEvent('neox:open-path', { detail: { path: rawText } }));
          if (isWork && isPreviewablePath(rawText)) {
            const base = rawText.split(/[/\\]/).pop() || rawText;
            return (
              <span
                className="md-file-chip"
                role="button"
                tabIndex={0}
                title={mdZh ? `点击打开 · ${rawText}` : `Open · ${rawText}`}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
              >
                <FileTypeIcon path={rawText} size={16} />
                <span className="md-file-chip__name">{base}</span>
                <span className="md-file-chip__open">{mdZh ? '打开' : 'Open'}</span>
              </span>
            );
          }
          if (isPreviewablePath(rawText)) {
            return (
              <code
                className="md-inline-code md-inline-code--clickable"
                role="button"
                tabIndex={0}
                title={mdZh ? `点击打开: ${rawText}` : `Open: ${rawText}`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  window.dispatchEvent(new CustomEvent('neox:open-path', { detail: { path: rawText } }));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    window.dispatchEvent(new CustomEvent('neox:open-path', { detail: { path: rawText } }));
                  }
                }}
                {...props}
              >{children}</code>
            );
          }
          return <code className="md-inline-code" {...props}>{children}</code>;
        }

        const language = match?.[1];
        if (language === 'mermaid') {
          return <MermaidBlock code={text.replace(/\n$/, '')} isDark={isDark} />;
        }
        if (typeof language === 'string') {
          const langLower = language.toLowerCase();
          const hasPrefix = langLower.startsWith('neox-card:');
          const stripped = langLower.replace(/^neox-card:/, '');
          /* Life 场景卡 — kind 名不跟任何真实语言撞车, 裸写也认 */
          const LIFE_KINDS = ['restaurant', 'weather', 'todo', 'compare', 'news', 'booking', 'recipe', 'tracking', 'trip', 'product', 'gallery'];
          const WORK_KINDS = ['summary', 'chart', 'metrics', 'steps', 'callout', 'table', 'diff',
            'report', 'flow', 'timeline',
            'link', 'image', 'video', 'embed'];
          if (LIFE_KINDS.includes(stripped) || (hasPrefix && WORK_KINDS.includes(stripped))) {
            return <NeoxCard kind={stripped === 'embed' ? 'link' : stripped} body={text} />;
          }
          if (hasPrefix && (CHART_SUBTYPES as readonly string[]).includes(stripped)) {
            return <NeoxCard kind={stripped} body={text} />;
          }
          /* 带了 neox-card: 前缀但种类名没见过 —— 前缀已经说明「这是张卡」, 跟丢了后缀一样按内容反推 */
          if (stripped === 'neox' || stripped === 'neox-card' || stripped === 'neoxcard' || hasPrefix) {
            const body = text.trim();
            let kind: string | null = null;
            try { kind = inferCardKind(JSON.parse(body)); } catch { /* 流式未闭合 — 走松散判断 */ }
            if (!kind) kind = inferCardKindLoose(body);
            if (kind) return <NeoxCard kind={kind} body={text} />;
          }
        }

        // Detect frontmatter-tagged code block (from remarkFrontmatterToBlock)
        const nodeData: any = (node as any)?.data;
        const isFrontmatter = nodeData?.meta === 'frontmatter' || (node as any)?.meta === 'frontmatter';

        return <CodeBlock language={language} isDark={isDark} frontmatter={isFrontmatter}>{text}</CodeBlock>;
      },
      a({ node: _node, href, children, ...props }) {
        const storeHit = typeof href === 'string' ? PLUGIN_STORE_LINK.exec(href) : null;
        if (storeHit) {
          const name = storeHit[1];
          return (
            <a
              href={href}
              className="md-plugin-link"
              onClick={(e) => { e.preventDefault(); openPluginInStore(name); }}
            >
              {children}
            </a>
          );
        }
        const isExternal = typeof href === 'string' && /^https?:/.test(href);
        return (
          <a
            href={href}
            {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            {...props}
          >
            {children}
          </a>
        );
      },
      img({ node: _node, src, alt, ...props }) {
        return <MarkdownImage src={src as string | undefined} alt={alt} {...props} />;
      },
      table({ node: _node, children, ...props }) {
        return <MarkdownTable tableProps={props}>{children}</MarkdownTable>;
      },
      blockquote({ node: _node, children, ...props }) {
        return <blockquote className="md-blockquote" {...props}>{children}</blockquote>;
      },
      ul({ node: _node, children, ...props }) {
        return <ul className="md-list md-ul" {...props}>{children}</ul>;
      },
      ol({ node: _node, children, start, ...props }) {
        const startNum = Number(start);
        const startVal = Number.isFinite(startNum) ? startNum : 1;
        const itemCount = React.Children.toArray(children).filter(React.isValidElement).length;
        const maxMarker = startVal + Math.max(itemCount, 1) - 1;
        const slotEm = maxMarker >= 100 ? '2.4em' : maxMarker >= 10 ? '1.9em' : '1.4em';
        return (
          <ol
            className="md-list md-ol"
            start={startVal}
            style={{
              ['--md-ol-start' as string]: startVal - 1,
              ['--md-ol-slot' as string]: slotEm,
            } as React.CSSProperties}
            {...props}
          >
            {children}
          </ol>
        );
      },
      h1({ node: _node, children, ...props }) { return <h1 className="md-heading md-h1" {...props}>{children}</h1>; },
      h2({ node: _node, children, ...props }) { return <h2 className="md-heading md-h2" {...props}>{children}</h2>; },
      h3({ node: _node, children, ...props }) { return <h3 className="md-heading md-h3" {...props}>{children}</h3>; },
      h4({ node: _node, children, ...props }) { return <h4 className="md-heading md-h4" {...props}>{children}</h4>; },
      h5({ node: _node, children, ...props }) { return <h5 className="md-heading md-h5" {...props}>{children}</h5>; },
      h6({ node: _node, children, ...props }) { return <h6 className="md-heading md-h6" {...props}>{children}</h6>; },
      p({ node: _node, children, ...props }) {
        const arr = React.Children.toArray(children);
        if (arr.length === 1 && React.isValidElement(arr[0])) {
          const el = arr[0] as React.ReactElement<{ href?: string; children?: React.ReactNode }>;
          const href = typeof el.props.href === 'string' ? el.props.href : '';
          const text = React.Children.toArray(el.props.children).join('').trim();
          if (/^https?:\/\//.test(href) && (text === href || text === href.replace(/\/$/, ''))) {
            return <NeoxCard kind="link" body={JSON.stringify({ url: href })} />;
          }
        }
        return <p className="md-paragraph" {...props}>{children}</p>;
      },
      pre({ node: _node, children, ...props }) {
        const arr = React.Children.toArray(children);
        const only = arr.length === 1 && React.isValidElement(arr[0]) ? arr[0] : null;
        const cls = only ? String((only.props as { className?: string })?.className ?? '') : '';
        /* language-neox-card:chart / language-restaurant … 都算 —— 跟下面 code 里
         * 那套 kind 识别同源, 只是这里只需要知道"它会渲成卡"。 */
        const isCardFence = /(^|\s)language-(neox-card:|(?:restaurant|weather|todo|compare|news|booking|recipe|tracking|trip|product|gallery)(?:\s|$))/.test(cls);
        const isMermaidFence = /(^|\s)language-mermaid(\s|$)/.test(cls);
        if (only && (isCardFence || isMermaidFence)) return only;
        return <pre {...props}>{children}</pre>;
      },
      hr({ node: _node, ...props }) { return <hr className="md-hr" {...props} />; },
    }),
    [isDark, isWork],
  );

  const blocks = useMemo(
    () => (incremental ? splitMarkdownBlocks(normalizedContent) : null),
    [incremental, normalizedContent],
  );

  const headBlocks = blocks && blocks.length > 1 ? blocks.slice(0, -1) : null;
  const headKeyTrackerRef = useRef<HeadKeyTracker | null>(null);
  const headKey = headBlocks
    ? (headKeyTrackerRef.current ??= createHeadKeyTracker()).update(headBlocks)
    : '';
  const headEls = useMemo(
    () => headBlocks?.map((text, i) => (
      /* 块之间补回整条解析时会有的 "\n" 文本节点 —— 离线渲染台逐字比过, 不补就差这 N-1 个换行 */
      <React.Fragment key={i}>
        {i > 0 ? '\n' : null}
        <MarkdownBlock text={text} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} />
      </React.Fragment>
    )) ?? null,
    /* 依赖故意用 headKey 而不是 headBlocks —— 后者每帧都是新数组, 用它等于没缓存。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [headKey, remarkPlugins, rehypePlugins, components],
  );
  const tailIndex = blocks ? blocks.length - 1 : -1;

  return (
    <div ref={containerRef} className={`markdown-content ${className || ''}`}>
      {blocks ? (
        <>
          {headEls}
          <React.Fragment key={tailIndex}>
            {tailIndex > 0 ? '\n' : null}
            <MarkdownBlock text={blocks[tailIndex]} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} />
          </React.Fragment>
        </>
      ) : (
        <ReactMarkdown
          remarkPlugins={remarkPlugins as any}
          rehypePlugins={rehypePlugins as any}
          components={components}
          urlTransform={markdownUrlTransform}
        >
          {normalizedContent}
        </ReactMarkdown>
      )}
    </div>
  );
};

export default React.memo(Markdown);
