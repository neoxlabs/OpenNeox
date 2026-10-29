/**
 * CodePreviewPane — 就地渲染当前源码的可视化预览.
 *
 * 跟 markdown preview 一个思路: 不换 surface, 不开 tab, 就在 CodeSurfaceViewer
 * 的第 4 档 "Render" 里换成对应的渲染器. 支持类型看 getPreviewKind().
 *
 * 加类型:
 *   1. 在 getPreviewKind 里加扩展名 → 类型的映射
 *   2. 在 renderPreview 里加 case
 */

import React, { useMemo } from 'react';
import Markdown from '../../../components/Markdown';

export type PreviewKind = 'html' | 'markdown' | 'svg' | 'json' | 'csv' | 'mermaid';

/** 只挑那些 "换成可视化以后信息量更高" 的类型. 纯代码 (ts/py/go/...) 没预览意义. */
export function getPreviewKind(path: string): PreviewKind | null {
  const ext = (path.split(/[/\\?#]/).pop() || '').split('.').pop()?.toLowerCase();
  if (!ext) return null;
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return 'markdown';
  if (ext === 'svg') return 'svg';
  if (ext === 'json' || ext === 'jsonc' || ext === 'json5') return 'json';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'mmd' || ext === 'mermaid') return 'mermaid';
  return null;
}

interface Props {
  kind: PreviewKind;
  path: string;
  content: string;
  workspacePath?: string;
  isZh: boolean;
}

export const CodePreviewPane: React.FC<Props> = ({ kind, path, content, workspacePath, isZh }) => {
  if (!content) {
    return (
      <div className="sfc-empty">
        <div className="sfc-empty__title">{isZh ? '内容为空' : 'Nothing to render yet'}</div>
      </div>
    );
  }
  switch (kind) {
    case 'html':
      return <HtmlPreview content={content} path={path} />;
    case 'markdown':
      return <MarkdownPreview content={content} path={path} workspacePath={workspacePath} />;
    case 'svg':
      return <SvgPreview content={content} path={path} />;
    case 'json':
      return <JsonPreview content={content} isZh={isZh} />;
    case 'csv':
      return <CsvPreview content={content} path={path} isZh={isZh} />;
    case 'mermaid':
      return <MermaidPreview content={content} workspacePath={workspacePath} />;
    default:
      return null;
  }
};

/* ─────────────────────────────────────────────────────────────
 * HTML — iframe sandbox srcDoc
 * ───────────────────────────────────────────────────────────── */
const HtmlPreview: React.FC<{ content: string; path: string }> = ({ content, path }) => (
  <iframe
    key={`html-render-${path}-${content.length}`}
    className="sfc-code sfc-code--render sfc-code--render-html"
    style={{ width: '100%', height: '100%', flex: '1 1 auto', minWidth: 0, minHeight: 0, border: 0, background: '#fff' }}
    title={path.split(/[/\\]/).pop() || 'HTML preview'}
    srcDoc={content}
        sandbox="allow-scripts allow-forms allow-popups"
    referrerPolicy="no-referrer"
  />
);

/* ─────────────────────────────────────────────────────────────
 * Markdown — 复用 Markdown 组件 (GFM / mermaid / katex 全带)
 * ───────────────────────────────────────────────────────────── */
const MarkdownPreview: React.FC<{ content: string; path: string; workspacePath?: string }> = ({
  content, path, workspacePath,
}) => (
  <div className="sfc-code sfc-code--render sfc-code--render-markdown">
    <div className="sfc-code__render-scroll">
      <Markdown content={content} basePath={path} workspacePath={workspacePath} />
    </div>
  </div>
);

const SvgPreview: React.FC<{ content: string; path: string }> = ({ content, path }) => (
  <div
    className="sfc-code sfc-code--render sfc-code--render-svg"
    style={{
      width: '100%', height: '100%', flex: '1 1 auto', minWidth: 0, minHeight: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'auto', padding: 24,
    }}
  >
    <img
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`}
      alt={path.split('/').pop() || 'SVG'}
      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
      draggable={false}
    />
  </div>
);

/* ─────────────────────────────────────────────────────────────
 * JSON — parse + pretty print. 解析失败退回原文 + 顶部错误提示.
 * ───────────────────────────────────────────────────────────── */
const JsonPreview: React.FC<{ content: string; isZh: boolean }> = ({ content, isZh }) => {
  const { pretty, err } = useMemo(() => {
    try {
      /* 允许 jsonc/json5 的尾逗号 + 注释, 但不搞完整 parser — 尽力式清理. 失败就原样显示. */
      const cleaned = content
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,(\s*[}\]])/g, '$1');
      const parsed = JSON.parse(cleaned);
      return { pretty: JSON.stringify(parsed, null, 2), err: null as string | null };
    } catch (e: any) {
      return { pretty: content, err: (e?.message as string) || String(e) };
    }
  }, [content]);
  return (
    <div className="sfc-code sfc-code--render sfc-code--render-json">
      {err && (
        <div className="sfc-code__render-note">
          {isZh ? 'JSON 解析失败，展示原文: ' : 'JSON parse failed, showing raw content: '}
          {err}
        </div>
      )}
      <pre className="sfc-code__render-pre">{pretty}</pre>
    </div>
  );
};

/* ─────────────────────────────────────────────────────────────
 * CSV / TSV — 解析为 table. 简易 parser (处理引号 + 引号内换行).
 * ───────────────────────────────────────────────────────────── */
function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += ch;
      }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

const CsvPreview: React.FC<{ content: string; path: string; isZh: boolean }> = ({ content, path, isZh }) => {
  const isTsv = /\.tsv$/i.test(path);
  const rows = useMemo(() => parseCsv(content, isTsv ? '\t' : ','), [content, isTsv]);
  const [header, ...body] = rows;
  return (
    <div className="sfc-code sfc-code--render sfc-code--render-csv">
      <div className="sfc-code__render-scroll sfc-code__render-scroll--table">
        <table className="sfc-code__render-table">
          {header && (
            <thead>
              <tr>{header.map((cell, i) => <th key={i}>{cell}</th>)}</tr>
            </thead>
          )}
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sfc-code__render-note sfc-code__render-note--footer">
        {isZh
          ? `${body.length} 行 · ${header?.length ?? 0} 列`
          : `${body.length} row${body.length === 1 ? '' : 's'} · ${header?.length ?? 0} column${(header?.length ?? 0) === 1 ? '' : 's'}`}
      </div>
    </div>
  );
};

/* ─────────────────────────────────────────────────────────────
 * Mermaid — 走 Markdown 组件的 ```mermaid fence 渲染.
 * ───────────────────────────────────────────────────────────── */
const MermaidPreview: React.FC<{ content: string; workspacePath?: string }> = ({ content, workspacePath }) => {
  const wrapped = `\`\`\`mermaid\n${content}\n\`\`\`\n`;
  return (
    <div className="sfc-code sfc-code--render sfc-code--render-mermaid">
      <div className="sfc-code__render-scroll">
        <Markdown content={wrapped} workspacePath={workspacePath} />
      </div>
    </div>
  );
};

export default CodePreviewPane;
