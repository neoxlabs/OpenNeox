import React, { useCallback, useState } from 'react';
import type { DiffLine } from '../types';
import { langOf, tokenizeLineCached, type SyntaxLang } from './syntaxTokens';
import { useI18n, defaultIsZh } from '../../../hooks/useI18n';

/* ---------- diff ----------
 * 时间线只承担“快速扫读 + Review 入口”，不是完整代码编辑器。
 * 流式写入时限制预览行数，避免 write_file 每个 token 都重排上百行；
 * 完成后的最大高度和滚动由 CSS 统一控制。 */
const STREAMING_DIFF_INLINE_LINE_LIMIT = 72;
const STREAMING_DIFF_PREVIEW_LINE_LIMIT = 48;

const DiffStreamingPreview: React.FC<{
  lines: DiffLine[];
  hiddenCount: number;
}> = ({ lines, hiddenCount }) => {
  const { isZh } = useI18n();
  return (
    <div className="atl-diff atl-diff-preview is-streaming">
      <div className="atl-diff-preview__notice">
        {isZh ? `正在编辑 · 实时预览最后 ${lines.length} 行` : `Editing · live preview of the last ${lines.length} lines`}
        {hiddenCount > 0 && (
          <span>
            {isZh
              ? ` · 已临时收起前面 ${hiddenCount} 行，完成后显示完整 diff`
              : ` · ${hiddenCount} earlier lines temporarily hidden; full diff shows when done`}
          </span>
        )}
      </div>
      <div className="atl-diff__pane atl-diff__pane--new" aria-label={isZh ? '实时 diff 预览' : 'Live diff preview'}>
        {lines.map((l, i) => renderDiffLine(l, diffLineKey(l, i, 'new'), 'new', i === lines.length - 1))}
      </div>
    </div>
  );
};

export const WRITE_PREVIEW_LINES = 12;
export const WRITE_EXPAND_STEP = 200;

export function previewSlice(lines: DiffLine[], shown: number): DiffLine[] {
  if (lines.length <= shown) return lines;
  const head = lines.slice(0, shown);
  head.push({ kind: 'more', text: '', newNo: lines.length - shown } as DiffLine);
  return head;
}

export function spliceContext(lines: DiffLine[], fileLines: string[], pad: number): DiffLine[] | null {
  const out: DiffLine[] = [];
  const GAP_MIN = 3;
  const pushGap = (fromIdx: number, toIdx: number) => {
    if (toIdx < fromIdx) return;
    if (toIdx - fromIdx + 1 < GAP_MIN) {
      for (let i = fromIdx; i <= toIdx; i++) out.push({ kind: 'ctx', text: fileLines[i]!, oldNo: i + 1, newNo: i + 1 });
      return;
    }
    out.push({ kind: 'gap', text: '', oldNo: fromIdx + 1, newNo: toIdx + 1 } as DiffLine);
  };
  let cursor = 0;      /* 文件里已经消费到第几行 (0-based) */
  let matchedAny = false;
  const blocks: DiffLine[][] = [];
  let cur: DiffLine[] = [];
  for (const l of lines) {
    if (l.kind === 'hunk') { if (cur.length) blocks.push(cur); cur = []; continue; }
    cur.push(l);
  }
  if (cur.length) blocks.push(cur);
  if (!blocks.length) return null;

  for (const block of blocks) {
    const adds = block.filter((l) => l.kind === 'add').map((l) => l.text);
    /* 锚点: 新增行在文件里的位置 */
    let at = -1;
    if (adds.length) {
      for (let i = cursor; i + adds.length <= fileLines.length; i++) {
        let ok = true;
        for (let j = 0; j < adds.length; j++) { if (fileLines[i + j] !== adds[j]) { ok = false; break; } }
        if (ok) { at = i; break; }
      }
    }
    if (at < 0) { out.push(...block); continue; }
    matchedAny = true;
    const from = Math.max(cursor, at - pad);
    /* 跳过的那一段折成一条可点的带子 */
    pushGap(cursor, from - 1);
    for (let i = from; i < at; i++) out.push({ kind: 'ctx', text: fileLines[i]!, oldNo: i + 1, newNo: i + 1 });
    out.push(...block);
    const tail = Math.min(fileLines.length, at + adds.length + pad);
    for (let i = at + adds.length; i < tail; i++) out.push({ kind: 'ctx', text: fileLines[i]!, oldNo: i + 1, newNo: i + 1 });
    cursor = tail;
  }
  if (!matchedAny) return null;
  pushGap(cursor, fileLines.length - 1);
  return out;
}

export const DiffView: React.FC<{
  lines: DiffLine[];
  isWriteOnly: boolean;  // 纯 add (write_file) 时不画"旧代码"空面板
  streaming?: boolean;   // LLM 还在流式生成 args 时, 最后一行末尾加跳动光标
  file?: string;         // 有路径才能去读全文补上下文
  workspacePath?: string;
}> = ({ lines, isWriteOnly, streaming = false, file, workspacePath }) => {
  const { isZh } = useI18n();
  const [withContext, setWithContext] = useState<DiffLine[] | null>(null);
  const [writeShown, setWriteShown] = useState(WRITE_PREVIEW_LINES);
  const [loading, setLoading] = useState(false);
  const [ctxError, setCtxError] = useState<string | null>(null);
  /* 只对"有路径 + 有真实增删"的 diff 提供展开 —— write_file 的全 add 卡本来就是完整内容 */
  const canExpand = !!file && !isWriteOnly && !streaming && lines.some((l) => l.kind === 'add');
  const loadContext = useCallback(async (pad: number) => {
    if (!file || loading) return;
    setLoading(true);
    setCtxError(null);
    try {
      const api = (window as any).neox;
      const reader = api?.surfaceReadFile ?? api?.readFile;
      if (!reader) { setCtxError(isZh ? '当前环境不支持读取文件' : 'File reading unavailable here'); return; }
      const res = await reader(file, workspacePath ? { workspacePath } : undefined);
      const text = res?.success === false
        ? ''
        : (typeof res === 'string' ? res : (res?.content ?? ''));
      if (!text) {
        setCtxError(isZh ? '读不到这个文件（可能已被移动或删除）' : 'Cannot read this file (moved or deleted?)');
        return;
      }
      const spliced = spliceContext(dropLeadingHunk(lines), String(text).split('\n'), pad);
      if (spliced) setWithContext(spliced);
      else setCtxError(isZh ? '文件已和这次改动对不上了' : 'File no longer matches this change');
    } catch {
      /* 读不到就维持只显示改动行 —— 不猜内容, 但要让用户知道点击是有反应的 */
      setCtxError(isZh ? '读不到这个文件（可能已被移动或删除）' : 'Cannot read this file (moved or deleted?)');
    }
    finally { setLoading(false); }
  }, [file, workspacePath, lines, loading, isZh]);

  if (streaming && lines.length > STREAMING_DIFF_INLINE_LINE_LIMIT) {
    const previewLines = lines.slice(-STREAMING_DIFF_PREVIEW_LINE_LIMIT);
    return (
      <DiffStreamingPreview
        lines={previewLines}
        hiddenCount={Math.max(0, lines.length - previewLines.length)}
      />
    );
  }

  if (isWriteOnly) {
    /* 流式写入期间不收起 —— 那会儿用户就是在看它一行行长出来 */
    const all = dropLeadingHunk(lines);
    const rows = streaming ? all : previewSlice(all, writeShown);
    return (
      <div className={`atl-diff${streaming ? ' is-streaming' : ''}`}>
        <div className="atl-diff__pane atl-diff__pane--new" aria-label={isZh ? '新代码' : 'New code'}>
          {rows.map((l, i, arr) => renderDiffLine(
            l, diffLineKey(l, i, 'new'), 'new', streaming && i === arr.length - 1,
            () => setWriteShown((n) => n + WRITE_EXPAND_STEP), isZh, langOf(file),
          ))}
        </div>
      </div>
    );
  }
  const unified = withContext ?? dropLeadingHunk(lines);
  const lang = langOf(file);
  return (
    <div className={`atl-diff is-unified${streaming ? ' is-streaming' : ''}`}>
      <div className="atl-diff__pane atl-diff__pane--unified">
        {canExpand && !withContext && (
          <button
            type="button"
            className="atl-diff__row is-gap"
            onClick={(e) => { e.stopPropagation(); void loadContext(3); }}
            title={isZh ? '读取文件, 显示改动周围的代码' : 'Read the file and show surrounding code'}
          >
            <span className={`atl-diff__gaptext${ctxError ? ' is-error' : ''}`}>
              {loading
                ? (isZh ? '读取中…' : 'Loading…')
                : (ctxError ?? (isZh ? '显示上下文' : 'Show context'))}
            </span>
          </button>
        )}
        {unified.map((l, i) => renderDiffLine(
          l,
          diffLineKey(l, i, l.kind === 'del' ? 'old' : 'new'),
          /* 行号取自己那一侧: 删除行给旧行号, 新增/上下文给新行号 */
          l.kind === 'del' ? 'old' : 'new',
          streaming && i === unified.length - 1,
          () => { void loadContext(9999); },
          isZh,
          lang,
        ))}
      </div>
    </div>
  );
};

/** 把 DiffLine[] 抽成 Monaco decoration 用的 {start,end,kind} 区间数组.
 *   只取新文件存在的行 (add 有 newNo, ctx 也有 newNo 但不需要高亮, del 跳过).
 *   连续的 add 行号合并成一段 — 一次改动通常多行连一片, 单独高亮反而闪. */
export function diffLinesToChangedRanges(
  lines: DiffLine[]
): Array<{ start: number; end: number; kind: 'add' | 'del' | 'modify' }> {
  const out: Array<{ start: number; end: number; kind: 'add' | 'del' | 'modify' }> = [];
  let cur: { start: number; end: number } | null = null;
  for (const l of lines) {
    if (l.kind !== 'add' || typeof l.newNo !== 'number') {
      if (cur) { out.push({ ...cur, kind: 'add' }); cur = null; }
      continue;
    }
    if (cur && l.newNo === cur.end + 1) {
      cur.end = l.newNo;
    } else {
      if (cur) out.push({ ...cur, kind: 'add' });
      cur = { start: l.newNo, end: l.newNo };
    }
  }
  if (cur) out.push({ ...cur, kind: 'add' });
  return out;
}

function diffLineKey(l: DiffLine, index: number, side: 'old' | 'new'): React.Key {
  if (l.kind === 'hunk') return `${side}:hunk:${l.text}:${index}`;
  const no = side === 'old' ? l.oldNo : l.newNo;
  if (typeof no === 'number') return `${side}:${l.kind}:${no}`;
  return `${side}:${l.kind}:${index}:${l.text.slice(0, 48)}`;
}

function dropLeadingHunk(lines: DiffLine[]): DiffLine[] {
  const first = lines.findIndex((l) => l.kind !== 'hunk');
  if (first <= 0) return lines;
  return lines.slice(first);
}

function renderDiffLine(
  l: DiffLine,
  key: React.Key,
  side: 'old' | 'new',
  withCursor: boolean,
  onExpandGap?: (l: DiffLine) => void,
  zh = defaultIsZh(),
  lang: SyntaxLang = 'plain',
) {
  if (l.kind === 'more') {
    const n = l.newNo ?? 0;
    return (
      <button
        key={key}
        type="button"
        className="atl-diff__row is-gap is-more"
        onClick={(e) => { e.stopPropagation(); onExpandGap?.(l); }}
        title={zh ? '点击继续显示后面的行' : 'Click to reveal more lines'}
      >
        <span className="atl-diff__gaptext">{zh ? `还有 ${n} 行` : `${n} more lines`}</span>
      </button>
    );
  }
  if (l.kind === 'gap') {
    const n = Math.max(0, (l.newNo ?? 0) - (l.oldNo ?? 0) + 1);
    return (
      <button
        key={key}
        type="button"
        className="atl-diff__row is-gap"
        onClick={(e) => { e.stopPropagation(); onExpandGap?.(l); }}
        title={zh ? '点击展开这段未改动的代码' : 'Click to reveal these unchanged lines'}
      >
        <span className="atl-diff__gaptext">{zh ? `${n} 行未改动` : `${n} unmodified lines`}</span>
      </button>
    );
  }
  if (l.kind === 'hunk') {
    /* @@ -N +N @@ unified-diff hunk header — 用户视角是噪声 (gutter 行号本身已经传达
     * "这块从第几行开始"). 渲染成一根极细的横向分隔 + 行号小 chip, 不再贴原 unified diff
     * 语法. 多 hunk 之间靠这条断开, 单 hunk 时几乎不可见 (头部那条直接淡到几乎透明). */
    const match = l.text.match(/^@@\s+-(\d+).*?\+(\d+)/);
    const lineNo = match ? Number(side === 'old' ? match[1] : match[2]) : null;
    return (
      <div key={key} className="atl-diff__row is-hunk" aria-hidden="true">
        <span className="atl-diff__hunkbar" />
        {lineNo != null && <span className="atl-diff__hunkno">@ {lineNo}</span>}
      </div>
    );
  }
  const cls =
    l.kind === 'add' ? 'is-add' :
    l.kind === 'del' ? 'is-del' : 'is-ctx';
  const sign =
    l.kind === 'add' ? '+' :
    l.kind === 'del' ? '−' : ' ';
  const no = side === 'old' ? l.oldNo : l.newNo;
  return (
    <div key={key} className={`atl-diff__row ${cls}`}>
      <span className="atl-diff__gutter">{no ?? ''}</span>
      <span className="atl-diff__sign">{sign}</span>
      <span className="atl-diff__code">
        {lang === 'plain'
          ? l.text
          : tokenizeLineCached(l.text, lang).map((tk, ti) => (
              tk.k === 'txt'
                ? tk.t
                : <span key={ti} className={`tk-${tk.k}`}>{tk.t}</span>
            ))}
        {withCursor && <span className="atl-diff__cursor" aria-hidden="true" />}
      </span>
    </div>
  );
}
